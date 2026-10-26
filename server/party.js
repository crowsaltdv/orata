// Orata — watching together in a call. Whoever presses "Watch Together" first becomes the host; everybody in the call then sees the same video at the same moment.
//
// The server keeps one party per call (a voice channel, or a DM or group call): the video now playing, the queue behind it, and where the video is — a position in seconds
// that was true at a moment in time, whether it is playing and at what speed. That is enough for every browser to work out where the video is *now*, so nothing has to be
// sent while it plays: only when somebody pauses, jumps, changes the speed, adds a video and so on. Each browser then keeps its own player on that position (public/js/party.js).
// The host and the people the host allows can choose videos and control playback; everybody else just watches. When the host leaves the call, the party ends.
import { voice, conns, send, db, newId } from './core.js';
import { isStage } from './stage.js';
import { videoMeta, watchEnabled } from './watch.js';

const parties = new Map();   // channelId → party
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const REACTIONS = ['👍', '😂', '😮', '❤️', '🔥', '👏', '😢'];
export const MAX_QUEUE = 50;

const posOf = (p) => (p.playing ? p.pos + ((Date.now() - p.at) / 1000) * p.rate : p.pos);
const clampPos = (p, pos) => Math.max(0, Math.min(pos, p.current?.seconds > 0 ? p.current.seconds : Infinity));
const can = (p, uid) => uid === p.hostId || p.controllers.has(uid);
/**
 * What the browsers get: the party as it is right now (the position is the one at this very moment). The queue is the longest part, so a state that doesn't change it leaves it out
 * (`full` false): browsers keep the queue they have. Anybody joining, and anybody whose control was refused, gets it all.
 */
const view = (p, full = true) => p && ({ channelId: p.channelId, hostId: p.hostId, controllers: [...p.controllers], current: p.current, queue: full ? p.queue : undefined, playing: p.playing, pos: clampPos(p, posOf(p)), rate: p.rate, rev: p.rev, last: p.last });
export const partyView = (channelId) => view(parties.get(channelId)) ?? null;

/** Everybody in the call (every tab of theirs that is in it). */
function tell(p, op, d) {
  for (const uid of voice.get(p.channelId)?.keys() || []) for (const c of conns.get(uid) || []) if (c.voice === p.channelId) send(c, op, d);
}
/** Sends the new state to the call. `last`: what just happened and who did it, shown to everybody for a moment ("Sam skipped to 12:30"). */
function emit(p, last = null) {
  p.rev++; p.last = last && { ...last, at: Date.now() };
  const full = p.sentQueue !== p.queueRev; p.sentQueue = p.queueRev;   // has the queue changed since the last thing we sent?
  tell(p, 'party_state', { channelId: p.channelId, party: view(p, full) });
  schedule(p);
}
/** If nobody says the video ended (every browser is busy, or has the tab asleep), the server moves on a few seconds after it should have. */
function schedule(p) {
  clearTimeout(p.timer);
  const cur = p.current; if (!p.playing || !cur?.seconds) return;
  const wait = Math.max(0, (cur.seconds - posOf(p)) / p.rate) * 1000 + 5000;
  p.timer = setTimeout(() => { if (parties.get(p.channelId) === p && p.current?.key === cur.key && p.playing) { next(p); emit(p, { by: null, act: 'next' }); } }, wait);
  p.timer.unref?.();
}
function setCurrent(p, item) { p.current = item; p.pos = 0; p.at = Date.now(); p.playing = !!item; p.rate = 1; }
function next(p) { if (p.queue.length) p.queueRev++; setCurrent(p, p.queue.shift() || null); }
function end(p) {
  clearTimeout(p.timer); parties.delete(p.channelId);
  tell(p, 'party_state', { channelId: p.channelId, party: null });
}
const entry = (meta, addedBy) => ({ key: newId(), id: meta.id, title: meta.title, channel: meta.channel?.name || (typeof meta.channel === 'string' ? meta.channel : ''), thumbnail: meta.thumbnail, seconds: Math.max(0, Math.round(meta.seconds || 0)), live: !!meta.live, addedBy });

/** Somebody left the call (or its last person did): the host leaving ends the party, anybody else just loses what the host allowed them. */
export function partyLeft(channelId, userId) {
  const p = parties.get(channelId); if (!p) return;
  const room = voice.get(channelId);
  if (userId === p.hostId || !room?.size) return end(p);
  if (p.controllers.delete(userId)) emit(p);
}

