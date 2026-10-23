// Orata — slash commands. One list says what every command is: its name, what it does, an icon, who may use it, its arguments (name, type, optional,
// suggestions, limits) and what runs it. The message box builds everything from it: the "/" suggestions and, once a command is picked, its argument boxes
// (/timeout [member] [duration] [reason]) with suggestions above, mistakes said under the box at fault, Tab between boxes and Enter to run.
// Orbit's commands are described in orbit-commands.js (shared with the server, which parses and checks what it is sent again); the music ones act on your
// own player. Typing a command out by hand still works.
import { html, useState, useEffect, useRef, cx } from '/js/lib.js';
import { state, toast, openModal } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar } from '/js/ui.js';
import { api } from '/js/api.js';
import { act, errMsg, sendMessage } from '/js/actions.js';
import { encodeMentions } from '/js/markdown.js';
import { t } from '/js/i18n.js';
import { shareTheme } from '/js/theme-card.js';
import { cloakAsDesmos } from '/js/cloak.js';
import { ORBIT_COMMANDS, parseDuration, formatDuration } from '/js/orbit-commands.js';
import { mayUseOrbit, orbitSays } from '/js/orbit.js';

const player = () => import('/js/music.js'); const library = () => import('/js/music-pages.js');   // loaded the first time a music command needs them
const lengthOf = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} ${t('hr')} ${m % 60} ${t('min')}` : `${m} ${t('min')}`; };
const clockOf = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ argument types
 * A box holds { text } while typed and { text, value } once a suggestion is picked. `pick`: the value must come from the suggestions.
 * suggest(ctx, query, arg, values) → [{ text, value, label, sub, user?, cover? }]; check(box, arg, ctx) → a mistake or null; out(box) → what Orbit is sent. */
export const TYPES = {
  user: {
    pick: true,
    suggest(ctx, q) {
      const ids = ctx.server ? ctx.server.members.map((m) => m.id) : ctx.ch.recipients || [];
      return ids.map((id) => { const u = state.users[id]; if (!u || u.bot) return null; const nick = ctx.server?.members.find((m) => m.id === id)?.nick; const name = nick || u.displayName; return { text: name, value: id, label: name, sub: '@' + u.username, user: u, hit: !q || u.username.toLowerCase().includes(q) || name.toLowerCase().includes(q), first: u.username.toLowerCase().startsWith(q) || name.toLowerCase().startsWith(q) }; })
        .filter((x) => x?.hit).sort((a, b) => Number(b.first) - Number(a.first) || a.label.localeCompare(b.label));
    },
    check: (b) => (b.value ? null : t('Pick someone from the list')),
    out: (b) => `<@${b.value}>`,
  },
  duration: {
    suggest: (ctx, q, arg) => (arg.choices || ['10m', '1h', '1d', '1w']).filter((x) => !q || x.startsWith(q)).map((x) => ({ text: x, value: x, label: x, sub: x === 'off' ? t('Turn it off') : formatDuration(parseDuration(x)) })),
    check(b, arg) {
      const v = b.text.trim().toLowerCase(); if (arg.off && v === 'off') return null;
      const ms = parseDuration(v); if (!ms) return t('Use a number with s, m, h, d or w, like 10m');
      if (arg.min && ms < arg.min) return `${t('At least')} ${formatDuration(arg.min)}`;
      if (arg.max && ms > arg.max) return `${t('At most')} ${formatDuration(arg.max)}`;
      return null;
    },
    out: (b) => b.text.trim().toLowerCase(),
  },
  number: {
    suggest: (ctx, q, arg) => (arg.choices || []).filter((x) => !q || x.startsWith(q)).map((x) => ({ text: x, value: x, label: x })),
    check(b, arg) { const n = Number(b.text.trim()); if (!Number.isInteger(n)) return t('Type a whole number'); if (arg.min !== undefined && n < arg.min || arg.max !== undefined && n > arg.max) return `${t('From')} ${arg.min} ${t('to')} ${arg.max}`; return null; },
    out: (b) => b.text.trim(),
  },
  text: { check: () => null, out: (b) => b.text.trim() },
  choice: {
    pick: true,
    suggest: (ctx, q, arg) => arg.choices.filter((c) => !q || c.label.toLowerCase().includes(q)).map((c) => ({ text: c.label, value: c.value, label: c.label, sub: c.sub })),
    check: (b) => (b.value !== undefined ? null : t('Pick one from the list')),
    out: (b) => b.value,
  },
  playlist: {
    pick: true,
    async suggest(ctx, q) {
      const lists = (await (await library()).ensurePlaylists()) || [];
      return lists.filter((p) => !q || p.name.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt)
        .map((p) => ({ text: p.name, value: p.id, label: p.name, sub: [`${p.count} ${p.count === 1 ? t('song') : t('songs')}`, p.duration ? lengthOf(p.duration) : null].filter(Boolean).join(' · '), covers: p.covers, empty: !p.count }));
    },
    check: (b) => (b.value ? null : t('Pick one of your playlists')),
    empty: () => t('You have no playlists yet. Make one on the Music page.'),
  },
  song: {
    pick: true,
    async suggest(ctx, q) {
      if (q.length < 2) return [];
      await sleep(300); if (ctx.query() !== q) return null;   // waits until typing stops (a newer query replaces this one)
      const r = await api.get(`/music/search?q=${encodeURIComponent(q)}&limit=8`).catch(() => null);
      return (r?.tracks || []).map((s) => ({ text: s.title, value: s, label: s.title, sub: `${s.artist}${s.duration ? ` · ${clockOf(s.duration)}` : ''}`, cover: s.artwork }));
    },
    check: (b) => (b.value ? null : t('Search, then pick a song from the list')),
    empty: (q) => (q.length < 2 ? t('Type the song’s name') : t('No songs found')),
  },
  playlistSong: {   // a song of the playlist picked in the box named `arg.from`
    pick: true,
    async suggest(ctx, q, arg, values) {
      const pid = values[arg.from]?.value; if (!pid) return [];
      const r = await api.get(`/me/playlists/${pid}`).catch(() => null);
      return (r?.playlist.tracks || []).filter((s) => !q || `${s.title} ${s.artist}`.toLowerCase().includes(q)).map((s) => ({ text: s.title, value: s.id, label: s.title, sub: s.artist, cover: s.artwork }));
    },
    check: (b) => (b.value ? null : t('Pick a song from the playlist')),
    empty: (q, arg, values) => (values[arg.from]?.value ? t('No song in that playlist matches') : t('Pick the playlist first')),
  },
};

/* ------------------------------------------------------------------ the commands */
const BUILT_IN = [
  { name: 'shrug', desc: 'Appends ¯\\_(ツ)_/¯ to your message', icon: 'smile', args: [{ name: 'message', type: 'text', optional: true }], run: (ctx, v) => ctx.send(`${v.message} ¯\\_(ツ)_/¯`.trim()) },
  { name: 'tableflip', desc: 'Appends (╯°□°）╯︵ ┻━┻ to your message', icon: 'smile', args: [{ name: 'message', type: 'text', optional: true }], run: (ctx, v) => ctx.send(`${v.message} (╯°□°）╯︵ ┻━┻`.trim()) },
  { name: 'unflip', desc: 'Appends ┬─┬ ノ( ゜-゜ノ) to your message', icon: 'smile', args: [{ name: 'message', type: 'text', optional: true }], run: (ctx, v) => ctx.send(`${v.message} ┬─┬ ノ( ゜-゜ノ)`.trim()) },
  { name: 'me', desc: 'Show action text in italics', icon: 'type', args: [{ name: 'action', type: 'text' }], run: (ctx, v) => ctx.send(`_${v.action}_`) },
  { name: 'spoiler', desc: 'Hide your message behind a spoiler', icon: 'eye-off', args: [{ name: 'message', type: 'text' }], run: (ctx, v) => ctx.send(`||${v.message}||`) },
  { name: 'gif', desc: 'Search for a GIF', icon: 'image', args: [{ name: 'query', type: 'text', optional: true }], when: (ctx) => ctx.canGif, run: (ctx, v) => ctx.openGif(v.query) },
  { name: 'poll', desc: 'Ask everybody a question', icon: 'bar-chart', run: (ctx) => openModal('create-poll', { channelId: ctx.chId }) },
  { name: 'theme', desc: 'Share your theme so others can try it', icon: 'palette', args: [{ name: 'name', type: 'text', optional: true }], run: (ctx, v) => shareTheme(ctx.chId, v.name) },
  { name: 'cloak', desc: 'Open Orata in about:blank, disguised as Desmos', icon: 'eye-off', run: () => { if (cloakAsDesmos() === 'blocked') toast(t('Your browser blocked the new tab. Allow pop-ups for this site and type /cloak again.'), 'error', 6000); else toast(t('Opened in about:blank as Desmos'), 'success', 2200); } },
  { name: 'nick', desc: 'Change your nickname in this server', icon: 'edit', when: (ctx) => !!ctx.server, args: [{ name: 'name', type: 'text', optional: true, placeholder: t('empty clears it') }], run: (ctx, v) => act(api.patch(`/servers/${ctx.server.id}/members/${state.me.id}`, { nick: v.name }), { success: v.name ? t('Nickname updated') : t('Nickname cleared') }) },
];
const musicOn = () => state.musicOk !== false;
const queueText = (m) => { const next = m.queue.slice(m.index + 1, m.index + 11); return next.length ? next.map((s, i) => `${i + 1}. **${s.title}** — ${s.artist}`).join('\n') + (m.queue.length - m.index - 1 > next.length ? `\n…and ${m.queue.length - m.index - 1 - next.length} more` : '') : t('Nothing is lined up after this song.'); };
const MUSIC = [
  { name: 'play', desc: 'Search for a song and play it', icon: 'play', args: [{ name: 'song', type: 'song' }], run: async (ctx, v) => { (await player()).music.play(v.song); ctx.say(`▶️ ${t('Playing')} **${v.song.title}** — ${v.song.artist}`); } },
  { name: 'shuffle', desc: 'Turn playlist shuffle on or off', icon: 'shuffle', run: async (ctx) => { const { music } = await player(); const on = state.music.shuffle === 'off'; await music.setShuffle(on ? 'playlist' : 'off'); ctx.say(on ? `🔀 ${t('Shuffle is on.')}` : `➡️ ${t('Shuffle is off: songs play in order.')}`); } },
  { name: 'queue', desc: 'See what plays next', icon: 'list-music', run: (ctx) => { const m = state.music; ctx.say(m.track ? `🎶 **${t('Now')}:** ${m.track.title} — ${m.track.artist}\n**${t('Up next')}:**\n${queueText(m)}` : t('Nothing is playing. Try /play.')); } },
  { name: 'skip', desc: 'Skip to the next song', icon: 'skip-forward', run: async (ctx) => { if (!state.music.track) return ctx.say(t('Nothing is playing.')); (await player()).music.next(); } },
  { name: 'pause', desc: 'Pause the music', icon: 'pause', run: async (ctx) => { if (!state.music.track) return ctx.say(t('Nothing is playing.')); (await player()).music.pause(); } },
  { name: 'resume', desc: 'Carry on playing', icon: 'play', run: async (ctx) => { if (!state.music.track) return ctx.say(t('Nothing to resume. Try /play.')); (await player()).music.resume(); } },
  { name: 'nowplaying', desc: 'What’s playing right now', icon: 'music', run: (ctx) => { const m = state.music; ctx.say(m.track ? `🎵 **${m.track.title}** — ${m.track.artist} (${clockOf(m.position * 1000)} / ${clockOf((m.duration || 0) * 1000)})${m.playing ? '' : ` · ${t('paused')}`}` : t('Nothing is playing.')); } },
  { name: 'song', desc: 'Share a song here', icon: 'music', args: [{ name: 'song', type: 'song' }], run: (ctx, v) => api.post(`/channels/${ctx.chId}/messages`, { song: { id: v.song.id } }) },
  { name: 'playlist', desc: 'Share one of your playlists here', icon: 'list-music', args: [{ name: 'playlist', type: 'playlist' }], run: (ctx, v) => api.post(`/channels/${ctx.chId}/messages`, { playlist: { id: v.playlist } }) },
  { name: 'addsong', desc: 'Add a song to one of your playlists', icon: 'plus', args: [{ name: 'song', type: 'song' }, { name: 'playlist', type: 'playlist' }],
    run: async (ctx, v) => { const r = await api.post(`/me/playlists/${v.playlist}/tracks`, { trackId: v.song.id }); (await library()).upsert(r.playlist); ctx.say(r.added ? `➕ ${t('Added')} **${v.song.title}** ${t('to')} **${r.playlist.name}**.` : `**${v.song.title}** ${t('is already in')} **${r.playlist.name}**.`); } },
  { name: 'removefromplaylist', desc: 'Take a song out of one of your playlists', icon: 'x', args: [{ name: 'playlist', type: 'playlist' }, { name: 'song', type: 'playlistSong', from: 'playlist' }],
    run: async (ctx, v, boxes) => { const r = await api.del(`/me/playlists/${v.playlist}/tracks/${encodeURIComponent(v.song)}`); (await library()).upsert(r.playlist); ctx.say(`➖ ${t('Took')} **${boxes.song.text}** ${t('out of')} **${r.playlist.name}**.`); } },
].map((c) => ({ ...c, when: musicOn }));

/** Orbit's commands (orbit-commands.js) as boxes; what is typed goes to the server as text, in the order it reads it. */
const orbitDef = (c) => ({
  ...c, orbit: true, icon: 'sparkles',
  args: c.args || (c.arg ? [{ name: 'options', type: 'text', optional: /^\[/.test(c.arg), placeholder: c.arg }] : []),
  when: (ctx) => mayUseOrbit(ctx.server, c) && (!c.discord || state.discordOk),
  run: (ctx, v, boxes, text) => ctx.orbit(c.name, text),
});

/** The commands `ctx` (this channel) may use, Orbit's first; a built-in one hides an Orbit one with the same name. */
export function commandsFor(ctx) {
  const own = [...BUILT_IN, ...MUSIC].filter((c) => !c.when || c.when(ctx));
  const orbit = ctx.server?.orbitId ? ORBIT_COMMANDS.filter((c) => !own.some((x) => x.name === c.name)).map(orbitDef).filter((c) => c.when(ctx)) : [];
  return [...orbit, ...own].map((c) => ({ args: [], ...c }));
}
export const findCommand = (ctx, name) => commandsFor(ctx).find((c) => c.name === name) || null;
/** "[member] [duration] [reason]" — what a command asks for. */
export const argHint = (c) => c.args.map((a) => `[${a.name}${a.optional ? '?' : ''}]`).join(' ');
const blank = (c) => Object.fromEntries(c.args.map((a) => [a.name, { text: '' }]));
/** The boxes as Orbit reads them: in order, the empty optional ones left out. */
const serialize = (c, boxes) => c.args.map((a) => { const b = boxes[a.name]; return b.value === undefined && !b.text.trim() ? '' : (TYPES[a.type].out || TYPES.text.out)(b); }).filter(Boolean).join(' ');
const valuesOf = (c, boxes) => Object.fromEntries(c.args.map((a) => [a.name, boxes[a.name].value !== undefined ? boxes[a.name].value : boxes[a.name].text.trim()]));
const mistake = (a, b, ctx) => (!b.text.trim() && b.value === undefined ? (a.optional ? null : t('Required')) : TYPES[a.type].check?.(b, a, ctx) || null);

/** A command typed out in full ("/me waves") and sent: runs it when its words fill its boxes, else opens the boxes (the words in the first one). Returns 'box' or a promise. */
export function runTyped(c, rest, ctx) {
  if (c.orbit) return c.run(ctx, {}, {}, rest);
  if (!rest) { if (c.args.every((a) => a.optional)) { const boxes = blank(c); return c.run(ctx, valuesOf(c, boxes), boxes, ''); } return 'box'; }
  if (c.args.length === 1 && c.args[0].type === 'text') { const boxes = { [c.args[0].name]: { text: rest } }; return c.run(ctx, valuesOf(c, boxes), boxes, rest); }
  return 'box';
}

/* ------------------------------------------------------------------ the boxes in the message box */
function Suggestions({ list, at, onPick, onHover, head, empty, loading }) {
  return html`<div class="autocomplete cmd-ac pop-in" role="listbox">
    <div class="ac-head">${head}</div>
    ${loading ? html`<div class="ac-empty">${t('Searching…')}</div>` : !list.length ? html`<div class="ac-empty">${empty}</div>` : list.map((s, i) => html`<button type="button" key=${String(s.value?.id ?? s.value) + i} class=${cx('ac-item', i === at && 'sel')} role="option" aria-selected=${i === at} onMouseEnter=${() => onHover(i)} onMouseDown=${(e) => { e.preventDefault(); onPick(s); }}>
      ${s.user ? html`<${Avatar} user=${s.user} size=${24} />` : s.cover ? html`<img class="ac-cover" src=${s.cover.replace('=w400-h400', '=w120-h120')} alt="" referrerpolicy="no-referrer" />` : s.covers ? html`<span class="ac-cover mosaic">${s.covers.length ? html`<img src=${s.covers[0]} alt="" referrerpolicy="no-referrer" />` : html`<${Icon} name="list-music" size=${16} />`}</span>` : html`<${Icon} name="clock" size=${18} />`}
      <span class="ac-label">${s.label}</span>${s.sub ? html`<span class="ac-sub">${s.sub}</span>` : null}</button>`)}
  </div>`;
}

/** The argument boxes of the command being used. `api.run` lets the send button run it; `onDone` after it ran, `onCancel` to go back to typing. */
export function CommandBox({ cmd, ctx, api: box, onDone, onCancel, prefill = '' }) {
  const [boxes, setBoxes] = useState(() => { const b = blank(cmd); if (prefill && cmd.args[0]) b[cmd.args[0].name] = { text: prefill }; return b; });
  const [focus, setFocus] = useState(0); const [told, setTold] = useState({}); const [failed, setFailed] = useState(null);
  const [sugg, setSugg] = useState(null); const [at, setAt] = useState(0); const [open, setOpen] = useState(true); const [busy, setBusy] = useState(false);
  const refs = useRef([]); const run0 = useRef(null);
  const arg = cmd.args[focus]; const type = arg && TYPES[arg.type]; const q = arg ? boxes[arg.name].text.trim().toLowerCase() : '';
  const queryNow = useRef(q); queryNow.current = q;
  useEffect(() => { requestAnimationFrame(() => (refs.current[0] || run0.current)?.focus()); }, []);
  useEffect(() => {   // suggestions for the box being filled in
    let live = true; setAt(0);
    if (!type?.suggest || !open) { setSugg(null); return undefined; }
    if (arg.type === 'song') setSugg('loading');
    Promise.resolve(type.suggest({ ...ctx, query: () => queryNow.current }, q, arg, boxes)).then((list) => { if (live && list) setSugg(list.slice(0, 8)); }, () => live && setSugg([]));
    return () => { live = false; };
  }, [focus, q, open, arg?.from && boxes[arg.from]?.value]);
  const errs = Object.fromEntries(cmd.args.map((a) => [a.name, mistake(a, boxes[a.name], ctx)]));
  const go = (i) => { if (i < 0 || i >= cmd.args.length) return; if (arg) setTold((x) => ({ ...x, [arg.name]: true })); setFocus(i); setOpen(true); requestAnimationFrame(() => refs.current[i]?.focus()); };
  const choose = (s) => { setBoxes((b) => ({ ...b, [arg.name]: { text: s.text, value: s.value } })); setFailed(null); setSugg(null); setOpen(false); if (focus + 1 < cmd.args.length) go(focus + 1); };
  const run = async () => {
    const bad = cmd.args.findIndex((a) => errs[a.name]);
    if (bad >= 0) { setTold(Object.fromEntries(cmd.args.map((a) => [a.name, true]))); go(bad); return; }
    setBusy(true); setFailed(null);
    try { await cmd.run(ctx, valuesOf(cmd, boxes), boxes, serialize(cmd, boxes)); onDone(); }
    catch (e) { setFailed(errMsg(e)); setBusy(false); }   // the server said no (permissions, a member above you…): the boxes stay so it can be fixed
  };
  box.run = run;
  const list = Array.isArray(sugg) ? sugg : [];
  const key = (e, i) => {
    const b = boxes[arg.name]; const needPick = type.pick && b.value === undefined;
    if (list.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setAt((at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (!e.shiftKey && list.length && open && (needPick || !b.text.trim())) return choose(list[at]); go(i + (e.shiftKey ? -1 : 1)); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (list.length && open && (needPick || !b.text.trim())) return choose(list[at]); run(); return; }
    if (e.key === 'Escape') { e.preventDefault(); if (open && type.suggest) setOpen(false); else onCancel(); return; }
    if (e.key === 'Backspace' && !e.target.value) { e.preventDefault(); if (i > 0) go(i - 1); else onCancel(); }
  };
  const width = (a) => `${Math.max((a.placeholder || a.name).length, boxes[a.name].text.length, 4) + 2}ch`;
  return html`<div class="cmd-box">
    ${arg && type.suggest && open && sugg !== null ? html`<${Suggestions} list=${list} at=${at} loading=${sugg === 'loading'} onPick=${choose} onHover=${setAt} head=${html`<b>${arg.name}</b>${arg.optional ? ` · ${t('optional')}` : ''} · /${cmd.name}`} empty=${type.empty ? type.empty(q, arg, boxes) : t('Nothing matches that.')} />` : null}
    <div class="cmd-row">
      <button type="button" class="cmd-chip" data-tip=${cmd.desc} onClick=${onCancel} aria-label=${`${t('Stop using')} /${cmd.name}`}><${Icon} name=${cmd.icon || 'bolt'} size=${14} />/${cmd.name}<${Icon} name="x" size=${12} sw=${3} /></button>
      ${cmd.args.map((a, i) => html`<span class=${cx('cmd-arg', focus === i && 'on', told[a.name] && errs[a.name] && 'bad', boxes[a.name].value !== undefined && 'set')} key=${a.name}>
        <label><span class="cmd-name">${a.name}${a.optional ? '?' : ''}</span>
          <input ref=${(el) => { refs.current[i] = el; }} value=${boxes[a.name].text} style=${{ width: width(a) }} placeholder=${a.placeholder || (a.optional ? t('optional') : '')} aria-label=${a.name} aria-invalid=${!!(told[a.name] && errs[a.name])}
            onFocus=${() => { setFocus(i); setOpen(true); }} onBlur=${() => setTold((x) => ({ ...x, [a.name]: true }))} onKeyDown=${(e) => key(e, i)}
            onInput=${(e) => { const text = e.target.value; setBoxes((b) => ({ ...b, [a.name]: { text } })); setFailed(null); setOpen(true); }} /></label>
        ${told[a.name] && errs[a.name] ? html`<small class="cmd-err">${errs[a.name]}</small>` : null}</span>`)}
      ${cmd.args.length ? null : html`<input ref=${run0} class="cmd-run" readOnly value="" placeholder=${t('Press Enter to run it')} aria-label=${t('Press Enter to run it')} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); onCancel(); } }} />`}
      ${busy ? html`<span class="cmd-busy">${t('Running…')}</span>` : null}
    </div>
    ${failed ? html`<div class="cmd-fail"><${Icon} name="alert-circle" size=${14} /> ${failed}</div>` : null}
  </div>`;
}

/** What commands are told about the place they run in, and can do there. */
export function commandContext({ chId, ch, server, canGif, openGif }) {
  return {
    chId, ch, server, canGif, openGif,
    send: (content) => sendMessage(ch, { content: encodeMentions(content, ch) }),
    say: (content) => orbitSays(chId, { orbitId: server?.orbitId || state.botId }, content),   // only you see it
    async orbit(name, text) {
      if (name === 'settings') return openModal('orbit-settings', { serverId: server.id });
      if (name === 'reactionroles') return openModal('reaction-roles', { channelId: chId });
      const r = await api.post(`/channels/${chId}/command`, { name, args: encodeMentions(text, ch) });
      if (r?.ephemeral) orbitSays(chId, server, r.ephemeral);
    },
  };
}
