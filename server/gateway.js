// Orata — realtime gateway: presence, voice rooms (voice channels, calls and stages) and WebRTC signalling over WebSocket.
import { WebSocketServer } from 'ws';
import { db, sha, conns, gatedConns, send, emitTo, canView, audienceOf, publicUser, broadcastPresence, newId, canIn, voice, effectiveStatus, save, serverView, serverAudience } from './core.js';
import { buildReady } from './api.js';
import { findSession } from './sessions.js';
import { accountBlock } from './staff.js';
import { expireListening } from './music.js';
import { isGated } from './verify.js';
import { isStage, isVoiceLike, isStageMod, stageJoinState, peersFor, mayLink, setSpeaker, setHand } from './stage.js';
import { partyOp, partyLeft, partyView } from './party.js';

const offlineTimers = new Map();

/** Who is looking at a channel right now (the faces above the message box): a tab with it open (in front or not), not idle, not invisible. Sent to each of them.
 *  ponytail: walks every connection on each change; keep a per-channel index if that ever shows up in a profile. */
function sendViewers(channelId) {
  const ids = new Set(); const to = [];
  for (const set of conns.values()) for (const c of set) if (c.viewing === channelId) { to.push(c); if (!c.idle && db.users[c.userId]?.status !== 'invisible') ids.add(c.userId); }
  const users = [...ids].map((id) => publicUser(db.users[id]));
  for (const c of to) send(c, 'viewers', { channelId, users });
}

