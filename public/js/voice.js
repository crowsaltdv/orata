// Orata — voice, video & screen share. WebRTC full mesh, signalled over the gateway ("perfect negotiation").
// On a stage channel only the speakers send audio: the audience connects to the speakers and nobody else, and a promotion starts the mic and the missing links.
import { state, set, toast, getChannel, notify, hasPerm, hasChannelPerm } from '/js/store.js';
import { gateway, api } from '/js/api.js';
import { playSound } from '/js/sound.js';
import { t } from '/js/i18n.js';

// ICE servers come from the server (/api/ice) so STUN/TURN is configured in .env; this is the offline fallback.
let ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }], iceCandidatePoolSize: 4 };
let iceFetchedAt = 0; let iceTtl = 3600;
async function loadIce() {
  if (Date.now() - iceFetchedAt < Math.min(iceTtl, 3600) * 500) return;   // refresh well before TURN credentials expire
  try {
    const c = await api.get('/ice');
    ICE = { iceServers: c.iceServers, iceTransportPolicy: c.iceTransportPolicy || 'all', iceCandidatePoolSize: 4 };
    iceFetchedAt = Date.now(); iceTtl = c.ttl || 3600;
  } catch { /* keep the last known / default servers */ }
}

/* ------------------------------------------------------------------ media helpers (also used by Settings → Voice & Video) */
export async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return { inputs: all.filter((d) => d.kind === 'audioinput'), outputs: all.filter((d) => d.kind === 'audiooutput'), cameras: all.filter((d) => d.kind === 'videoinput') };
  } catch { return { inputs: [], outputs: [], cameras: [] }; }
}
export function micConstraints(v = state.local.voice) {
  return { audio: { deviceId: v.inputDevice && v.inputDevice !== 'default' ? { exact: v.inputDevice } : undefined, noiseSuppression: !!v.noiseSuppression, echoCancellation: !!v.echoCancellation, autoGainControl: !!v.autoGain, channelCount: 1 } };
}
export function cameraConstraints(v = state.local.voice) {
  const h = Number(v.videoQuality || 720); const w = Math.round((h * 16) / 9);
  return { video: { deviceId: v.cameraDevice && v.cameraDevice !== 'default' ? { exact: v.cameraDevice } : undefined, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } } };
}
export function createMeter(stream, onLevel) {
  const Ctx = window.AudioContext || window.webkitAudioContext; const ctx = new Ctx(); const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
  const buf = new Uint8Array(an.fftSize); let raf = 0; let live = true;
  const tick = () => { if (!live) return; an.getByteTimeDomainData(buf); let sum = 0; for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; } onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3.2)); raf = requestAnimationFrame(tick); };
  tick();
  return { stop() { live = false; cancelAnimationFrame(raf); try { src.disconnect(); ctx.close(); } catch { /* ignore */ } } };
}

/* ------------------------------------------------------------------ session state */
const S = {
  channelId: null, audioCtx: null, mic: null, micSrc: null, gain: null, gate: null, analyser: null, dest: null, outTrack: null,
  camera: null, screen: null, stage: false, roles: new Map(), peers: new Map(), remoteAudio: new Map(), remoteMeters: new Map(), speakTimer: null, pttDown: false, userVol: {}, meta: {},
};
export const streamStore = { version: 0, byUser: new Map() }; // userId -> { camera, screen, audio }
const bump = () => { streamStore.version++; notify(); set({ voice: { ...state.voice, rev: streamStore.version } }); };
const patchConn = (p) => set({ voice: { ...state.voice, conn: state.voice.conn ? { ...state.voice.conn, ...p } : null } });
const me = () => state.me.id;
/** Browsers only hand out the microphone, camera and screen on https:// pages (or localhost). */
const needsSecure = () => (!navigator.mediaDevices?.getUserMedia ? 'Microphone, camera and screen sharing only work on https:// (or localhost). Open Orata over HTTPS to use them.' : null);
/** How the link to each other person is doing: 'connecting' | 'slow' | 'failed' | 'connected' (shown on their tile). */
const setLink = (uid, st) => { const cur = state.voice.links || {}; if (cur[uid] === st) return; set({ voice: { ...state.voice, links: { ...cur, [uid]: st } } }); };
const warned = new Set();
function warnUnreachable(uid) {
  if (warned.has(uid)) return; warned.add(uid);
  const name = state.users[uid]?.displayName || 'someone';
  toast(state.turn ? `Couldn’t connect to ${name}, even through the relay. Try leaving and rejoining.` : `Couldn’t connect to ${name}: your two networks can’t link directly. The server needs a TURN relay for calls like this (see the README).`, 'error', 9000);
}

