// Orate — message composer: attachments, drag & drop, paste, autocomplete (@ # :), slash commands, replies, pickers.
import { html, useState, useEffect, useRef, useLayoutEffect, useMemo, cx, fileSize, uid, isImageType, throttle } from '/js/lib.js';
import { state, set, useSel, getChannel, dmName, dmUserId, toast, hasChannelPerm, allCustomEmojis, customToken, openContext, openModal, closePopover, openPopover, getUser } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, IconBtn, Spinner } from '/js/ui.js';
import { sendMessage, sendTyping, act, getEntry } from '/js/actions.js';
import { upload, api } from '/js/api.js';
import { encodeMentions, decodeMentions } from '/js/markdown.js';
import { searchEmoji, shortcodeEmoji, loadEmoji, noteEmojiUse } from '/js/emoji.js';
import { openPicker } from '/js/pickers.js';
import { t } from '/js/i18n.js';
import { fx } from '/js/fx.js';
import { shareTheme } from '/js/theme-card.js';
import { cloakAsDesmos } from '/js/cloak.js';
import { orbitCommand, ORBIT_COMMANDS } from '/js/orbit-commands.js';
import { mayUseOrbit, orbitSays } from '/js/orbit.js';

const drafts = new Map(); // channelId -> text
/** How a custom emoji reads in the message box: `:name:` (turned into the real token when sent) unless another server has one with the same name. */
const emojiText = (e, serverId) => { const tok = `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`; return customToken(e.name, serverId) === tok ? `:${e.name}:` : tok; };
export const composerApi = { insert: () => {}, focus: () => {}, setText: () => {} };