/** One of the ops a browser sends (party_start, party_add ...). It must be in the call; the host and the people they allow may do everything but end the party and hand out that right. */
export async function partyOp(conn, op, d = {}) {
  const channelId = conn.voice; const uid = conn.userId;
  const room = channelId && voice.get(channelId); const ch = channelId && db.channels[channelId];
  if (!room?.has(uid) || !ch) return;
  const no = (message) => send(conn, 'error', { message, party: true });
  if (isStage(ch)) return no('Watching together isn’t available on a stage.');
  const bucket = (conn.partyBucket ||= { n: 0, reset: 0 }); const now = Date.now();
  if (now > bucket.reset) { bucket.n = 0; bucket.reset = now + 10_000; }
  if (++bucket.n > 100) return no('Slow down a little.');
  let p = parties.get(channelId);

  if (op === 'party_start') {
    if (p) return send(conn, 'party_state', { channelId, party: view(p) });   // already going: you just join in
    if (!watchEnabled()) return no('Watch is turned off on this server.');
    p = { channelId, hostId: uid, controllers: new Set(), current: null, queue: [], queueRev: 0, sentQueue: -1, playing: false, pos: 0, at: now, rev: 0, rate: 1, last: null, timer: null };
    parties.set(channelId, p); emit(p, { by: uid, act: 'start' });
    return d.videoId ? partyOp(conn, 'party_add', { videoId: d.videoId }) : undefined;
  }
  if (!p) return no('Nobody is watching together right now.');
  if (op === 'party_react') { if (REACTIONS.includes(d.emoji)) tell(p, 'party_react', { channelId, userId: uid, emoji: d.emoji }); return undefined; }
  if (op === 'party_ended') {   // a browser says the video reached its end
    const cur = p.current;
    if (cur && cur.key === String(d.key) && p.playing && (!cur.seconds || posOf(p) >= cur.seconds * 0.9)) { next(p); emit(p, { by: null, act: 'next' }); }
    return undefined;
  }
  if (op === 'party_stop') { if (uid !== p.hostId) return no('Only the host can end this.'); end(p); return undefined; }
  if (op === 'party_grant') {
    if (uid !== p.hostId) return no('Only the host can choose who controls the video.');
    const target = String(d.userId); const on = d.on === true;
    if (target === p.hostId || !room.has(target) || on === p.controllers.has(target)) return undefined;
    if (on) p.controllers.add(target); else p.controllers.delete(target);
    emit(p, { by: uid, act: on ? 'grant' : 'revoke', arg: target }); return undefined;
  }
  if (!can(p, uid)) { send(conn, 'party_state', { channelId, party: view(p) }); return no('Only the host and the people they allow can do that.'); }   // (a screen that guessed the result gets the real state back)

  const by = uid; const cur = p.current;
  switch (op) {
    case 'party_add': {   // one at a time, so videos land in the queue in the order they were asked for (looking one up can take a moment)
      const job = (p.adding || Promise.resolve()).then(async () => {
        let meta;
        try { meta = await videoMeta(String(d.videoId || '')); } catch (e) { return no(e?.status === 400 ? 'That isn’t a video.' : 'That video isn’t available right now.'); }
        if (parties.get(channelId) !== p || !can(p, uid) || !voice.get(channelId)?.has(uid)) return undefined;   // things changed while we looked it up
        if (p.current && p.queue.length >= MAX_QUEUE && d.now !== true) return no(`The queue is full (${MAX_QUEUE} videos).`);
        const item = entry(meta, uid);
        if (d.now === true || !p.current) { setCurrent(p, item); emit(p, { by, act: 'now', arg: item.title }); } else { p.queue.push(item); p.queueRev++; emit(p, { by, act: 'add', arg: item.title }); }
        return undefined;
      });
      p.adding = job.catch(() => {});
      return job;
    }
    case 'party_remove': { const i = p.queue.findIndex((x) => x.key === String(d.key)); if (i < 0) return undefined; const [gone] = p.queue.splice(i, 1); p.queueRev++; emit(p, { by, act: 'remove', arg: gone.title }); return undefined; }
    case 'party_move': {
      const i = p.queue.findIndex((x) => x.key === String(d.key)); const to = Math.floor(Number(d.to));
      if (i < 0 || !Number.isFinite(to) || to < 0 || to >= p.queue.length || to === i) return undefined;
      p.queue.splice(to, 0, p.queue.splice(i, 1)[0]); p.queueRev++; emit(p); return undefined;
    }
    case 'party_play_now': { const i = p.queue.findIndex((x) => x.key === String(d.key)); if (i < 0) return undefined; const [item] = p.queue.splice(i, 1); p.queueRev++; setCurrent(p, item); emit(p, { by, act: 'now', arg: item.title }); return undefined; }
    case 'party_skip': if (!cur && !p.queue.length) return undefined; next(p); emit(p, { by, act: 'skip' }); return undefined;
    case 'party_control': {
      if (!cur || cur.key !== String(d.key)) { send(conn, 'party_state', { channelId, party: view(p) }); return undefined; }   // a button for a video that has already changed: show the real state
      const action = String(d.action);
      if (action === 'play') { if (p.playing) return undefined; p.at = Date.now(); p.playing = true; emit(p, { by, act: 'play' }); }
      else if (action === 'pause') { if (!p.playing) return undefined; p.pos = clampPos(p, posOf(p)); p.at = Date.now(); p.playing = false; emit(p, { by, act: 'pause' }); }
      else if (action === 'seek') { const pos = Number(d.pos); if (!Number.isFinite(pos) || cur.live) return undefined; p.pos = clampPos(p, pos); p.at = Date.now(); emit(p, { by, act: 'seek', arg: Math.round(p.pos) }); }
      else if (action === 'rate') { const rate = Number(d.rate); if (!RATES.includes(rate) || rate === p.rate) return undefined; p.pos = clampPos(p, posOf(p)); p.at = Date.now(); p.rate = rate; emit(p, { by, act: 'rate', arg: rate }); }
      return undefined;
    }
    default: return undefined;
  }
}