/* ------------------------------------------------------------------ local audio graph */
async function startMic() {
  const insecure = needsSecure();
  try {
    if (insecure) throw Object.assign(new Error(insecure), { name: 'InsecureContext' });
    S.mic = await navigator.mediaDevices.getUserMedia(micConstraints());
  } catch (e) {
    toast(e.name === 'InsecureContext' ? e.message : e.name === 'NotAllowedError' ? 'Microphone permission was denied — you can listen but not speak.' : 'No microphone found — you can listen but not speak.', 'error', 6000);
    S.mic = null; patchConn({ muted: true, noMic: true }); gateway.send('voice_update', { muted: true }); return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext; S.audioCtx = new Ctx();
  S.micSrc = S.audioCtx.createMediaStreamSource(S.mic);
  S.gain = S.audioCtx.createGain(); S.gain.gain.value = (state.local.voice.inputVolume ?? 100) / 100;
  S.gate = S.audioCtx.createGain(); S.gate.gain.value = 1;
  S.analyser = S.audioCtx.createAnalyser(); S.analyser.fftSize = 512;
  S.dest = S.audioCtx.createMediaStreamDestination();
  S.micSrc.connect(S.gain); S.gain.connect(S.analyser); S.gain.connect(S.gate); S.gate.connect(S.dest);
  S.outTrack = S.dest.stream.getAudioTracks()[0];
  applyMute();
  startSpeakingLoop();
}
/** Stage: who may bring people up and down — whoever manages the channel or moderates members. */
export function isStageMod(ch) { return !!ch && (hasChannelPerm(ch, 'MANAGE_CHANNELS') || hasPerm(ch.serverId, 'MODERATE_MEMBERS')); }
function stopMic() {
  S.mic?.getTracks().forEach((tr) => tr.stop()); S.mic = null;
  try { S.audioCtx?.close(); } catch { /* ignore */ }
  Object.assign(S, { audioCtx: null, micSrc: null, gain: null, gate: null, analyser: null, dest: null, outTrack: null });
  const sp = { ...(state.voice.speaking || {}) }; if (sp[me()]) { sp[me()] = false; set({ voice: { ...state.voice, speaking: sp } }); }
}
/** Walks onto the stage: starts the microphone (muted until you unmute) and reaches out to everybody in the room. */
async function becomeSpeaker() {
  patchConn({ speaker: true, noMic: false, muted: true });   // on stage you start muted, whatever the audience did
  if (!S.mic) await startMic();
  if (!S.stage || !state.voice.conn) return;
  if (S.outTrack) for (const p of S.peers.values()) if (!p.senders.audio) p.senders.audio = p.pc.addTrack(S.outTrack, S.dest.stream);
  for (const uid of S.roles.keys()) if (uid !== me() && !S.peers.has(uid)) getPeer(uid);
  applyMute();
}
/** Steps down: stops sending, and keeps only the links to the speakers. */
function becomeAudience() {
  stopCamera(); stopScreen();
  for (const p of S.peers.values()) if (p.senders.audio) { try { p.pc.removeTrack(p.senders.audio); } catch { /* ignore */ } p.senders.audio = null; }
  stopMic();
  patchConn({ speaker: false, muted: true, video: false, screen: false });
  for (const uid of [...S.peers.keys()]) if (!S.roles.get(uid)) dropPeer(uid);
}
function applyMute() {
  const c = state.voice.conn; if (!c || !S.outTrack) return;
  const v = state.local.voice;
  const muted = c.muted || c.deafened || (v.pushToTalk && !S.pttDown);
  S.outTrack.enabled = !muted;
}
const buf = new Uint8Array(512);
function level(an) { an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; s += x * x; } return Math.sqrt(s / buf.length); }
function startSpeakingLoop() {
  let hold = 0; let wasSpeaking = false; let noiseFloor = 0.008;
  clearInterval(S.speakTimer);
  S.speakTimer = setInterval(() => {
    const c = state.voice.conn; if (!c) return;
    const v = state.local.voice; const sp = { ...(state.voice.speaking || {}) }; let changed = false;
    // local
    if (S.analyser) {
      const l = level(S.analyser);
      if (v.autoSensitivity) { noiseFloor = Math.min(noiseFloor * 0.999 + l * 0.001, 0.03); }
      const threshold = v.autoSensitivity ? Math.max(0.018, noiseFloor * 2.8) : 0.004 + (v.sensitivity / 100) * 0.1;
      const over = l > threshold; if (over) hold = 6; else hold = Math.max(0, hold - 1);
      const open = hold > 0; if (S.gate) S.gate.gain.setTargetAtTime(open ? 1 : 0.0001, S.audioCtx.currentTime, open ? 0.01 : 0.12);
      const speaking = open && S.outTrack?.enabled;
      if (speaking !== wasSpeaking) { wasSpeaking = speaking; sp[me()] = speaking; changed = true; }
    }
    // remote
    for (const [uid, m] of S.remoteMeters) { const on = level(m.an) > 0.02; if (!!sp[uid] !== on) { sp[uid] = on; changed = true; } }
    if (changed) set({ voice: { ...state.voice, speaking: sp } });
  }, 80);
}