/* ---- audio messages: recorded with the mic button, or an audio file dropped in; at most 3 minutes (they delete themselves after a day) ---- */
const MAX_AUDIO = 180;
const AUDIO_EXT = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm' };
const audioType = (f) => (f.type.startsWith('audio/') ? f.type : AUDIO_EXT[(/\.([a-z0-9]+)$/i.exec(f.name || '')?.[1] || '').toLowerCase()] || null);
export const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** How long an audio file plays, in seconds (null when the browser can't tell). Files whose length isn't in their header are sought to the end to find it. */
function audioLength(f) {
  return new Promise((resolve) => {
    const a = new Audio(); const u = URL.createObjectURL(f); let over = false;
    const done = (d) => { if (over) return; over = true; URL.revokeObjectURL(u); a.removeAttribute('src'); resolve(Number.isFinite(d) && d > 0 ? d : null); };
    a.preload = 'metadata'; a.onerror = () => done(null);
    a.onloadedmetadata = () => { if (Number.isFinite(a.duration)) done(a.duration); else { a.ontimeupdate = () => { a.ontimeupdate = null; done(a.duration); }; a.currentTime = 1e101; } };
    setTimeout(() => done(null), 8000);
    a.src = u;
  });
}

const COMMANDS = [
  { name: 'shrug', desc: 'Appends ¯\\_(ツ)_/¯ to your message', arg: 'message' },
  { name: 'tableflip', desc: 'Appends (╯°□°）╯︵ ┻━┻ to your message', arg: 'message' },
  { name: 'unflip', desc: 'Appends ┬─┬ ノ( ゜-゜ノ) to your message', arg: 'message' },
  { name: 'me', desc: 'Show action text in italics', arg: 'action' },
  { name: 'spoiler', desc: 'Hide your message behind a spoiler', arg: 'message' },
  { name: 'gif', desc: 'Search for a GIF', arg: 'query' },
  { name: 'poll', desc: 'Ask everybody a question', arg: 'question' },
  { name: 'theme', desc: 'Share your theme so others can try it', arg: 'name (optional)' },
  { name: 'cloak', desc: 'Open Orate in about:blank, disguised as Desmos', noArg: true },
  { name: 'nick', desc: 'Change your nickname in this server', arg: 'name', server: true },
];

function TypingBar({ chId }) {
  const names = useSel((s) => {
    const ty = s.typing[chId]; if (!ty) return '';
    const ch = getChannel(chId);
    return Object.keys(ty).filter((id) => id !== s.me.id && s.relationships[id] !== 'blocked').map((id) => (ch?.serverId ? s.servers[ch.serverId]?.members.find((m) => m.id === id)?.nick : null) || s.users[id]?.displayName || 'Someone').join('\u0001');
  });
  const list = names ? names.split('\u0001') : [];
  return html`<div class=${cx('typing-bar', list.length && 'on')} aria-live="polite">
    ${list.length ? html`<span class="dots"><i></i><i></i><i></i></span><span class="typing-text">${list.length === 1 ? html`<b>${list[0]}</b> ${t('is typing…')}` : list.length === 2 ? html`<b>${list[0]}</b> ${t('and')} <b>${list[1]}</b> ${t('are typing…')}` : list.length === 3 ? html`<b>${list[0]}</b>, <b>${list[1]}</b>, ${t('and')} <b>${list[2]}</b> ${t('are typing…')}` : t('Several people are typing…')}</span>` : null}
  </div>`;
}

function getTrigger(text, caret) {
  const before = text.slice(0, caret);
  let m = /(^|[\s(])([@#])([^\s@#]{0,32})$/.exec(before); if (m) return { kind: m[2], query: m[3], start: caret - m[3].length - 1 };
  m = /(^|[\s(]):([a-z0-9_+-]{2,32})$/i.exec(before); if (m) return { kind: ':', query: m[2], start: caret - m[2].length - 1 };
  if (/^\/[a-z0-9]*$/i.test(before) && before.length === text.length) return { kind: '/', query: before.slice(1), start: 0 };
  return null;
}

export function Composer({ chId }) {
  const ch = useSel((s) => getChannel(chId));
  const replyTo = useSel((s) => (s.replyTo?.channelId === chId ? s.replyTo.id : null));
  const replyMsg = useSel((s) => (s.replyTo?.channelId === chId ? s.msgs[chId]?.list.find((m) => m.id === s.replyTo.id) : null));
  const replyName = useSel((s) => { const m = s.msgs[chId]?.list.find((x) => x.id === s.replyTo?.id); return m ? ((ch?.serverId && s.servers[ch.serverId]?.members.find((x) => x.id === m.authorId)?.nick) || s.users[m.authorId]?.displayName) : ''; });
  const perms = useSel((s) => (ch?.serverId ? (getChannel(chId)?.cperms || s.servers[ch.serverId]?.perms)?.join() : ''));
  const blockedBy = useSel((s) => { const o = ch?.type === 'dm' ? dmUserId(ch) : null; return o ? s.relationships[o] === 'blocked' : false; });
  const dropdownRef = useRef(null);
  const [text, setText] = useState(() => drafts.get(chId) || '');
  const [atts, setAtts] = useState([]);
  const [media, setMedia] = useState(null);       // a GIF or sticker waiting to be sent with the next message
  const [drag, setDrag] = useState(false);
  const [ac, setAc] = useState(null); const [acIdx, setAcIdx] = useState(0);
  const [ping, setPing] = useState(true);
  const ta = useRef(null); const file = useRef(null); const dragDepth = useRef(0);
  const [rec, setRec] = useState(null); const recRef = useRef(null);   // an audio message being recorded
  const server = ch?.serverId ? state.servers[ch.serverId] : null;
  const lockedPost = ch?.type === 'post' && ch.locked && !hasChannelPerm(ch, 'MANAGE_MESSAGES') && ch.ownerId !== state.me.id;
  const timeoutUntil = server?.members.find((m) => m.id === state.me.id)?.timeoutUntil || 0;
  const timedOut = timeoutUntil > Date.now() && !server?.perms.includes('ADMINISTRATOR') && server?.ownerId !== state.me.id;
  const canSend = (!server || hasChannelPerm(ch, 'SEND_MESSAGES')) && !lockedPost;
  const canAttach = !server || hasChannelPerm(ch, 'ATTACH_FILES');
  const canGif = !server || hasChannelPerm(ch, 'SEND_GIFS');
  const orbitOn = !!server?.orbitId;

  // swap drafts when the channel changes
  useEffect(() => { setText(drafts.get(chId) || ''); setAtts([]); setMedia(null); setAc(null); setPing(true); if (matchMedia('(pointer:fine)').matches) setTimeout(() => ta.current?.focus(), 30); }, [chId]);
  useEffect(() => { drafts.set(chId, text); }, [text, chId]);
  useEffect(() => { if (replyTo) { setPing(true); ta.current?.focus(); } }, [replyTo]);
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, Math.round(innerHeight * 0.45)) + 'px'; } }, [text, chId]);
  useEffect(() => { loadEmoji(); }, []);

  composerApi.focus = () => ta.current?.focus();
  composerApi.setText = (v) => { setText(v); setTimeout(() => ta.current?.focus(), 0); };
  composerApi.insert = (s) => {
    const el = ta.current; if (!el) return;
    const a = el.selectionStart ?? text.length; const b = el.selectionEnd ?? text.length;
    const next = text.slice(0, a) + s + text.slice(b); setText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + s.length, a + s.length); });
  };

  /* ---- attachments ---- */
  // `recorded` is the length of a recording made with the mic button (a browser's own recordings don't always say how long they are)
  const addFiles = async (files, recorded) => {
    if (!canAttach) { toast('You don’t have permission to upload files here', 'error'); return; }
    const list = [...files].filter((f) => f.size >= 0).slice(0, 10 - atts.length);
    if (!list.length) return;
    const max = (state.maxUpload || 25 * 1024 * 1024);
    const staged = [];
    for (const f of list) {
      if (f.size > max) { toast(`${f.name} is too large (max ${fileSize(max)})`, 'error'); continue; }
      const aType = audioType(f); let duration = null;
      if (aType) {   // every audio file becomes an audio message, so it must be 3 minutes or less
        duration = recorded || await audioLength(f);
        if (!duration) { toast(`Orate can’t tell how long ${f.name} is, so it can’t be an audio message`, 'error'); continue; }
        if (duration > MAX_AUDIO + 0.5) { toast(`${f.name} is ${clock(duration)} long. Audio messages can be at most 3 minutes.`, 'error', 6000); continue; }
      }
      const a = { id: uid(), file: f, name: f.name || 'pasted-file', size: f.size, type: aType || f.type || 'application/octet-stream', preview: isImageType(f.type) || f.type.startsWith('video/') ? URL.createObjectURL(f) : null, progress: 0, status: 'uploading', spoiler: /^SPOILER_/i.test(f.name), ...(aType ? { voice: true, duration } : {}) };
      if (isImageType(f.type)) { try { const bmp = await createImageBitmap(f); a.width = bmp.width; a.height = bmp.height; bmp.close?.(); } catch { /* ignore */ } }
      const handle = {}; a.handle = handle;
      a.promise = upload(f, (p) => setAtts((cur) => cur.map((x) => (x.id === a.id ? { ...x, progress: p } : x))), handle)
        .then((r) => { setAtts((cur) => cur.map((x) => (x.id === a.id ? { ...x, status: 'done', progress: 1, result: r } : x))); return r; })
        .catch((e) => { setAtts((cur) => cur.map((x) => (x.id === a.id ? { ...x, status: 'error', error: e.message } : x))); if (e.code !== 'abort') toast(`${f.name}: ${e.message}`, 'error'); throw e; });
      a.promise.catch(() => {});
      staged.push(a);
    }
    setAtts((cur) => [...cur, ...staged]);
    ta.current?.focus();
  };
  const removeAtt = (a) => { a.handle?.abort?.(); setAtts((cur) => cur.filter((x) => x.id !== a.id)); if (a.preview) setTimeout(() => URL.revokeObjectURL(a.preview), 4000); };

  /* ---- recording an audio message (up to 3 minutes; it lands in the tray like a dropped file) ---- */
  const stopRec = (keep) => { const r = recRef.current; if (!r) return; r.keep = keep; if (r.mr.state !== 'inactive') r.mr.stop(); else r.mr.onstop?.(); };
  const startRec = async () => {
    if (!canAttach) { toast('You don’t have permission to upload files here', 'error'); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast('This browser can’t record audio', 'error'); return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast('Orate can’t use your microphone. Allow it for this site and try again.', 'error', 6000); return; }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((x) => MediaRecorder.isTypeSupported?.(x)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const r = { mr, chunks: [], start: Date.now(), keep: false };
    mr.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
    mr.onstop = () => {
      mr.onstop = null; clearInterval(r.timer); stream.getTracks().forEach((x) => x.stop()); recRef.current = null; setRec(null);
      const secs = Math.min(MAX_AUDIO, (Date.now() - r.start) / 1000);
      if (!r.keep || secs < 0.5 || !r.chunks.length) return;
      const type = (mr.mimeType || mime || 'audio/webm').split(';')[0]; const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      addFiles([new File(r.chunks, `audio-message.${ext}`, { type })], secs);
    };
    r.timer = setInterval(() => { const s = (Date.now() - r.start) / 1000; setRec({ secs: s }); if (s >= MAX_AUDIO) stopRec(true); }, 200);
    recRef.current = r; mr.start(250); setRec({ secs: 0 });
  };
  useEffect(() => () => stopRec(false), [chId]);   // leaving the channel throws a recording away

  /* ---- Orbit's commands (when this server has Orbit): run by the server; replies meant only for you appear here and nowhere else ---- */
  const runOrbit = async (name, arg) => {
    if (name === 'settings') { if (mayUseOrbit(server, orbitCommand('settings'))) openModal('orbit-settings', { serverId: server.id }); else orbitSays(chId, server, '❌ You can’t change Orbit’s settings here.'); return; }
    try { const r = await api.post(`/channels/${chId}/command`, { name, args: encodeMentions(arg, ch) }); if (r?.ephemeral) orbitSays(chId, server, r.ephemeral); }
    catch (e) { orbitSays(chId, server, `❌ ${e.message}`); }
  };

  /* ---- sending ---- */
  const submit = async () => {
    if (!canSend || !ch) return;
    let v = text.replace(/\s+$/, '');
    const ready = atts.filter((a) => a.status !== 'error');
    if (!v.trim() && !ready.length && !media) return;
    // slash commands
    const cm = /^\/([a-z0-9]+)(?:\s+([\s\S]*))?$/i.exec(v);
    if (cm && orbitOn && orbitCommand(cm[1]) && !COMMANDS.some((c) => c.name === cm[1].toLowerCase())) {
      setText(''); drafts.delete(chId); setAc(null); await runOrbit(cm[1].toLowerCase(), (cm[2] || '').trim()); return;
    }
    if (cm && COMMANDS.some((c) => c.name === cm[1].toLowerCase())) {
      const cmd = cm[1].toLowerCase(); const arg = (cm[2] || '').trim();
      if (cmd === 'shrug') v = `${arg} ¯\\_(ツ)_/¯`.trim();
      else if (cmd === 'tableflip') v = `${arg} (╯°□°）╯︵ ┻━┻`.trim();
      else if (cmd === 'unflip') v = `${arg} ┬─┬ ノ( ゜-゜ノ)`.trim();
      else if (cmd === 'me') { if (!arg) return; v = `_${arg}_`; }
      else if (cmd === 'spoiler') { if (!arg) return; v = `||${arg}||`; }
      else if (cmd === 'poll') { setText(''); openModal('create-poll', { channelId: chId }); return; }
      else if (cmd === 'cloak') { setText(''); drafts.delete(chId); if (cloakAsDesmos() === 'blocked') toast('Your browser blocked the new tab. Allow pop-ups for this site and type /cloak again.', 'error', 6000); else toast('Opened in about:blank as Desmos', 'success', 2200); return; }
      else if (cmd === 'theme') { setText(''); await shareTheme(chId, arg); return; }
      else if (cmd === 'gif') { if (!canGif) { toast('You don’t have permission to send GIFs or stickers here', 'error'); return; } setText(''); const el = document.querySelector('.emoji-btn'); openPickerFor(el, 'gif', arg); return; }
      else if (cmd === 'nick') { if (!server) { toast('Nicknames only work in servers', 'error'); return; } setText(''); await act(api.patch(`/servers/${server.id}/members/${state.me.id}`, { nick: arg }), { success: arg ? 'Nickname updated' : 'Nickname cleared' }); return; }
    }
    v = encodeMentions(v.replace(/:([a-z0-9_+-]+):/gi, (all, code) => (customToken(code, server?.id) ? all : shortcodeEmoji(code.toLowerCase()) || all)), ch);
    const pending = ready.filter((a) => a.status === 'uploading');
    const attachments = ready.map((a) => ({ id: a.id, url: a.preview || a.result?.url, name: a.name, size: a.size, type: a.type, width: a.width, height: a.height, spoiler: a.spoiler, voice: a.voice, duration: a.duration }));
    const wait = pending.length || ready.length ? async () => {
      const done = await Promise.all(ready.map((a) => a.promise));
      return done.map((r, i) => ({ ...r, type: ready[i].voice ? ready[i].type : r.type, width: ready[i].width, height: ready[i].height, spoiler: ready[i].spoiler, voice: ready[i].voice, duration: ready[i].duration, name: ready[i].spoiler && !/^SPOILER_/i.test(r.name) ? 'SPOILER_' + r.name : r.name }));
    } : null;
    const reply = replyTo; const doPing = ping; const m = media;
    setText(''); setAtts([]); setMedia(null); setAc(null); drafts.delete(chId); set({ replyTo: null });
    fx.send();
    await sendMessage(ch, { content: v, attachments, gif: m?.kind === 'gif' ? m.data : null, sticker: m?.kind === 'sticker' ? m.data : null, replyTo: reply, replyPing: doPing, wait });
  };

  /* ---- autocomplete ---- */
  const computeAc = (value, caret) => {
    const trig = getTrigger(value, caret); if (!trig) { setAc(null); return; }
    let items = [];
    const q = trig.query.toLowerCase();
    if (trig.kind === '@') {
      const ids = server ? server.members.map((m) => m.id) : (ch.recipients || []);
      const people = ids.map((id) => { const u = state.users[id]; const nick = server?.members.find((m) => m.id === id)?.nick; return u && { type: 'user', id, label: nick || u.displayName, sub: '@' + u.username, insert: '@' + u.username + ' ', user: u, rank: u.username.startsWith(q) || (nick || u.displayName).toLowerCase().startsWith(q) ? 0 : 1, hit: u.username.includes(q) || (nick || u.displayName).toLowerCase().includes(q) }; }).filter((x) => x && x.hit && x.id !== state.me.id);
      people.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
      items = people.slice(0, 7);
      if (server) {
        const roles = server.roles.filter((r) => r.id !== server.id && r.name.toLowerCase().includes(q)).slice(0, 3).map((r) => ({ type: 'role', id: r.id, label: r.name, sub: 'Role', color: r.color, insert: '@' + r.name + ' ' }));
        const evr = ['everyone', 'here'].filter((x) => x.startsWith(q) && hasChannelPerm(ch, 'MENTION_EVERYONE')).map((x) => ({ type: 'special', id: x, label: '@' + x, sub: x === 'everyone' ? 'Notify everyone' : 'Notify online members', insert: '@' + x + ' ' }));
        items = [...items, ...roles, ...evr].slice(0, 9);
      }
    } else if (trig.kind === '#' && server) {
      items = server.channels.filter((c) => c.type !== 'category' && c.name.toLowerCase().includes(q)).slice(0, 8).map((c) => ({ type: 'channel', id: c.id, label: c.name, sub: c.type === 'voice' ? 'Voice' : c.type === 'stage' ? 'Stage' : server.name, insert: '#' + c.name + ' ', icon: c.type === 'voice' ? 'volume' : c.type === 'stage' ? 'stage' : 'hash' }));
    } else if (trig.kind === ':') {
      const cust = allCustomEmojis().filter((e) => e.name.toLowerCase().includes(q)).sort((a, b) => (b.serverId === server?.id) - (a.serverId === server?.id)).slice(0, 5).map((e) => ({ type: 'cemoji', id: e.id, label: `:${e.name}:`, sub: e.serverName, insert: emojiText(e, server?.id) + ' ', emoji: e }));
      items = [...cust, ...searchEmoji(q, 8).map((e) => ({ type: 'emoji', id: e.char, label: `:${e.code || e.label}:`, sub: '', insert: e.char + ' ', char: e.char }))].slice(0, 8);
    } else if (trig.kind === '/') {
      items = COMMANDS.filter((c) => c.name.startsWith(q) && (!c.server || server)).map((c) => ({ type: 'cmd', id: c.name, label: '/' + c.name, sub: c.desc, insert: '/' + c.name + ' ' }));
      if (orbitOn) items = [...ORBIT_COMMANDS.filter((c) => c.name.startsWith(q) && mayUseOrbit(server, c) && !COMMANDS.some((x) => x.name === c.name)).map((c) => ({ type: 'cmd', id: 'orbit-' + c.name, label: '/' + c.name, sub: c.arg ? `${c.desc} · ${c.arg}` : c.desc, insert: '/' + c.name + ' ', icon: 'sparkles' })), ...items];   // this server's Orbit first
    }
    if (!items.length) { setAc(null); return; }
    setAc({ items, trig }); setAcIdx(0);
  };
  const pick = (it) => {
    const el = ta.current; const caret = el.selectionStart; const trig = ac.trig;
    const next = text.slice(0, trig.start) + it.insert + text.slice(caret); setText(next); setAc(null);
    if (it.type === 'emoji') noteEmojiUse(it.char);
    requestAnimationFrame(() => { el.focus(); const p = trig.start + it.insert.length; el.setSelectionRange(p, p); });
  };

  const typingPing = useRef(throttle(() => sendTyping(chId), 3000)).current;
  const onInput = (e) => {
    let v = e.target.value; const caret = e.target.selectionStart;
    // finished :shortcode: → emoji (a server's own emoji keeps reading :name: until the message is sent)
    const sm = /(^|[\s(]):([a-z0-9_+-]{2,32}):$/i.exec(v.slice(0, caret));
    if (sm) { const ch2 = customToken(sm[2], server?.id) ? null : shortcodeEmoji(sm[2].toLowerCase()); if (ch2) { const start = caret - sm[2].length - 2; v = v.slice(0, start) + ch2 + v.slice(caret); setText(v); noteEmojiUse(ch2); requestAnimationFrame(() => ta.current?.setSelectionRange(start + ch2.length, start + ch2.length)); setAc(null); return; } }
    setText(v); computeAc(v, caret);
    if (v.trim() && !v.startsWith('/')) typingPing();
  };
  const wrap = (before, after = before) => {
    const el = ta.current; const a = el.selectionStart; const b = el.selectionEnd; const sel = text.slice(a, b);
    const next = text.slice(0, a) + before + sel + after + text.slice(b); setText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + before.length, b + before.length); });
  };
  const onKeyDown = (e) => {
    if (e.isComposing) return;
    if (ac) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAcIdx((acIdx + 1) % ac.items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAcIdx((acIdx - 1 + ac.items.length) % ac.items.length); return; }
      // a command with nothing to fill in (/cloak) runs as soon as it is typed out; otherwise Enter completes the highlighted suggestion
      if (e.key === 'Enter' && !e.shiftKey && ac.trig.kind === '/' && (COMMANDS.some((c) => c.noArg && text.trim().toLowerCase() === '/' + c.name) || (orbitOn && orbitCommand(text.trim().slice(1)) && !orbitCommand(text.trim().slice(1)).arg))) { e.preventDefault(); setAc(null); submit(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(ac.items[acIdx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setAc(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape') { if (replyTo) { set({ replyTo: null }); e.preventDefault(); } return; }
    if (e.key === 'ArrowUp' && !text && !atts.length) {
      const last = [...(getEntry(chId).list)].reverse().find((m) => m.authorId === state.me.id && (!m.type || m.type === 'default') && !m.pending);
      if (last) { e.preventDefault(); set({ editing: last.id }); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      if (e.key === 'b') { e.preventDefault(); wrap('**'); } else if (e.key === 'i') { e.preventDefault(); wrap('*'); } else if (e.key === 'u') { e.preventDefault(); wrap('__'); }
    }
  };
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files.map((f) => (f.name === 'image.png' ? new File([f], `pasted-${Date.now()}.png`, { type: f.type }) : f))); }
  };
  // drag & drop anywhere on the chat column
  useEffect(() => {
    const root = document.querySelector('.chat-col'); if (!root) return undefined;
    const has = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => { if (!has(e)) return; e.preventDefault(); dragDepth.current++; setDrag(true); };
    const over = (e) => { if (has(e)) e.preventDefault(); };
    const leave = (e) => { if (!has(e)) return; dragDepth.current--; if (dragDepth.current <= 0) { dragDepth.current = 0; setDrag(false); } };
    const drop = (e) => { if (!has(e)) return; e.preventDefault(); dragDepth.current = 0; setDrag(false); addFiles(e.dataTransfer.files); };
    root.addEventListener('dragenter', enter); root.addEventListener('dragover', over); root.addEventListener('dragleave', leave); root.addEventListener('drop', drop);
    return () => { root.removeEventListener('dragenter', enter); root.removeEventListener('dragover', over); root.removeEventListener('dragleave', leave); root.removeEventListener('drop', drop); };
  }, [chId, atts.length, canAttach]);

  if (!ch) return null;
  const placeholder = ch.type === 'post' ? `${t('Reply to')} “${ch.name}”` : ch.serverId ? `${t('Message')} #${ch.name}` : `${t('Message')} ${ch.type === 'group' ? dmName(ch) : '@' + (getUser(dmUserId(ch))?.displayName || '')}`;
  const hasContent = text.trim() || atts.length || media;
  // picking a GIF or sticker only stages it in the message box (like an upload); the person presses send
  const stageGif = (item) => setMedia({ kind: 'gif', title: item.title || 'GIF', preview: item.preview, data: { id: item.id, title: item.title, url: item.full.mp4 || item.full.gif || item.full.webp, mp4: item.full.mp4, gif: item.full.gif, poster: item.full.poster, w: item.w, h: item.h } });
  const stageSticker = (item) => item.custom ? setMedia({ kind: 'sticker', title: item.title, preview: item.preview, data: { custom: item.custom } }) : setMedia({ kind: 'sticker', title: item.title || 'Sticker', preview: item.preview, data: { id: item.id, title: item.title, url: item.full.url, webp: item.full.webp, gif: item.full.gif, png: item.full.png, w: item.w, h: item.h } });
  const handlers = { onEmoji: (c, e) => { const tok = c.startsWith('<'); const nm = tok && /^<a?:(\w+):\d+>$/.exec(c); composerApi.insert(tok ? (nm && customToken(nm[1], server?.id) === c ? `:${nm[1]}:` : c) + ' ' : c); if (!tok) noteEmojiUse(c); if (!e?.shiftKey) closePopover(); }, onGif: (i) => { closePopover(); stageGif(i); ta.current?.focus(); }, onSticker: (i) => { closePopover(); stageSticker(i); ta.current?.focus(); } };
  const openPickerFor = (anchor, tab, query) => openPicker(anchor || ta.current, handlers, { tab, query, placement: 'top-end', emojiOnly: !canGif });   // without the GIFs & stickers permission the picker is just emoji

  if (blockedBy) return html`<div class="composer-wrap"><div class="composer-notice"><${Icon} name="ban" size=${18} /> You have blocked this user. <button type="button" class="link-btn" onClick=${() => act(api.del(`/relationships/${dmUserId(ch)}`))}>Unblock</button></div></div>`;
  if (!canSend) return html`<div class="composer-wrap"><div class="composer-notice"><${Icon} name=${timedOut ? 'clock' : 'lock'} size=${18} /> ${lockedPost ? t('This post is locked.') : timedOut ? `${t('You are timed out until')} ${new Date(timeoutUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : t('You do not have permission to send messages in this channel.')}</div></div>`;

  return html`<div class="composer-wrap" ref=${dropdownRef}>
    ${drag ? html`<div class="drop-overlay"><div class="drop-card"><${Icon} name="upload" size=${48} sw=${1.6} /><h3>${t('Upload to')} ${ch.serverId ? '#' + ch.name : dmName(ch)}</h3><p>${t('You can add comments before uploading.')}</p></div></div>` : null}
    ${ac ? html`<div class="autocomplete pop-in" role="listbox">
      <div class="ac-head">${ac.trig.kind === '@' ? t('Members') : ac.trig.kind === '#' ? t('Channels') : ac.trig.kind === ':' ? t('Emoji matching') + ' :' + ac.trig.query : t('Commands')}</div>
      ${ac.items.map((it, i) => html`<button type="button" class=${cx('ac-item', i === acIdx && 'sel')} onMouseEnter=${() => setAcIdx(i)} onMouseDown=${(e) => { e.preventDefault(); pick(it); }} role="option">
        ${it.type === 'user' ? html`<${Avatar} user=${it.user} size=${24} />` : it.type === 'cemoji' ? html`<img class="ac-cemoji" src=${it.emoji.url} alt="" />` : it.type === 'emoji' ? html`<span class="ac-emoji">${it.char}</span>` : it.type === 'role' ? html`<span class="ac-role" style=${{ background: it.color || 'var(--accent)' }}></span>` : html`<${Icon} name=${it.icon || (it.type === 'cmd' ? 'bolt' : 'at')} size=${18} />`}
        <span class="ac-label" style=${it.color ? { color: it.color } : null}>${it.label}</span><span class="ac-sub">${it.sub}</span></button>`)}
    </div>` : null}
    ${replyTo ? html`<div class="reply-bar slide-up"><span>${t('Replying to')} <b>${replyName || '…'}</b></span><span class="reply-ctl"><button type="button" class=${cx('ping-toggle', ping && 'on')} onClick=${() => setPing(!ping)} data-tip=${ping ? 'Mention on' : 'Mention off'}><${Icon} name="at" size=${14} sw=${2.4} />${ping ? 'ON' : 'OFF'}</button><button type="button" class="icon-btn" onClick=${() => set({ replyTo: null })} aria-label="Cancel reply"><${Icon} name="x" size=${15} /></button></span></div>` : null}
    <div class=${cx('composer glass glass-composer', replyTo && 'has-reply')}>
      ${atts.length || media ? html`<div class="att-tray">
        ${media ? html`<div class="att-chip done media-chip" key="media">
          <div class="att-thumb"><img src=${media.preview?.url} alt="" /><span class="media-badge">${media.kind === 'gif' ? 'GIF' : t('Sticker')}</span></div>
          <div class="att-meta" title=${media.title}>${media.title}</div>
          <div class="att-acts"><button type="button" class="del" data-tip=${t('Remove')} aria-label="Remove" onClick=${() => setMedia(null)}><${Icon} name="trash" size=${15} /></button></div></div>` : null}
        ${atts.map((a) => html`<div class=${cx('att-chip', a.status)} key=${a.id}>
        <div class="att-thumb">${a.preview && a.type.startsWith('image/') ? html`<img src=${a.preview} alt="" class=${a.spoiler ? 'blur' : ''} />` : a.preview ? html`<video src=${a.preview} muted></video>` : html`<${Icon} name=${a.voice ? 'mic' : 'file'} size=${34} sw=${1.5} />`}
          ${a.status === 'uploading' ? html`<div class="att-prog"><i style=${{ width: a.progress * 100 + '%' }}></i></div>` : null}${a.status === 'error' ? html`<div class="att-err"><${Icon} name="alert-circle" size=${22} /></div>` : null}</div>
        <div class="att-meta" title=${a.name}>${a.voice ? `${t('Audio message')} · ${clock(a.duration)}` : a.name}</div>
        <div class="att-acts"><button type="button" data-tip=${a.spoiler ? 'Unmark spoiler' : 'Mark as spoiler'} onClick=${() => setAtts((cur) => cur.map((x) => (x.id === a.id ? { ...x, spoiler: !x.spoiler } : x)))} class=${a.spoiler ? 'on' : ''}><${Icon} name="eye-off" size=${15} /></button><button type="button" class="del" data-tip="Remove" onClick=${() => removeAtt(a)}><${Icon} name="trash" size=${15} /></button></div></div>`)}</div>` : null}
      ${rec ? html`<div class="composer-row rec-row" role="status">
        <span class="rec-dot"></span><span class="rec-time">${clock(rec.secs)} <small>/ 3:00</small></span><span class="rec-label">${t('Recording an audio message…')}</span>
        <div class="comp-right"><button type="button" class="comp-btn" data-tip=${t('Throw it away')} data-tip-pos="top" aria-label=${t('Throw the recording away')} onClick=${() => stopRec(false)}><${Icon} name="trash" size=${20} /></button>
          <button type="button" class="comp-btn send ready" data-tip=${t('Done')} data-tip-pos="top" aria-label=${t('Stop recording')} onClick=${() => stopRec(true)}><${Icon} name="check" size=${20} sw=${2.6} /></button></div>
      </div>` : null}
      <div class="composer-row" hidden=${!!rec}>
        <button type="button" class="comp-btn plus" data-tip=${t('Upload a File')} data-tip-pos="top" aria-label="Upload a file" onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); openContext({ clientX: r.left, clientY: r.top - 4 }, [{ label: t('Upload a File'), icon: 'upload', onClick: () => file.current?.click(), disabled: !canAttach }, { label: t('Create Poll'), icon: 'bar-chart', onClick: () => openModal('create-poll', { channelId: chId }) }]); }}><${Icon} name="plus" size=${22} sw=${2.4} /></button>
        <input type="file" multiple hidden ref=${file} onChange=${(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <textarea ref=${ta} class="composer-input" rows="1" value=${text} placeholder=${placeholder} maxlength="4000" spellcheck="true" aria-label=${placeholder} onInput=${onInput} onKeyDown=${onKeyDown} onPaste=${onPaste} onBlur=${() => setTimeout(() => setAc(null), 120)} onClick=${(e) => computeAc(text, e.target.selectionStart)}></textarea>
        <div class="comp-right">
          ${canGif ? html`<button type="button" class="comp-btn gif-btn" data-tip="GIF" data-tip-pos="top" aria-label="Open GIF picker" onClick=${(e) => openPickerFor(e.currentTarget, 'gif')}><span>GIF</span></button>` : null}
          ${canGif ? html`<button type="button" class="comp-btn hide-sm" data-tip="Stickers" data-tip-pos="top" aria-label="Open sticker picker" onClick=${(e) => openPickerFor(e.currentTarget, 'stickers')}><${Icon} name="sticker" size=${22} /></button>` : null}
          <button type="button" class="comp-btn emoji-btn" data-tip="Emoji" data-tip-pos="top" aria-label="Open emoji picker" onClick=${(e) => openPickerFor(e.currentTarget, 'emoji')} onMouseEnter=${(e) => e.currentTarget.classList.add('wiggle')} onMouseLeave=${(e) => e.currentTarget.classList.remove('wiggle')}><${Icon} name="smile" size=${22} /></button>
          ${canAttach ? html`<button type="button" class="comp-btn mic-btn" data-tip=${t('Record an audio message')} data-tip-pos="top" aria-label=${t('Record an audio message')} onClick=${startRec}><${Icon} name="mic" size=${21} /></button>` : null}
          <button type="button" class=${cx('comp-btn send', hasContent && 'ready')} data-tip=${t('Send')} data-tip-pos="top" aria-label="Send message" onClick=${submit}><${Icon} name="send" size=${20} /></button>
        </div>
      </div>
    </div>
    <${TypingBar} chId=${chId} />
  </div>`;
}
void Spinner; void IconBtn; void openContext; void openPopover; void decodeMentions; void useMemo;
