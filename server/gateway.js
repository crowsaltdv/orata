// Orate — realtime gateway: presence, voice rooms and WebRTC signalling over WebSocket.
import { WebSocketServer } from 'ws';
import { db, sha, conns, gatedConns, send, emitTo, canView, audienceOf, publicUser, broadcastPresence, newId, can, voice, effectiveStatus } from './core.js';
import { buildReady } from './api.js';
import { isGated } from './verify.js';

const offlineTimers = new Map();

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
      send(conn, 'voice_left', { channelId, reason });
    };

    function joinVoice(d) {
      const ch = db.channels[d.channelId];
      if (!ch || !canView(conn.userId, ch)) return send(conn, 'error', { message: 'Unknown channel' });
      if (ch.serverId) {
        if (ch.type !== 'voice') return send(conn, 'error', { message: 'Not a voice channel' });
        if (!can(db.servers[ch.serverId], conn.userId, 'CONNECT')) return send(conn, 'error', { message: 'You can’t join this channel' });
      } else if (!['dm', 'group'].includes(ch.type)) return;
      // one voice connection per user across all tabs
      for (const c of conns.get(conn.userId) || []) if (c.voice && c !== conn) c.leaveVoice?.('moved');
      if (conn.voice) conn.leaveVoice('moved');
      let room = voice.get(ch.id); const wasEmpty = !room || !room.size;
      if (!room) { room = new Map(); voice.set(ch.id, room); }
      const peers = [...room.values()].map((s) => s.userId);
      const state = { userId: conn.userId, channelId: ch.id, muted: !!d.muted, deafened: !!d.deafened, video: !!d.video, screen: false, joinedAt: Date.now() };
      room.set(conn.userId, state);
      conn.voice = ch.id;
      send(conn, 'voice_joined', { channelId: ch.id, peers, states: [...room.values()] });
      broadcastVoice(ch.id, conn.userId, state);
      if (!ch.serverId && wasEmpty) emitTo(ch.recipients.filter((id) => id !== conn.userId), 'call_ring', { channelId: ch.id, from: conn.userId, users: [publicUser(db.users[conn.userId])] });
    }

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const { op, d = {} } = msg || {};
      if (!conn.userId) {
        if (op !== 'identify') return;
        const s = db.sessions[sha(String(d.token || ''))];
        const user = s && db.users[s.userId];
        if (!user || user.deleted) { send(conn, 'invalid_session', {}); return ws.close(4004, 'invalid token'); }   // the message too: some proxies swallow custom close codes
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
        case 'idle': { const v = !!d.idle; if (conn.idle !== v) { conn.idle = v; broadcastPresence(conn.userId); } break; }
        case 'voice_join': joinVoice(d); break;
        case 'voice_leave': conn.leaveVoice('left'); break;
        case 'voice_update': {
          if (!conn.voice) break;
          const st = voice.get(conn.voice)?.get(conn.userId); if (!st) break;
          for (const k of ['muted', 'deafened', 'video', 'screen']) if (typeof d[k] === 'boolean') st[k] = d[k];
          broadcastVoice(conn.voice, conn.userId, st);
          break;
        }
        case 'voice_signal': {
          if (!conn.voice || !voice.get(conn.voice)?.has(String(d.to))) break;
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
      if (set && !set.size) {
        conns.delete(conn.userId);
        // short grace period so a page reload doesn't flash the user offline
        const uid = conn.userId;
        offlineTimers.set(uid, setTimeout(() => { offlineTimers.delete(uid); if (!conns.has(uid)) broadcastPresence(uid); }, 2500));
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

// expire timed custom statuses
setInterval(() => {
  const now = Date.now();
  for (const u of Object.values(db.users)) {
    if (u.customStatus?.expiresAt && u.customStatus.expiresAt < now) { u.customStatus = null; broadcastPresence(u.id); emitTo([u.id], 'self_update', { user: { ...publicUser(u), customStatus: null } }); }
  }
}, 30_000).unref();
export { effectiveStatus };