/* ------------------------------------------------------------------ peers */
function getPeer(uid) {
  let p = S.peers.get(uid); if (p) return p;
  const pc = new RTCPeerConnection(ICE);
  p = { uid, pc, polite: me() < uid, making: false, ignore: false, senders: {} };
  S.peers.set(uid, p);
  pc.onicecandidate = (e) => { if (e.candidate) gateway.send('voice_signal', { to: uid, signal: { candidate: e.candidate } }); };
  pc.onnegotiationneeded = async () => {
    try { p.making = true; await pc.setLocalDescription(); gateway.send('voice_signal', { to: uid, signal: { description: pc.localDescription } }); } catch (e) { console.warn('[voice] negotiate', e); } finally { p.making = false; }
  };
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
  setLink(uid, 'connecting');
  p.timer = setTimeout(() => { if (pc.connectionState !== 'connected') setLink(uid, 'slow'); }, 12000);
  pc.onconnectionstatechange = () => {
    const cs = pc.connectionState;
    if (cs === 'connected') { clearTimeout(p.timer); setLink(uid, 'connected'); }
    else if (cs === 'failed') { setLink(uid, 'failed'); warnUnreachable(uid); }
    else if (cs === 'disconnected') setLink(uid, 'slow');
  };
  pc.ontrack = (e) => attachRemote(uid, e);
  // our audio
  if (S.outTrack) p.senders.audio = pc.addTrack(S.outTrack, S.dest.stream);
  else pc.addTransceiver('audio', { direction: 'recvonly' });   // listen-only (no mic): still triggers an offer so we hear everyone
  if (S.camera) p.senders.camera = pc.addTrack(S.camera.getVideoTracks()[0], S.camera);
  if (S.screen) { p.senders.screen = pc.addTrack(S.screen.getVideoTracks()[0], S.screen); const sa = S.screen.getAudioTracks()[0]; if (sa) p.senders.screenAudio = pc.addTrack(sa, S.screen); }
  sendMeta(uid);
  return p;
}
function sendMeta(to) { gateway.send('voice_signal', { to, signal: { meta: { camera: S.camera?.id || null, screen: S.screen?.id || null } } }); }
function broadcastMeta() { for (const uid of S.peers.keys()) sendMeta(uid); }

