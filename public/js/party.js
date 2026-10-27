// Orata — watching together in a call (the server side is server/party.js). Pressing "Watch Together" in a call puts a big video tile in the call, like a shared screen:
// the host (whoever pressed it first) and the people the host allows pick videos for a queue and control playback; everybody else just watches, at the same moment.
// The server only says what is playing and where the video was at what time; this file keeps the browser's own YouTube player on that spot (it works out "now" itself,
// and nudges the player back whenever it drifts), and shows the tile, its controls, the queue/search/people panel and the little notes and reactions that make it social.
import { html, useState, useEffect, useRef, cx, ls } from '/js/lib.js';
import { state, set, useSel, go, goChannel, goDm, toast, getChannel } from '/js/store.js';
import { gateway, api } from '/js/api.js';
import { Icon } from '/js/icons.js';
import { Avatar, Spinner, confirmDialog } from '/js/ui.js';
import { createPlayer } from '/js/youtube-player.js';
import { music } from '/js/music.js';
import { t } from '/js/i18n.js';
import { UserName } from '/js/profile-style.js';

/* ------------------------------------------------------------------ what the call is watching */
const me = () => state.me.id;
export const canControl = (p) => !!p && (p.hostId === me() || p.controllers.includes(me()));
export const isHost = (p) => !!p && p.hostId === me();
const nowMs = () => performance.now();
/** Where the video is right now, in seconds: the position the server gave, moved on by the time that has passed since. */
export function timeOf(p) {
  if (!p?.current) return 0;
  if (!p.playing) return p.pos;
  const at = p.pos + ((nowMs() - p.recvAt) / 1000) * p.rate;
  return p.current.seconds ? Math.min(at, p.current.seconds) : at;
}
export function stamp(sec) {
  const s = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
const nameOf = (uid) => (uid === me() ? t('You') : state.users[uid]?.displayName || t('Someone'));

/** What you can ask the server to do (it checks who may). */
export const party = {
  start: (videoId) => gateway.send('party_start', videoId ? { videoId } : {}),
  stop: () => gateway.send('party_stop'),
  add: (videoId, now = false) => gateway.send('party_add', { videoId, now }),
  remove: (key) => gateway.send('party_remove', { key }),
  move: (key, to) => gateway.send('party_move', { key, to }),
  playNow: (key) => gateway.send('party_play_now', { key }),
  skip: () => gateway.send('party_skip'),
  grant: (userId, on) => gateway.send('party_grant', { userId, on }),
  react: (emoji) => gateway.send('party_react', { emoji }),
  ended: (key) => gateway.send('party_ended', { key }),
  unplayable: (key) => gateway.send('party_unplayable', { key }),
  /** play, pause, seek ({ pos }) or rate ({ rate }) for the video that is playing. It shows on this screen at once; the server then tells everybody (and sets this screen straight if it said no). */
  control(action, extra = {}) {
    const p = state.party; const key = p?.current?.key; if (!key) return;
    guess(p, action, extra);
    gateway.send('party_control', { action, key, ...extra });
  },
};
/** What the screen of whoever pressed the button shows before the server has answered: the same thing the answer will say, so the video and the line over it move at once. */
const guessed = { act: '', at: 0 };
function guess(p, action, extra) {
  const at = timeOf(p); const next = { ...p, recvAt: nowMs() };
  if (action === 'play') { if (p.playing) return; next.playing = true; next.pos = at; }
  else if (action === 'pause') { if (!p.playing) return; next.playing = false; next.pos = at; }
  else if (action === 'seek') { if (p.current.live || !Number.isFinite(extra.pos)) return; next.pos = Math.max(0, p.current.seconds ? Math.min(extra.pos, p.current.seconds) : extra.pos); }
  else if (action === 'rate') { if (!extra.rate || extra.rate === p.rate) return; next.pos = at; next.rate = extra.rate; }
  else return;
  const arg = action === 'seek' ? Math.round(next.pos) : action === 'rate' ? next.rate : undefined;
  set({ party: next });
  guessed.act = action; guessed.at = Date.now();
  for (const f of noteListeners) f(noteFor({ ...next, last: { by: me(), act: action, arg } }));
  for (const f of syncers) f(true);
}

const syncers = new Set();   // the players, told the moment a new state arrives (they also check every half second). Called with true when the video must move right now
const reactionListeners = new Set();
const noteListeners = new Set();
function apply(channelId, p, quiet = false) {
  const cur = state.party;
  if (!p) { if (cur && cur.channelId === channelId) { set({ party: null, partyPanel: false }); if (!quiet) toast(t('The watch party ended'), 'info', 3000); } return; }
  const mine = !!cur && cur.channelId === channelId;
  if (mine && p.rev < cur.rev) return;   // an older message that arrived late
  let queue = p.queue;   // a state that didn't change the queue doesn't carry it: keep ours
  if (!queue) { queue = mine ? cur.queue : []; if (!mine) gateway.send('party_start', {}); }   // (asking again for the whole thing, in the odd case we never had it)
  const same = mine && cur.current?.key === p.current?.key;
  const before = same ? timeOf(cur) : 0;
  set({ party: { ...p, queue, recvAt: nowMs() } });
  // the video has to move right now when the video changed, it was paused or resumed, the speed changed, or somebody jumped (it is not where we thought it would be)
  const jump = !same || cur.playing !== p.playing || cur.rate !== p.rate || Math.abs(before - p.pos) > 0.75;
  for (const f of syncers) f(jump);
}
gateway.on('party_state', ({ channelId, party: p }) => { if (state.voice.conn?.channelId === channelId) apply(channelId, p); });
gateway.on('voice_joined', ({ channelId, party: p }) => { if (state.voice.conn?.channelId === channelId) apply(channelId, p || null, true); });
gateway.on('voice_left', ({ channelId }) => apply(channelId, null, true));
gateway.on('party_react', (r) => { for (const f of reactionListeners) f(r); });
gateway.on('error', (d) => { if (d?.party) toast(d.message, 'error', 3500); });

/** Back to the call's own page (where the watch tile is). */
export function focusCall() {
  const c = state.voice.conn; const ch = c && getChannel(c.channelId); if (!ch) return;
  if (ch.serverId) goChannel(ch.serverId, ch.id); else goDm(ch.id);
}
/**
 * The call's "Watch Together" button: starts watching together (you become the host). While it is going the button is lit: for the host it ends the party for everyone (after asking),
 * for everybody else it takes them back to the video.
 */
export async function openParty() {
  const c = state.voice.conn; if (!c || c.status === 'connecting') return;
  if (c.stage) { go('/watch'); return; }   // a stage has no watch tile: the button opens the Watch page instead
  const p = state.party;
  if (p && p.channelId === c.channelId) {
    if (!isHost(p)) { focusCall(); return; }
    const yes = await confirmDialog({ title: t('End Watch Together?'), body: t('The video stops for everyone in the call. Anyone can start a new one.'), confirmLabel: t('End it'), danger: true });
    if (yes && state.party?.channelId === c.channelId) party.stop();
    return;
  }
  party.start(); set({ partyPanel: true }); focusCall();
}
/** The call button's name: it says what pressing it does. */
export const partyLabel = (watching, hosting) => (!watching ? t('Watch Together') : hosting ? t('End Watch Together') : t('Watching Together'));

/* ------------------------------------------------------------------ the player that stays on the same moment */
const DRIFT = 1.6;   // seconds apart before the player is moved (smaller jumps would be heard as stutter)
function usePartyPlayer(box, ctl, vol, muted, setUi) {
  const live = useRef({ vol, muted }); live.current = { vol, muted };
  useEffect(() => {
    const c = { key: null, st: -1, t: 0, tAt: 0, rate: 1, loadedAt: 0, fixAt: 0, playAt: 0, rateAt: 0, endedFor: null, blocked: false };
    const pl = createPlayer({
      onState(st) { c.st = st; const cur = state.party?.current; if (st === 0 && cur && cur.key === c.key && c.endedFor !== cur.key) { c.endedFor = cur.key; party.ended(cur.key); } },
      onTime(tm, _d, info) { c.t = tm; c.tAt = nowMs(); if (typeof info?.playbackRate === 'number') c.rate = info.playbackRate; },
      onError(code) {
        setUi((u) => ({ ...u, error: code }));
        const key = c.key;   // the video can't be shown here (removed, age-restricted, embedding off): ask the server to move on, which it does when we may skip or when YouTube agrees
        if ((code === 100 || code === 101 || code === 150) && key && c.reported !== key) { c.reported = key; setTimeout(() => { if (state.party?.current?.key === key) party.unplayable(key); }, 900); }
      },
    }, { parent: box.current, title: t('Watch Together') });
    ctl.current = { pl, c };
    const tick = (now = false) => {   // now: somebody just pressed something, so no waiting (the checks every half second only fix drift)
      const p = state.party; const cur = p?.current;
      if (!cur) { if (c.key) { pl.stop(); c.key = null; c.blocked = false; } return; }
      const goal = timeOf(p); const at = nowMs();
      if (c.key !== cur.key) {   // a new video (or the first one): start it at the right spot
        Object.assign(c, { key: cur.key, loadedAt: at, fixAt: at, playAt: at, st: -1, t: goal, tAt: at, endedFor: null, blocked: false, rate: 1 });
        setUi((u) => ({ ...u, error: null }));
        pl.load(cur.id, cur.live ? 0 : goal); pl.volume(live.current.vol); if (live.current.muted) pl.mute();
        music.pause();   // the music player and a video would talk over each other
        return;
      }
      const since = at - c.loadedAt;
      const here = c.t + (c.st === 1 ? ((at - c.tAt) / 1000) * c.rate : 0);   // where this player is
      if (p.playing) {
        if (c.st !== 1 && c.st !== 3 && c.st !== 0 && (now || (since > 1500 && at - c.playAt > 1500))) { pl.play(); c.playAt = at; }
        c.blocked = since > 5000 && c.st !== 1 && c.st !== 3 && c.st !== 0;   // the browser won't start a video nobody clicked: ask for a click
        if (!cur.live && c.st !== 0 && (now ? Math.abs(here - goal) > 0.4 : c.st === 1 && since > 2500 && at - c.fixAt > 2500 && Math.abs(here - goal) > DRIFT)) { pl.seek(goal); Object.assign(c, { fixAt: at, t: goal, tAt: at }); }
      } else {
        c.blocked = false;
        if (c.st === 1 && (now || (since > 600 && at - c.playAt > 1000))) { pl.pause(); c.playAt = at; }
        if (!cur.live && (now ? Math.abs(here - p.pos) > 0.3 : since > 1200 && c.st !== 3 && at - c.fixAt > 1500 && Math.abs(here - p.pos) > 0.8)) { pl.seek(p.pos); Object.assign(c, { fixAt: at, t: p.pos, tAt: at }); }
      }
      if (Math.abs(c.rate - p.rate) > 0.01 && (now || (since > 800 && at - c.rateAt > 1500))) { pl.rate(p.rate); c.rateAt = at; }
    };
    syncers.add(tick);
    const a = setInterval(tick, 400);
    const b = setInterval(() => setUi((u) => { const time = timeOf(state.party); return Math.abs(u.time - time) < 0.2 && u.blocked === c.blocked ? u : { ...u, time, blocked: c.blocked }; }), 250);
    tick();
    return () => { syncers.delete(tick); clearInterval(a); clearInterval(b); pl.destroy(); ctl.current = null; };
  }, []);
  useEffect(() => { const x = ctl.current; if (!x) return; x.pl.volume(vol); if (muted) x.pl.mute(); else x.pl.unmute(); }, [vol, muted]);
}

/* ------------------------------------------------------------------ the tile */
/** What the player's error code means for a person (100: gone or private; 101 and 150: not allowed on other websites, which includes age-restricted videos). */
const errorText = (code) => (code === 100 ? [t('This video isn’t available'), t('It was removed or made private.')]
  : code === 101 || code === 150 ? [t('This video can’t be played here'), t('It’s age-restricted, or its owner doesn’t allow other websites to show it. Skipping it…')]
    : [t('The video couldn’t be played'), t('Something went wrong with the player.')]);
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const EMOJI = ['👍', '😂', '😮', '❤️', '🔥', '👏', '😢'];
function noteFor(p) {
  const l = p.last; if (!l) return null;
  const who = l.by ? nameOf(l.by) : '';
  switch (l.act) {
    case 'start': return `${who} ${t('started watching together')}`;
    case 'add': return `${who} ${t('added')} “${l.arg}”`;
    case 'now': return `${who} ${t('is playing')} “${l.arg}”`;
    case 'remove': return `${who} ${t('removed')} “${l.arg}”`;
    case 'play': return `${who} ${t('resumed')}`;
    case 'pause': return `${who} ${t('paused')}`;
    case 'seek': return `${who} ${t('jumped to')} ${stamp(l.arg)}`;
    case 'rate': return `${who} ${t('set the speed to')} ${l.arg}×`;
    case 'skip': return `${who} ${t('skipped to the next video')}`;
    case 'next': return p.current ? `${t('Up next')}: “${p.current.title}”` : t('That was the last video in the queue');
    case 'blocked': return `“${l.arg}” ${t('can’t be played here, so it was skipped')}`;
    case 'grant': return `${who} ${t('let')} ${nameOf(l.arg)} ${t('control the video')}`;
    case 'revoke': return `${who} ${t('took video controls from')} ${nameOf(l.arg)}`;
    default: return null;
  }
}

export function PartyTile({ chId }) {
  const p = useSel((s) => s.party); const panel = useSel((s) => s.partyPanel);
  const users = useSel((s) => s.users); void users;
  const box = useRef(null); const tile = useRef(null); const ctl = useRef(null); const first = useRef(p.rev);
  const [ui, setUi] = useState({ time: timeOf(p), blocked: false, error: null });
  const [vol, setVol] = useState(() => ls('partyVol', 0.7)); const [muted, setMuted] = useState(false);
  const [note, setNote] = useState(null); const [floats, setFloats] = useState([]); const [full, setFull] = useState(false);
  const [menu, setMenu] = useState(null); const [drag, setDrag] = useState(null);
  const cur = p.current; const ctrl = canControl(p); const host = p.hostId;
  usePartyPlayer(box, ctl, vol, muted, setUi);
  useEffect(() => { ls('partyVol', null, vol); }, [vol]);
  useEffect(() => { const f = () => setFull(document.fullscreenElement === tile.current); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);
  useEffect(() => {   // a line over the video about what somebody just did, for a few seconds
    if (p.rev <= first.current) return undefined;
    if (p.last?.by === me() && p.last.act === guessed.act && Date.now() - guessed.at < 5000) { guessed.act = ''; return undefined; }   // you saw that one when you pressed the button
    const text = noteFor(p); if (!text) return undefined;
    setNote(text); const id = setTimeout(() => setNote(null), 4500); return () => clearTimeout(id);
  }, [p.rev]);
  useEffect(() => {
    let id = 0; const f = (text) => { if (!text) return; setNote(text); clearTimeout(id); id = setTimeout(() => setNote(null), 4500); };
    noteListeners.add(f); return () => { noteListeners.delete(f); clearTimeout(id); };
  }, []);
  // the top and bottom bars slip away a few seconds after the mouse (or a finger) stops moving over the video, and come back when it moves
  const [idle, setIdle] = useState(false); const idleAt = useRef(0); const hold = useRef(false);
  hold.current = !!menu || ui.drag !== undefined || !cur || !!ui.error || ui.blocked;   // never while a menu is open, the seek bar is being dragged, or there is a message to read
  const wake = (soon) => {
    setIdle(false); clearTimeout(idleAt.current);
    idleAt.current = setTimeout(function again() { if (hold.current || barHover.current) idleAt.current = setTimeout(again, 1000); else setIdle(true); }, soon ? 1200 : 3000);
  };
  const barHover = useRef(false);
  useEffect(() => { wake(false); return () => clearTimeout(idleAt.current); }, []);
  useEffect(() => {   // emoji floating up from the bottom when someone reacts
    const f = ({ userId, emoji }) => { const id = Math.random(); setFloats((l) => [...l.slice(-14), { id, emoji, userId, x: 8 + Math.random() * 70 }]); setTimeout(() => setFloats((l) => l.filter((x) => x.id !== id)), 3200); };
    reactionListeners.add(f); return () => reactionListeners.delete(f);
  }, []);
  const duration = cur?.seconds || 0; const shown = ui.drag ?? ui.time;
  const toggleFull = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else tile.current?.requestFullscreen?.().catch(() => {}); };
  const playPause = () => { if (ctrl && cur) party.control(p.playing ? 'pause' : 'play'); };
  const resume = () => { const x = ctl.current; if (x) { x.pl.play(); x.pl.unmute(); setMuted(false); x.c.playAt = nowMs(); } };
  const jump = (by) => { if (ctrl && cur && !cur.live) party.control('seek', { pos: Math.max(0, Math.min(duration || Infinity, timeOf(p) + by)) }); };
  const hostName = nameOf(host);

  return html`<div class=${cx('tile party-tile', panel && 'with-panel', full && 'full', idle && 'idle')} ref=${tile} onClick=${() => menu && setMenu(null)}>
    <div class="party-main" onPointerMove=${() => wake(false)} onPointerDown=${() => wake(false)} onPointerLeave=${() => wake(true)} onFocusIn=${() => wake(false)} onKeyDown=${() => wake(false)}>
      <div class="party-video" ref=${box}></div>
      <div class=${cx('party-shield', ctrl && cur && 'can')} onClick=${playPause} onDblClick=${toggleFull}></div>
      ${!cur ? html`<div class="party-empty"><${Icon} name="film" size=${46} sw=${1.4} /><b>${t('Watching together')}</b>
        <p>${ctrl ? t('Nothing is playing. Add a video and everyone in the call watches it with you.') : `${hostName} ${t('hasn’t picked a video yet.')}`}</p>
        ${ctrl ? html`<button type="button" class="btn btn-primary" onClick=${() => { set({ partyPanel: true }); setPanelTab('add'); }}><${Icon} name="plus" size=${16} /> ${t('Add a video')}</button>` : null}</div>` : null}
      ${cur && ui.error ? html`<div class="party-empty over"><${Icon} name="alert-circle" size=${40} sw=${1.4} /><b>${errorText(ui.error)[0]}</b><p>${errorText(ui.error)[1]}</p>
        ${ctrl ? html`<button type="button" class="btn btn-primary" onClick=${party.skip}>${t('Skip it')}</button>` : null}</div>` : null}
      ${cur && ui.blocked && !ui.error ? html`<button type="button" class="party-join" onClick=${resume}><${Icon} name="play" size=${22} fill=${true} sw=${1} /> ${t('Click to join the video')}</button>` : null}
      ${cur && !p.playing && idle ? html`<div class="party-paused" aria-hidden="true"><${Icon} name="pause" size=${34} fill=${true} sw=${1} /></div>` : null}
      <div class="party-top" onPointerEnter=${() => { barHover.current = true; }} onPointerLeave=${() => { barHover.current = false; }}><div class="pt-text"><b title=${cur?.title || ''}>${cur ? cur.title : t('Watching together')}</b><small>${t('Hosted by')} ${hostName}${p.controllers.length ? ` · ${p.controllers.length + 1} ${t('can control it')}` : ''}</small></div>
        <button type="button" class=${cx('pb-btn', panel && 'on')} data-tip=${panel ? t('Hide queue') : t('Queue and people')} data-tip-pos="bottom" aria-label=${t('Queue and people')} onClick=${() => set({ partyPanel: !panel })}><${Icon} name="list" size=${20} />${p.queue.length ? html`<i class="pb-count">${p.queue.length}</i>` : null}</button></div>
      <div class="party-floats" aria-hidden="true">${floats.map((f) => html`<span key=${f.id} class="pf" style=${{ left: `${f.x}%` }}>${f.emoji}<${Avatar} user=${state.users[f.userId]} size=${22} /></span>`)}</div>
      ${note ? html`<div class="party-note" key=${p.rev}>${note}</div>` : null}
      <div class="party-bar" onClick=${(e) => e.stopPropagation()} onPointerEnter=${() => { barHover.current = true; }} onPointerLeave=${() => { barHover.current = false; }}>
        <div class="pb-seek">
          <span class="pb-time">${stamp(shown)}</span>
          ${ctrl && cur && !cur.live ? html`<input type="range" class="party-range" min="0" max=${Math.max(1, duration)} step="1" value=${Math.min(shown, duration || shown)} style=${{ '--pct': `${duration ? (Math.min(shown, duration) / duration) * 100 : 0}%` }}
              onInput=${(e) => setUi((u) => ({ ...u, drag: Number(e.target.value) }))} onChange=${(e) => { const pos = Number(e.target.value); setUi((u) => ({ ...u, drag: undefined, time: pos })); party.control('seek', { pos }); }} aria-label=${t('Seek')} />`
            : html`<span class="party-range ro" style=${{ '--pct': `${cur?.live ? 100 : duration ? (Math.min(shown, duration) / duration) * 100 : 0}%` }} title=${ctrl ? '' : t('Only the host and people they allow can jump around')}></span>`}
          <span class="pb-time">${cur?.live ? t('LIVE') : stamp(duration)}</span></div>
        <div class="pb-row">
          <div class="pb-group">
            ${ctrl ? html`<button type="button" class="pb-btn big" data-tip=${p.playing ? t('Pause for everyone') : t('Play for everyone')} data-tip-pos="top" aria-label=${p.playing ? t('Pause') : t('Play')} disabled=${!cur} onClick=${playPause}><${Icon} name=${p.playing ? 'pause' : 'play'} size=${22} fill=${true} sw=${1} /></button>
              <button type="button" class="pb-btn txt" data-tip=${t('Back 10 seconds')} data-tip-pos="top" disabled=${!cur || cur?.live} onClick=${() => jump(-10)}>−10</button>
              <button type="button" class="pb-btn txt" data-tip=${t('Forward 10 seconds')} data-tip-pos="top" disabled=${!cur || cur?.live} onClick=${() => jump(10)}>+10</button>
              <button type="button" class="pb-btn" data-tip=${t('Next video')} data-tip-pos="top" disabled=${!cur && !p.queue.length} onClick=${party.skip}><${Icon} name="skip-forward" size=${20} /></button>
              <span class="pb-menu"><button type="button" class=${cx('pb-btn txt', p.rate !== 1 && 'on')} data-tip=${t('Playback speed')} data-tip-pos="top" disabled=${!cur} onClick=${(e) => { e.stopPropagation(); setMenu(menu === 'speed' ? null : 'speed'); }}>${p.rate}×</button>
                ${menu === 'speed' ? html`<ul class="pb-pop">${SPEEDS.map((s) => html`<li key=${s}><button type="button" class=${cx(p.rate === s && 'on')} onClick=${() => { setMenu(null); party.control('rate', { rate: s }); }}>${s === 1 ? t('Normal') : `${s}×`}</button></li>`)}</ul>` : null}</span>`
            : html`<span class="pb-lock" data-tip=${t('Only the host and people they allow can pause, jump or change the speed')} data-tip-pos="top"><${Icon} name=${p.playing ? 'play' : 'pause'} size=${16} fill=${true} sw=${1} /> ${p.rate !== 1 ? `${p.rate}×` : ''} <${Icon} name="lock" size=${14} /></span>`}
          </div>
          <div class="pb-group">
            <span class="pb-menu"><button type="button" class="pb-btn" data-tip=${t('React')} data-tip-pos="top" onClick=${(e) => { e.stopPropagation(); setMenu(menu === 'react' ? null : 'react'); }}><${Icon} name="smile" size=${20} /></button>
              ${menu === 'react' ? html`<div class="pb-pop emoji">${EMOJI.map((m) => html`<button type="button" key=${m} onClick=${() => { party.react(m); setMenu(null); }}>${m}</button>`)}</div>` : null}</span>
            <button type="button" class="pb-btn" data-tip=${muted || vol === 0 ? t('Unmute the video') : t('Mute the video')} data-tip-pos="top" onClick=${() => setMuted(!muted)}><${Icon} name=${muted || vol === 0 ? 'volume-x' : 'volume'} size=${20} /></button>
            <input type="range" class="party-range vol" min="0" max="100" value=${muted ? 0 : Math.round(vol * 100)} style=${{ '--pct': `${muted ? 0 : vol * 100}%` }} aria-label=${t('Video volume')} onInput=${(e) => { const v = Number(e.target.value) / 100; setVol(v); setMuted(false); }} />
            <button type="button" class="pb-btn" data-tip=${full ? t('Exit full screen') : t('Full screen')} data-tip-pos="top" onClick=${toggleFull}><${Icon} name=${full ? 'minimize' : 'maximize'} size=${20} /></button>
          </div>
        </div>
      </div>
    </div>
    ${panel ? html`<${PartyPanel} chId=${chId} />` : null}
  </div>`;
}
let setPanelTab = () => {};   // lets the empty tile open the panel on its "Add" tab

/* ------------------------------------------------------------------ the queue / add videos / people panel */
function Row({ v, children, cls, onClick }) {
  return html`<div class=${cx('pp-row', cls)} onClick=${onClick}><span class="pp-thumb"><img src=${v.thumbnail} alt="" loading="lazy" referrerpolicy="no-referrer" draggable=${false} />${v.live ? html`<i class="live">${t('LIVE')}</i>` : v.duration || v.seconds ? html`<i>${v.duration || stamp(v.seconds)}</i>` : null}</span>
    <span class="pp-text"><b title=${v.title}>${v.title}</b><small>${[typeof v.channel === 'string' ? v.channel : v.channel?.name, v.views].filter(Boolean).join(' · ')}</small></span>${children}</div>`;
}
function QueueTab({ p }) {
  const ctrl = canControl(p); const [from, setFrom] = useState(null); const [over, setOver] = useState(null);
  const cur = p.current;
  return html`<div class="pp-scroll">
    <h4>${t('Now playing')}</h4>
    ${cur ? html`<${Row} v=${cur} cls="now"><span class="pp-by">${t('Added by')} ${nameOf(cur.addedBy)}</span><//>` : html`<p class="pp-dim">${t('Nothing is playing.')}</p>`}
    <h4>${t('Up next')}${p.queue.length ? ` · ${p.queue.length}` : ''}</h4>
    ${p.queue.length ? p.queue.map((v, i) => html`<${Row} key=${v.key} v=${v} cls=${cx(from === i && 'dragging', over === i && from !== null && from !== i && (from < i ? 'drop-after' : 'drop-before'))}>
      <span class="pp-by">${nameOf(v.addedBy)}</span>
      ${ctrl ? html`<span class="pp-act"><button type="button" data-tip=${t('Play now')} aria-label=${t('Play now')} onClick=${() => party.playNow(v.key)}><${Icon} name="play" size=${15} fill=${true} sw=${1} /></button>
        <button type="button" data-tip=${t('Remove')} aria-label=${t('Remove')} onClick=${() => party.remove(v.key)}><${Icon} name="x" size=${16} /></button></span>` : null}<//>`).map((row, i) => html`<div key=${p.queue[i].key} draggable=${ctrl} class="pp-drag" onDragStart=${ctrl ? (e) => { setFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.queue[i].key); } : null}
        onDragOver=${ctrl ? (e) => { if (from === null) return; e.preventDefault(); if (over !== i) setOver(i); } : null} onDrop=${ctrl ? (e) => { e.preventDefault(); if (from !== null && from !== i) party.move(p.queue[from].key, i); setFrom(null); setOver(null); } : null} onDragEnd=${() => { setFrom(null); setOver(null); }}>${row}</div>`)
      : html`<p class="pp-dim">${ctrl ? t('The queue is empty. Add videos on the Add tab.') : t('The queue is empty.')}</p>`}
    ${ctrl && p.queue.length > 1 ? html`<p class="pp-dim hint">${t('Drag videos to change their order.')}</p>` : null}
  </div>`;
}
function AddTab({ p }) {
  const ctrl = canControl(p); const [q, setQ] = useState(''); const [res, setRes] = useState(null); const [err, setErr] = useState(null); const timer = useRef(null);
  useEffect(() => {
    if (!ctrl) return undefined;
    let on = true; setErr(null); clearTimeout(timer.current);
    const load = () => { setRes(null); api.get(q.trim() ? `/watch/search?q=${encodeURIComponent(q.trim())}&limit=15` : '/watch/home?chip=all&limit=15').then((r) => on && setRes(r.videos), (e) => on && setErr(e.message || t('Couldn’t load this.'))); };
    if (!q.trim()) load(); else timer.current = setTimeout(load, 350);
    return () => { on = false; clearTimeout(timer.current); };
  }, [q, ctrl]);
  if (!ctrl) return html`<div class="pp-scroll"><p class="pp-dim pad">${t('Only the host and the people they allow can choose videos.')}</p></div>`;
  const added = (v, now) => { party.add(v.id, now); if (!now) toast(`${t('Added')} “${v.title}”`, 'success', 1800); };
  return html`<div class="pp-scroll"><div class="pp-search"><${Icon} name="search" size=${16} /><input type="search" value=${q} placeholder=${t('Search for a video')} maxlength="100" onInput=${(e) => setQ(e.target.value)} autocomplete="off" spellcheck="false" /></div>
    <h4>${q.trim() ? t('Results') : t('Popular right now')}</h4>
    ${err ? html`<p class="pp-dim">${err}</p>` : !res ? html`<div class="pp-center"><${Spinner} /></div>` : res.length ? res.map((v) => html`<${Row} key=${v.id} v=${v}>
      <span class="pp-act always"><button type="button" data-tip=${t('Add to the queue')} aria-label=${t('Add to the queue')} onClick=${() => added(v, false)}><${Icon} name="plus" size=${17} /></button>
        <button type="button" data-tip=${t('Play now')} aria-label=${t('Play now')} onClick=${() => added(v, true)}><${Icon} name="play" size=${15} fill=${true} sw=${1} /></button></span><//>`) : html`<p class="pp-dim">${t('No videos found.')}</p>`}
  </div>`;
}
function PeopleTab({ p, chId }) {
  const room = useSel((s) => s.voice.states[chId]); const users = useSel((s) => s.users); const host = isHost(p);
  const ids = Object.keys(room || {}).sort((a, b) => (a === p.hostId ? -1 : b === p.hostId ? 1 : (p.controllers.includes(b) ? 1 : 0) - (p.controllers.includes(a) ? 1 : 0)));
  return html`<div class="pp-scroll"><h4>${t('In this call')} · ${ids.length}</h4>
    ${ids.map((id) => html`<div class="pp-person" key=${id}><${Avatar} user=${users[id]} size=${34} />
      <span class="pp-text"><b><${UserName} user=${users[id]} /></b><small>${id === p.hostId ? t('Host') : p.controllers.includes(id) ? t('Can choose videos and control playback') : t('Watching')}</small></span>
      ${id === p.hostId ? html`<span class="pp-crown" data-tip=${t('Host')}><${Icon} name="crown" size=${16} /></span>` : host ? html`<button type="button" class=${cx('pp-allow', p.controllers.includes(id) && 'on')} onClick=${() => party.grant(id, !p.controllers.includes(id))}>${p.controllers.includes(id) ? t('Remove control') : t('Allow control')}</button>` : null}</div>`)}
    <p class="pp-dim hint">${host ? t('People you allow can choose videos, pause, jump around and change the speed. Everyone else just watches.') : t('The host decides who can choose videos and control playback.')}</p>
    ${host ? html`<button type="button" class="btn btn-danger pp-end" onClick=${async () => { if (await confirmDialog({ title: t('End the watch party?'), body: t('It ends for everyone in the call. Anyone can start a new one.'), confirmLabel: t('End it'), danger: true })) party.stop(); }}>${t('End watch party')}</button>` : null}
  </div>`;
}
function PartyPanel({ chId }) {
  const p = useSel((s) => s.party); const [tab, setTab] = useState(() => (canControl(p) && !p.current ? 'add' : 'queue'));
  useEffect(() => { setPanelTab = setTab; return () => { setPanelTab = () => {}; }; }, []);
  const tabs = [['queue', t('Queue')], ['add', t('Add')], ['people', t('People')]];
  return html`<aside class="party-panel" onClick=${(e) => e.stopPropagation()}>
    <div class="pp-head"><div class="pp-tabs" role="tablist">${tabs.map(([k, label]) => html`<button type="button" key=${k} role="tab" aria-selected=${tab === k} class=${cx(tab === k && 'on')} onClick=${() => setTab(k)}>${label}</button>`)}</div>
      <button type="button" class="pb-btn" aria-label=${t('Close')} onClick=${() => set({ partyPanel: false })}><${Icon} name="x" size=${18} /></button></div>
    ${tab === 'queue' ? html`<${QueueTab} p=${p} />` : tab === 'add' ? html`<${AddTab} p=${p} />` : html`<${PeopleTab} p=${p} chId=${chId} />`}
  </aside>`;
}

/* ------------------------------------------------------------------ small pieces used elsewhere */
/** On the call panel (bottom left): what the call is watching, and a way back to it. */
export function PartyLine() {
  const p = useSel((s) => s.party); const ch = useSel((s) => s.voice.conn?.channelId);
  if (!p || p.channelId !== ch) return null;
  return html`<button type="button" class="vc-watch" onClick=${focusCall} data-tip=${t('Back to the video')} data-tip-pos="top"><${Icon} name="film" size=${14} /><span>${p.current ? p.current.title : t('Watching together')}</span></button>`;
}
/** On a video's page in Watch, while you are in a call: start watching it together, or add it to the queue. */
export function PartyPills({ id, blocked }) {
  const conn = useSel((s) => s.voice.conn); const p = useSel((s) => s.party);
  if (blocked || !conn || conn.stage || conn.status === 'connecting') return null;
  const active = p && p.channelId === conn.channelId;
  if (active && !canControl(p)) return null;
  if (!active) return html`<button type="button" class="wv-pill" onClick=${() => { party.start(id); set({ partyPanel: false }); focusCall(); }}><${Icon} name="users" size=${18} /> ${t('Watch together')}</button>`;
  return html`<button type="button" class="wv-pill" onClick=${() => { party.add(id); toast(t('Added to the watch party queue'), 'success', 1800); }}><${Icon} name="plus" size=${18} /> ${t('Add to queue')}</button>
    <button type="button" class="wv-pill" onClick=${() => { party.add(id, true); focusCall(); }}><${Icon} name="play" size=${16} fill=${true} sw=${1} /> ${t('Play now')}</button>`;
}