export function attachGateway(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/gateway')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const conn = { id: newId(), ws, userId: null, idle: false, voice: null, alive: true };
    const authTimer = setTimeout(() => ws.close(4003, 'auth timeout'), 10_000);
    ws.on('pong', () => { conn.alive = true; });

    function broadcastVoice(channelId, userId, state) {
      const ch = db.channels[channelId]; if (!ch) return;
      emitTo(audienceOf(ch), 'voice_state_update', { channelId, userId, state });
    }
    conn.leaveVoice = (reason = 'left') => {
      const channelId = conn.voice; if (!channelId) return;
      conn.voice = null;
      const room = voice.get(channelId);
      if (room) {
        room.delete(conn.userId);
        // tell remaining peers to tear down their link with this user
        for (const st of room.values()) for (const c of conns.get(st.userId) || []) if (c.voice === channelId) send(c, 'voice_peer_left', { channelId, userId: conn.userId });
        if (!room.size) {
          voice.delete(channelId);
          const ch = db.channels[channelId];
          if (ch && !ch.serverId) emitTo(ch.recipients, 'call_end', { channelId });
        }
      }
      broadcastVoice(channelId, conn.userId, null);
      partyLeft(channelId, conn.userId);   // the host leaving ends the watch party
      send(conn, 'voice_left', { channelId, reason });
    };

    function joinVoice(d) {
      const ch = db.channels[d.channelId];
      if (!ch || !canView(conn.userId, ch)) return send(conn, 'error', { message: 'Unknown channel' });
      if (ch.serverId) {
        if (!isVoiceLike(ch)) return send(conn, 'error', { message: 'Not a voice channel' });
        if (!canIn(conn.userId, ch, 'CONNECT')) return send(conn, 'error', { message: 'You can’t join this channel' });
      } else if (!['dm', 'group'].includes(ch.type)) return;
      // one voice connection per user across all tabs
      for (const c of conns.get(conn.userId) || []) if (c.voice && c !== conn) c.leaveVoice?.('moved');
      if (conn.voice) conn.leaveVoice('moved');
      let room = voice.get(ch.id); const wasEmpty = !room || !room.size;
      if (!room) { room = new Map(); voice.set(ch.id, room); }
      let state = { userId: conn.userId, channelId: ch.id, muted: !!d.muted, deafened: !!d.deafened, video: !!d.video, screen: false, joinedAt: Date.now() };
      if (isStage(ch)) state = stageJoinState(ch, conn.userId, room, state);   // the audience starts muted and without video; the first moderator opens the stage
      const peers = peersFor(ch, room, state);
      room.set(conn.userId, state);
      conn.voice = ch.id;
      send(conn, 'voice_joined', { channelId: ch.id, peers, states: [...room.values()], party: partyView(ch.id) });   // party: what the call is watching together, if anything
      broadcastVoice(ch.id, conn.userId, state);
      if (!ch.serverId && wasEmpty) emitTo(ch.recipients.filter((id) => id !== conn.userId), 'call_ring', { channelId: ch.id, from: conn.userId, users: [publicUser(db.users[conn.userId])] });
    }

    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const { op, d = {} } = msg || {};
      if (!conn.userId) {
        if (op !== 'identify' || conn.identifying) return;
        conn.identifying = true;
        const found = await findSession(String(d.token || '')).catch(() => null);
        const user = found && db.users[found.rec.userId];
        if (!user || user.deleted || accountBlock(user)) { send(conn, 'invalid_session', {}); return ws.close(4004, 'invalid token'); }   // the message too: some proxies swallow custom close codes
        if (ws.readyState !== 1) return;   // the tab went away while we looked the session up
        clearTimeout(authTimer);
        conn.userId = user.id;
        if (isGated(user)) {   // REQUIRE_EMAIL_VERIFICATION: an empty world, no events, no voice
          conn.gated = true;
          let g = gatedConns.get(user.id); if (!g) gatedConns.set(user.id, (g = new Set()));
          g.add(conn);
          send(conn, 'ready', { ...buildReady(user), connId: conn.id });
          return;
        }
        let set = conns.get(user.id); if (!set) conns.set(user.id, (set = new Set()));
        const first = set.size === 0;
        set.add(conn);
        clearTimeout(offlineTimers.get(user.id)); offlineTimers.delete(user.id);
        send(conn, 'ready', { ...buildReady(user), connId: conn.id });
        if (first || user.status) broadcastPresence(user.id);
        return;
      }
      if (conn.gated) { if (op === 'ping') send(conn, 'pong', { t: d.t }); return; }
      switch (op) {
        case 'ping': send(conn, 'pong', { t: d.t }); break;
        case 'idle': { const v = !!d.idle; if (conn.idle !== v) { conn.idle = v; broadcastPresence(conn.userId); if (conn.viewing) sendViewers(conn.viewing); } break; }
        case 'view': {   // the channel this tab shows (null: none)
          const ch = d.channelId ? db.channels[String(d.channelId)] : null;
          const next = ch && canView(conn.userId, ch) ? ch.id : null; const prev = conn.viewing || null;
          if (next === prev) break;
          conn.viewing = next;
          if (prev) sendViewers(prev);
          if (next) sendViewers(next);
          break;
        }
        case 'voice_join': joinVoice(d); break;
        case 'voice_leave': conn.leaveVoice('left'); break;
        case 'voice_update': {
          if (!conn.voice) break;
          const st = voice.get(conn.voice)?.get(conn.userId); if (!st) break;
          const ch = db.channels[conn.voice];
          for (const k of ['muted', 'deafened', 'video', 'screen']) if (typeof d[k] === 'boolean') st[k] = d[k];
          if (isStage(ch)) {
            if (!st.speaker) { st.muted = true; st.video = false; st.screen = false; }   // only speakers talk or show anything
            if (typeof d.hand === 'boolean') { setHand(ch, conn.userId, d.hand); break; }   // (broadcasts by itself)
          }
          broadcastVoice(conn.voice, conn.userId, st);
          break;
        }
        case 'stage_speaker': {   // a moderator invites someone up (or sends them back); anybody may step down themselves
          const ch = conn.voice && db.channels[conn.voice]; if (!isStage(ch)) break;
          const target = String(d.userId || conn.userId); const on = !!d.speaker;
          if ((on || target !== conn.userId) && !isStageMod(conn.userId, ch)) { send(conn, 'error', { message: 'Only stage moderators can do that' }); break; }
          const err = setSpeaker(ch, target, on); if (err) send(conn, 'error', { message: err });
          break;
        }
        case 'party_start': case 'party_stop': case 'party_add': case 'party_remove': case 'party_move': case 'party_play_now': case 'party_skip': case 'party_control': case 'party_grant': case 'party_ended': case 'party_unplayable': case 'party_react':
          partyOp(conn, op, d).catch((e) => console.error('[party]', op, e));   // watching together in a call (party.js)
          break;
        case 'voice_signal': {
          if (!conn.voice || !voice.get(conn.voice)?.has(String(d.to))) break;
          if (!mayLink(db.channels[conn.voice], voice.get(conn.voice), conn.userId, String(d.to))) break;   // on a stage two listeners never connect to each other
          for (const c of conns.get(String(d.to)) || []) if (c.voice === conn.voice) send(c, 'voice_signal', { from: conn.userId, channelId: conn.voice, signal: d.signal });
          break;
        }
        case 'call_decline': {
          const ch = db.channels[d.channelId]; if (!ch || !canView(conn.userId, ch)) break;
          emitTo([conn.userId], 'call_end', { channelId: ch.id, declined: true }); break;
        }
        default: break;
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!conn.userId) return;
      if (conn.gated) { const g = gatedConns.get(conn.userId); g?.delete(conn); if (g && !g.size) gatedConns.delete(conn.userId); return; }
      conn.leaveVoice?.('disconnected');
      const set = conns.get(conn.userId);
      set?.delete(conn);
      if (conn.viewing) sendViewers(conn.viewing);
      if (set && !set.size) {
        conns.delete(conn.userId);
        // short grace period so a page reload doesn't flash the user offline
        const uid = conn.userId;
        offlineTimers.set(uid, setTimeout(() => {
          offlineTimers.delete(uid);
          if (conns.has(uid)) return;
          const u = db.users[uid]; if (u?.listening) { u.listening = null; save(); }   // closing the last tab stops the music, so the status goes too
          broadcastPresence(uid);
        }, 2500));
      } else if (set) broadcastPresence(conn.userId);
    });
    ws.on('error', () => {});
    conn._ws = ws;
  });

  // protocol-level keepalive
  const iv = setInterval(() => {
    for (const set of [...conns.values(), ...gatedConns.values()]) for (const c of set) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false; try { c.ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);
  iv.unref();
  return wss;
}

// expire timed custom statuses (and "listening to" statuses of tracks that must have ended) and finished timeouts
setInterval(() => {
  const now = Date.now();
  expireListening();
  for (const s of Object.values(db.servers)) {
    let changed = false;
    for (const m of Object.values(s.members)) if (m.timeoutUntil && m.timeoutUntil <= now) { delete m.timeoutUntil; changed = true; }
    if (changed) { save(); for (const uid of serverAudience(s)) emitTo([uid], 'server_update', { server: serverView(s, uid) }); }
  }
  for (const u of Object.values(db.users)) {
    if (u.customStatus?.expiresAt && u.customStatus.expiresAt < now) { u.customStatus = null; broadcastPresence(u.id); emitTo([u.id], 'self_update', { user: { ...publicUser(u), customStatus: null } }); }
  }
}, 30_000).unref();
export { effectiveStatus };