async function onSignal({ from, channelId, signal }) {
  if (!S.channelId || channelId !== S.channelId || !signal) return;
  const p = getPeer(from); const pc = p.pc;
  try {
    if (signal.meta) { (S.meta[from] ||= {}); S.meta[from] = signal.meta; remap(from); return; }
    if (signal.description) {
      const d = signal.description; const collision = d.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && collision; if (p.ignore) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') { await pc.setLocalDescription(); gateway.send('voice_signal', { to: from, signal: { description: pc.localDescription } }); }
    } else if (signal.candidate) {
      try { await pc.addIceCandidate(signal.candidate); } catch (e) { if (!p.ignore) console.warn('[voice] ice', e); }
    }
  } catch (e) { console.warn('[voice] signal', e); }
}
function entryFor(uid) { let e = streamStore.byUser.get(uid); if (!e) { e = { camera: null, screen: null, audio: null, all: new Map() }; streamStore.byUser.set(uid, e); } return e; }
function remap(uid) {
  const e = entryFor(uid); const meta = S.meta[uid] || {};
  e.camera = meta.camera ? e.all.get(meta.camera) || null : null; e.screen = meta.screen ? e.all.get(meta.screen) || null : null; bump();
}
function attachRemote(uid, ev) {
  const stream = ev.streams[0] || new MediaStream([ev.track]); const e = entryFor(uid); e.all.set(stream.id, stream);
  if (ev.track.kind === 'audio') {
    const meta = S.meta[uid] || {}; const isScreenAudio = meta.screen === stream.id;
    if (!isScreenAudio || !S.remoteAudio.has(uid)) {
      let a = S.remoteAudio.get(uid);
      if (!a) { a = new Audio(); a.autoplay = true; a.playsInline = true; S.remoteAudio.set(uid, a); }
      a.srcObject = stream; applyOutput(a, uid); a.play?.().catch(() => {});
      S.remoteMeters.get(uid)?.stop?.();
      try { const Ctx = window.AudioContext || window.webkitAudioContext; const ctx = new Ctx(); const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an); S.remoteMeters.set(uid, { an, stop: () => { try { ctx.close(); } catch { /* ignore */ } } }); } catch { /* ignore */ }
    }
  }
  ev.track.onended = () => { e.all.delete(stream.id); remap(uid); };
  stream.onremovetrack = () => { if (!stream.getTracks().length) { e.all.delete(stream.id); remap(uid); } };
  remap(uid);
}
function applyOutput(a, uid) {
  const v = state.local.voice; const c = state.voice.conn;
  a.muted = !!c?.deafened; a.volume = Math.min(1, ((v.outputVolume ?? 100) / 100) * (S.userVol[uid] ?? 1));
  if (v.outputDevice && v.outputDevice !== 'default' && a.setSinkId) a.setSinkId(v.outputDevice).catch(() => {});
}
export function setUserVolume(uid, vol) { S.userVol[uid] = vol; const a = S.remoteAudio.get(uid); if (a) applyOutput(a, uid); }
export const getUserVolume = (uid) => S.userVol[uid] ?? 1;
export function refreshOutputs() { for (const [uid, a] of S.remoteAudio) applyOutput(a, uid); if (S.gain) S.gain.gain.value = (state.local.voice.inputVolume ?? 100) / 100; applyMute(); }

function dropPeer(uid) {
  const p = S.peers.get(uid); if (p) { clearTimeout(p.timer); try { p.pc.close(); } catch { /* ignore */ } S.peers.delete(uid); }
  if (state.voice.links?.[uid]) { const links = { ...state.voice.links }; delete links[uid]; set({ voice: { ...state.voice, links } }); }
  warned.delete(uid);
  const a = S.remoteAudio.get(uid); if (a) { a.srcObject = null; S.remoteAudio.delete(uid); }
  S.remoteMeters.get(uid)?.stop?.(); S.remoteMeters.delete(uid);
  streamStore.byUser.delete(uid); delete S.meta[uid];
  const sp = { ...(state.voice.speaking || {}) }; delete sp[uid]; set({ voice: { ...state.voice, speaking: sp } }); bump();
}
function teardown() {
  clearInterval(S.speakTimer);
  for (const uid of [...S.peers.keys()]) dropPeer(uid);
  for (const k of ['camera', 'screen', 'mic']) { S[k]?.getTracks().forEach((t) => t.stop()); S[k] = null; }
  try { S.audioCtx?.close(); } catch { /* ignore */ }
  Object.assign(S, { audioCtx: null, micSrc: null, gain: null, gate: null, analyser: null, dest: null, outTrack: null, channelId: null, meta: {}, stage: false, roles: new Map() });
  warned.clear(); streamStore.byUser.clear(); set({ voice: { ...state.voice, speaking: {}, links: {}, conn: null } }); bump();
}

/* ------------------------------------------------------------------ public API */
export const voice = {
  async join(channelId) {
    const ch = getChannel(channelId); if (!ch) return;
    if (state.voice.conn?.channelId === channelId) return;
    if (state.voice.conn) teardown();
    S.channelId = channelId; S.stage = ch.type === 'stage'; S.roles = new Map();
    set({ voice: { ...state.voice, conn: { channelId, muted: S.stage || !!state.local.voice.joinMuted, deafened: false, video: false, screen: false, status: 'connecting', stage: S.stage, speaker: false } } });
    if (S.stage) startSpeakingLoop();   // the audience has no microphone, but still shows who is talking
    await Promise.all([S.stage ? null : startMic(), loadIce()]);
    if (S.channelId !== channelId) return;
    gateway.send('voice_join', { channelId, muted: !!state.voice.conn?.muted });
  },
  leave() { if (!state.voice.conn) return; gateway.send('voice_leave'); teardown(); playSound('leave'); },
  toggleMute() {
    const c = state.voice.conn;
    if (c?.stage && !c.speaker) { voice.toggleHand(); return; }   // in the audience the microphone button asks to speak
    if (!c) { set({ local: { ...state.local, voice: { ...state.local.voice, joinMuted: !state.local.voice.joinMuted } } }); playSound(state.local.voice.joinMuted ? 'mute' : 'unmute'); return; }
    if (c.noMic && !S.mic) { startMic().then(() => { if (S.mic) { patchConn({ muted: false, noMic: false }); applyMute(); for (const p of S.peers.values()) if (S.outTrack && !p.senders.audio) p.senders.audio = p.pc.addTrack(S.outTrack, S.dest.stream); } }); return; }
    if (c.deafened) { patchConn({ deafened: false, muted: false }); gateway.send('voice_update', { deafened: false, muted: false }); playSound('undeafen'); applyMute(); refreshOutputs(); return; }
    const muted = !c.muted; patchConn({ muted }); gateway.send('voice_update', { muted }); applyMute(); playSound(muted ? 'mute' : 'unmute');
  },
  toggleDeafen() {
    const c = state.voice.conn; if (!c) return;
    const deafened = !c.deafened; patchConn({ deafened, muted: deafened ? true : false }); gateway.send('voice_update', { deafened, muted: deafened ? true : false }); applyMute(); refreshOutputs(); playSound(deafened ? 'deafen' : 'undeafen');
  },
  async toggleCamera() {
    const c = state.voice.conn; if (!c || (c.stage && !c.speaker)) return;
    if (S.camera) { stopCamera(); return; }
    if (needsSecure()) { toast(needsSecure(), 'error', 6000); return; }
    try {
      S.camera = await navigator.mediaDevices.getUserMedia(cameraConstraints());
      const track = S.camera.getVideoTracks()[0]; track.onended = () => stopCamera();
      for (const p of S.peers.values()) p.senders.camera = p.pc.addTrack(track, S.camera);
      broadcastMeta(); patchConn({ video: true }); gateway.send('voice_update', { video: true }); entryFor(me()).camera = S.camera; bump();
    } catch (e) { toast(e.name === 'NotAllowedError' ? 'Camera permission was denied' : 'Couldn’t start your camera', 'error'); }
  },
  async toggleScreen() {
    const c = state.voice.conn; if (!c || (c.stage && !c.speaker)) return;
    if (S.screen) { stopScreen(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { toast(needsSecure() || 'Your browser can’t share its screen.', 'error', 6000); return; }
    try {
      S.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 }, cursor: 'always' }, audio: true });
      const vt = S.screen.getVideoTracks()[0]; vt.onended = () => stopScreen();
      for (const p of S.peers.values()) { p.senders.screen = p.pc.addTrack(vt, S.screen); const sa = S.screen.getAudioTracks()[0]; if (sa) p.senders.screenAudio = p.pc.addTrack(sa, S.screen); }
      broadcastMeta(); patchConn({ screen: true }); gateway.send('voice_update', { screen: true }); entryFor(me()).screen = S.screen; bump(); playSound('join');
    } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Couldn’t start screen sharing', 'error'); }
  },
  micLevel: () => (S.analyser ? level(S.analyser) : 0),
  /** Stage: raise or lower your hand to ask for the microphone. */
  toggleHand() {
    const c = state.voice.conn; if (!c?.stage || c.speaker) return;
    const ch = getChannel(c.channelId); if (ch && !hasChannelPerm(ch, 'SPEAK')) { toast('You don’t have permission to speak on this stage.', 'error', 4000); return; }
    const up = !state.voice.states[c.channelId]?.[me()]?.hand;
    gateway.send('voice_update', { hand: up }); playSound(up ? 'unmute' : 'mute');
    if (up) toast(t('Hand raised — a moderator can invite you to speak'), 'info', 2800);
  },
  /** Stage: bring someone up to speak (moderators) or send a speaker back to the audience (moderators, or yourself). */
  setSpeaker(uid, on) { gateway.send('stage_speaker', { userId: uid, speaker: on }); },
  /** Stage: the moderator actions for one person, as context-menu items. */
  stageMenu(uid) {
    const c = state.voice.conn; const ch = c && getChannel(c.channelId); if (ch?.type !== 'stage') return [];
    const st = state.voice.states[ch.id]?.[uid]; if (!st || !isStageMod(ch)) return [];
    return st.speaker ? (uid === me() ? [] : [{ label: t('Move to Audience'), icon: 'users', onClick: () => voice.setSpeaker(uid, false) }]) : [{ label: t('Invite to Speak'), icon: 'mic', onClick: () => voice.setSpeaker(uid, true) }];
  },
};
function stopCamera() {
  if (!S.camera) return; const tr = S.camera.getTracks(); tr.forEach((t) => t.stop());
  for (const p of S.peers.values()) { if (p.senders.camera) { try { p.pc.removeTrack(p.senders.camera); } catch { /* ignore */ } p.senders.camera = null; } }
  S.camera = null; broadcastMeta(); entryFor(me()).camera = null; patchConn({ video: false }); gateway.send('voice_update', { video: false }); bump();
}
function stopScreen() {
  if (!S.screen) return; S.screen.getTracks().forEach((t) => t.stop());
  for (const p of S.peers.values()) for (const k of ['screen', 'screenAudio']) if (p.senders[k]) { try { p.pc.removeTrack(p.senders[k]); } catch { /* ignore */ } p.senders[k] = null; }
  S.screen = null; broadcastMeta(); entryFor(me()).screen = null; patchConn({ screen: false }); gateway.send('voice_update', { screen: false }); bump();
}

/* ------------------------------------------------------------------ gateway wiring */
gateway.on('voice_joined', async ({ channelId, peers, states }) => {
  if (state.voice.conn?.channelId !== channelId) return;
  patchConn({ status: 'connected' }); playSound('join');
  if (S.stage) {
    S.roles = new Map((states || []).map((s) => [s.userId, !!s.speaker]));
    if (S.roles.get(me())) { toast(t('You’re on stage — unmute to speak'), 'success', 3500); await becomeSpeaker(); }
    else if (S.mic || state.voice.conn?.speaker) becomeAudience();
    if (S.channelId !== channelId) return;
  }
  applyMute();
  for (const uid of peers) if (uid !== me()) getPeer(uid);
});
/** Stage: people moving between the audience and the stage. Listeners link to speakers only. */
gateway.on('voice_state_update', ({ channelId, userId, state: st }) => {
  if (!S.stage || channelId !== S.channelId) return;
  if (!st) { S.roles.delete(userId); return; }
  const was = S.roles.get(userId); const now = !!st.speaker; S.roles.set(userId, now);
  if (userId === me()) {
    if (now && !was) { playSound('join'); toast(t('You’re on stage — unmute to speak'), 'success', 3500); becomeSpeaker(); }
    else if (!now && was) { toast(t('You moved to the audience'), 'info', 3000); becomeAudience(); }
  } else if (was && !now && !S.roles.get(me())) dropPeer(userId);   // a speaker became a listener: two listeners don’t connect
});
gateway.on('voice_signal', onSignal);
gateway.on('voice_peer_left', ({ channelId, userId }) => { if (S.channelId === channelId) dropPeer(userId); });
gateway.on('voice_left', ({ channelId, reason }) => {
  if (state.voice.conn?.channelId !== channelId || reason === 'left') return;
  teardown(); if (reason === 'moved') return; toast(reason === 'kicked' ? 'You were removed from the voice channel' : 'Disconnected from voice', 'info');
});
gateway.on('ready', async () => { // reconnected: the server forgot our voice state → rejoin
  const c = state.voice.conn; if (!c) return;
  await loadIce();
  for (const uid of [...S.peers.keys()]) dropPeer(uid);
  S.roles = new Map();
  gateway.send('voice_join', { channelId: c.channelId, muted: c.muted, deafened: c.deafened, video: c.video });
});
// push-to-talk
window.addEventListener('keydown', (e) => { const v = state.local.voice; if (v.pushToTalk && e.code === v.pttKey && !e.repeat && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { S.pttDown = true; applyMute(); } });
window.addEventListener('keyup', (e) => { const v = state.local.voice; if (v.pushToTalk && e.code === v.pttKey) { S.pttDown = false; applyMute(); } });
window.addEventListener('beforeunload', () => { if (state.voice.conn) gateway.send('voice_leave'); });
