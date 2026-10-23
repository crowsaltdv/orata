// Orata — a single chat message (header, markdown body, attachments, GIFs, embeds, reactions, toolbar).
import { html, useState, useEffect, useRef, useMemo, memo, cx, formatStamp, formatClock, formatFull, fileSize, copyText, isImageType, shallowEq } from '/js/lib.js';
import { state, set, useSel, nameOf, roleColor, openContext, openPopover, openModal, toast, getChannel, hasPerm, hasChannelPerm, dmName, goChannel, goDm, go, emojiById } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, IconBtn, ServerIcon, POPOVERS } from '/js/ui.js';
import { renderMarkdown, emojiOnlyCount, plainPreview, decodeMentions } from '/js/markdown.js';
import { toggleReaction, deleteMessage, pinMessage, editMessage, jumpToMessage, openMessage, retryMessage, discardMessage, mapMessage } from '/js/actions.js';
import { openProfile } from '/js/sidebar.js';
import { frequentEmoji } from '/js/emoji.js';
import { api } from '/js/api.js';
import { t } from '/js/i18n.js';
import { UserName } from '/js/profile-style.js';
import { InviteCard, inviteCodeOf } from '/js/invite-card.js';
import { PollView } from '/js/polls.js';
import { ThemeCard } from '/js/theme-card.js';
import { PlaylistCard } from '/js/playlist-card.js';
import { useFavGifs, toggleFavGif, gifFromMessage } from '/js/gif-favs.js';
import { dismissEphemeral } from '/js/orbit.js';
import '/js/forward.js';   // the Forward dialog
import { ServerTag } from '/js/server-tag.js';
import { ApplicationCard } from '/js/applications.js';
import { isStaffMe } from '/js/staff.js';
import { LITE, thumb } from '/js/lite.js';

const JOIN_LINES = ['{name} just joined the party.', '{name} just landed.', 'Welcome, {name}. We hope you brought snacks.', '{name} hopped into the server.', 'A wild {name} appeared.', 'Everyone welcome {name}!', '{name} is here.', 'Glad you\'re here, {name}.'];
const URL_RE = /https?:\/\/[^\s<>()]+/gi;
const IMG_URL = /\.(png|jpe?g|gif|webp|avif|bmp)(\?[^\s]*)?$/i;
const VID_URL = /\.(mp4|webm|mov|m4v)(\?[^\s]*)?$/i;

/* ------------------------------------------------------------------ link embeds */
const unfurlCache = new Map();
function useUnfurl(url, enabled) {
  const [data, setData] = useState(() => unfurlCache.get(url)?.data || null);
  useEffect(() => {
    if (!enabled) return;
    let hit = unfurlCache.get(url);
    if (hit?.data) { setData(hit.data); return; }
    if (!hit) { hit = { promise: api.get(`/unfurl?url=${encodeURIComponent(url)}`).catch(() => ({ type: 'none' })) }; unfurlCache.set(url, hit); }
    hit.promise.then((d) => { hit.data = d; setData(d); });
  }, [url, enabled]);
  return data;
}
function LinkEmbed({ url, onImage }) {
  const isImg = IMG_URL.test(url); const isVid = VID_URL.test(url);
  const data = useUnfurl(url, !isImg && !isVid);
  const [play, setPlay] = useState(false);
  if (isImg) return html`<div class="att-img-wrap"><img class="att-img" src=${url} alt="" loading="lazy" referrerpolicy="no-referrer" onClick=${() => onImage({ url, name: 'image' })} onError=${(e) => (e.target.closest('.att-img-wrap').style.display = 'none')} /></div>`;
  if (isVid) return html`<video class="att-video" src=${url} controls preload="metadata"></video>`;
  if (!data || data.type === 'none') return null;
  if (data.type === 'image') return html`<div class="att-img-wrap"><img class="att-img" src=${data.image} alt="" loading="lazy" referrerpolicy="no-referrer" onClick=${() => onImage({ url: data.image, name: 'image' })} /></div>`;
  if (data.type === 'video') return html`<video class="att-video" src=${data.video} controls preload="metadata"></video>`;
  return html`<div class="embed" style=${data.color ? { '--ec': data.color } : null}>
    <div class="embed-site">${data.siteName}</div>
    <a class="embed-title" href=${data.url} target="_blank" rel="noopener noreferrer nofollow">${data.title || data.url}</a>
    ${data.description ? html`<div class="embed-desc">${data.description}</div>` : null}
    ${data.youtube ? (play ? html`<div class="embed-video"><iframe src=${`https://www.youtube-nocookie.com/embed/${data.youtube}?autoplay=1`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`
      : html`<button type="button" class="embed-thumb play" onClick=${() => setPlay(true)}><img src=${data.image} alt="" loading="lazy" referrerpolicy="no-referrer" /><span class="play-btn"><${Icon} name="chevron-right" size=${30} sw=${0} fill=${true} /></span></button>`)
      : data.image ? html`<img class="embed-thumb" src=${data.image} alt="" loading="lazy" referrerpolicy="no-referrer" onClick=${() => onImage({ url: data.image, name: data.title })} onError=${(e) => (e.target.style.display = 'none')} />` : null}
  </div>`;
}

/* ------------------------------------------------------------------ attachments */
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** An audio message: play / pause, a bar you can click to seek, its length, and how long until it deletes itself. */
function VoiceMessage({ a, expiresAt }) {
  const ref = useRef(null); const [playing, setPlaying] = useState(false); const [at, setAt] = useState(0);
  const total = a.duration || 0;
  const bars = useMemo(() => {   // a made-up but steady waveform, seeded by the file
    let x = 0; for (const c of String(a.url)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
    return Array.from({ length: 40 }, () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return 0.2 + ((x >>> 16) % 1000) / 1250; });
  }, [a.url]);
  const toggle = () => { const el = ref.current; if (el.paused) el.play().catch(() => {}); else el.pause(); };
  const seek = (e) => { const r = e.currentTarget.getBoundingClientRect(); const el = ref.current; const len = total || el.duration || 0; el.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * len; setAt(el.currentTime); };
  const left = expiresAt ? expiresAt - Date.now() : null; const done = total ? at / total : 0;
  return html`<div class=${cx('voice-msg', playing && 'playing')}>
    <button type="button" class="vm-play" aria-label=${playing ? t('Pause') : t('Play')} onClick=${toggle}><${Icon} name=${playing ? 'pause' : 'play'} size=${16} sw=${0} fill=${true} /></button>
    <div class="vm-wave" onClick=${seek} role="slider" tabindex="0" aria-label=${t('Seek')} aria-valuemin="0" aria-valuemax=${Math.round(total)} aria-valuenow=${Math.round(at)}>${bars.map((hgt, i) => html`<i key=${i} class=${(i + 0.5) / bars.length <= done ? 'on' : ''} style=${{ height: hgt * 100 + '%' }}></i>`)}</div>
    <span class="vm-time">${clock(playing || at ? at : total)}</span>
    ${left !== null && left > 0 ? html`<span class="vm-exp" data-tip=${t('Audio messages delete themselves a day after they are sent')}><${Icon} name="clock" size=${12} />${left > 3600_000 ? `${Math.floor(left / 3600_000)}h` : `${Math.max(1, Math.ceil(left / 60_000))}m`}</span>` : null}
    <audio ref=${ref} src=${a.url} preload="none" onPlay=${() => setPlaying(true)} onPause=${() => setPlaying(false)} onEnded=${() => { setPlaying(false); setAt(0); }} onTimeUpdate=${(e) => setAt(e.target.currentTime)}></audio>
  </div>`;
}
function Attachment({ a, onImage }) {
  const [revealed, setRevealed] = useState(!a.spoiler);
  const isImg = isImageType(a.type) || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(a.name || '');
  if (isImg) {
    const w = a.width || 400; const h = a.height || 300; const scale = Math.min(1, 420 / w, 340 / h);
    return html`<div class=${cx('att-img-wrap', !revealed && 'spoilered')} style=${a.width ? { width: Math.round(w * scale) + 'px', aspectRatio: `${w} / ${h}` } : null} onClick=${() => (revealed ? onImage(a) : setRevealed(true))}>
      <img class="att-img" src=${thumb(a.url, 480)} alt=${a.name} loading="lazy" draggable=${false} />${!revealed ? html`<span class="spoiler-cover">SPOILER</span>` : null}</div>`;
  }
  if (a.type?.startsWith('video/')) return html`<video class="att-video" src=${a.url} controls preload="metadata" playsinline></video>`;
  if (a.type?.startsWith('audio/')) return html`<div class="att-audio"><div class="att-audio-head"><${Icon} name="music" size=${18} /><span>${a.name}</span><small>${fileSize(a.size)}</small></div><audio src=${a.url} controls preload="metadata"></audio></div>`;
  const icon = /pdf|word|text|document/.test(a.type || '') ? 'file-text' : /zip|rar|7z|tar/.test(a.type || '') ? 'folder' : 'file';
  return html`<div class="att-file"><${Icon} name=${icon} size=${30} sw=${1.6} /><div class="att-file-info"><a href=${a.url} download=${a.name} class="att-file-name" title=${a.name}>${a.name}</a><span>${fileSize(a.size)}</span></div>
    <a class="icon-btn" href=${a.url} download=${a.name} data-tip="Download" aria-label="Download"><${Icon} name="download" size=${19} /></a></div>`;
}
function GifMedia({ g, onImage }) {
  // the whole GIF, at its own proportions (never cropped or rounded): as big as it is, up to 440 × 380
  const gw = g.w || 280; const gh = g.h || 200; const k = Math.min(1, 440 / gw, 380 / gh); const w = Math.max(60, Math.round(gw * k));
  const autoplay = state.settings.chat.gifAutoplay; const favs = useFavGifs(); const fav = favs.some((x) => x.id === String(g.id));
  const mp4 = (LITE && g.smallMp4) || g.mp4; const moving = (LITE && (g.smallWebp || g.smallGif)) || g.gif || g.url;   // Lite mode plays the smaller copy
  return html`<div class=${cx('gif-wrap', fav && 'fav')} style=${{ width: w + 'px', aspectRatio: `${gw} / ${gh}` }} onClick=${() => onImage({ url: g.gif || g.url, name: g.title || 'GIF', video: g.mp4, gif: true })}>
    ${mp4 && autoplay ? html`<video src=${mp4} poster=${g.poster} autoplay loop muted playsinline preload="metadata" aria-label=${g.title}></video>` : html`<img src=${autoplay ? moving : (g.poster || g.url)} alt=${g.title || 'GIF'} loading="lazy" />`}
    <span class="gif-badge">GIF</span>${g.id ? html`<button type="button" class=${cx('gif-fav', fav && 'on')} aria-label=${fav ? t('Remove from Favorites') : t('Add to Favorites')} data-tip=${fav ? t('Remove from Favorites') : t('Add to Favorites')} onClick=${(e) => { e.stopPropagation(); toggleFavGif(gifFromMessage(g)); }}><${Icon} name="star" size=${15} fill=${fav} /></button>` : null}</div>`;
}

/** A sticker: a picture, or (Discord's own stickers, from a linked channel) a Lottie animation played by the vendored lottie-web player. */
function Sticker({ s }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!s.lottie) return undefined;
    let anim = null; let gone = false;
    import('/vendor/lottie_light.min.js').then(() => { if (!gone && ref.current) anim = globalThis.lottie.loadAnimation({ container: ref.current, renderer: 'svg', loop: true, autoplay: true, path: s.url }); });
    return () => { gone = true; anim?.destroy(); };
  }, [s.url, s.lottie]);
  return s.lottie ? html`<div class="msg-sticker" ref=${ref} role="img" aria-label=${s.title || 'sticker'} title=${s.title}></div>`
    : html`<img class="msg-sticker" src=${s.url} alt=${s.title || 'sticker'} title=${s.title} loading="lazy" />`;
}

/** A message forwarded from somewhere else: its words, pictures and GIF, and where and when it was first said. */
function Forwarded({ f, onImage }) {
  const body = f.content ? renderMarkdown(f.content, {}) : '';
  return html`<div class="fwd"><div class="fwd-head"><${Icon} name="arrow-right" size=${13} sw=${2.4} />${t('Forwarded')}</div>
    ${body ? html`<div class="msg-content" dangerouslySetInnerHTML=${{ __html: body }}></div>` : null}
    ${f.gif ? html`<${GifMedia} g=${f.gif} onImage=${onImage} />` : null}
    ${f.sticker ? html`<${Sticker} s=${f.sticker} />` : null}
    ${f.attachments?.length ? html`<div class="attachments">${f.attachments.map((a) => html`<${Attachment} key=${a.id || a.url} a=${a} onImage=${onImage} />`)}</div>` : null}
    <${ForwardSource} f=${f} /></div>`;
}
/** The gray line under a forwarded message: who said it, where and when. When you can see the channel it came from, the line takes you to the original message
 *  there, with that server's icon by the server's name. When you can't (a server you're not in, a channel you can't see) it is plain text, as it was written. */
function ForwardSource({ f }) {
  const ch = useSel((s) => s.channelIndex[f.channelId]);
  const server = useSel((s) => { const id = f.serverId || s.channelIndex[f.channelId]?.serverId; return id ? s.servers[id] : null; });
  const when = formatStamp(f.createdAt, !state.settings.chat.hour24);
  if (!ch || !f.messageId) return html`<div class="fwd-foot">${f.authorName} · ${f.from} · ${when}</div>`;
  const place = server ? html`#${ch.name} · <${ServerIcon} server=${server} size=${15} class="fwd-sicon" />${server.name}` : f.from;
  const open = async () => {
    const r = await openMessage(f.channelId, f.messageId);
    if (r === 'gone') toast(t('The original message was deleted'), 'info', 3200);
    else if (r === 'hidden') toast(t('You can’t see the channel it came from'), 'info', 3200);
    else if (r === 'error') toast(t('Couldn’t open the original message. Try again.'), 'error', 3200);
  };
  return html`<button type="button" class="fwd-foot fwd-link" data-tip=${t('Go to the original message')} onClick=${open}>${f.authorName} · <span class="fwd-where">${place}</span> · ${when}</button>`;
}

/* ------------------------------------------------------------------ reactions */
const CUSTOM_KEY = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{6,20})>$/;
/** A reaction's emoji: a character, or the picture of a server's custom emoji. */
function ReactionEmoji({ emoji, m }) {
  const c = CUSTOM_KEY.exec(emoji); if (!c) return html`<span class="r-emoji">${emoji}</span>`;
  const e = (m.emojis || []).find((x) => x.id === c[3]) || emojiById(c[3]);
  return e ? html`<img class="r-emoji emoji custom" src=${e.url} alt=${`:${c[2]}:`} draggable=${false} />` : html`<span class="r-emoji">:${c[2]}:</span>`;
}
function Reactions({ m, ch }) {
  const entries = Object.entries(m.reactions || {}); const me = state.me.id;
  if (!entries.length) return null;
  const canAdd = hasChannelPerm(ch, 'ADD_REACTIONS'); const canJoin = canAdd || hasChannelPerm(ch, 'USE_REACTIONS');   // (taking your own back needs nothing)
  const names = (ids) => { const s = ids.slice(0, 10).map((id) => nameOf(id, ch.serverId)); return s.join(', ') + (ids.length > 10 ? ` and ${ids.length - 10} more` : ''); };
  return html`<div class="reactions">
    ${entries.map(([emoji, ids]) => html`<button type="button" key=${emoji} class=${cx('reaction', ids.includes(me) && 'mine')} disabled=${!canJoin && !ids.includes(me)} data-tip=${`${names(ids)} reacted with ${emoji.replace(CUSTOM_KEY, ':$2:')}`} onClick=${() => toggleReaction(ch, m, emoji)}><${ReactionEmoji} emoji=${emoji} m=${m} /><span class="r-count">${ids.length}</span></button>`)}
    ${canAdd ? html`<button type="button" class="reaction add" data-tip=${t('Add Reaction')} onClick=${(e) => openPicker(e.currentTarget, (emoji) => toggleReaction(ch, m, emoji), { emojiOnly: true })}><${Icon} name="smile-plus" size=${16} /></button>` : null}
  </div>`;
}
export function openPicker(anchor, onPick, opts = {}) {
  import('/js/pickers.js').then((m) => m.openPicker(anchor, onPick, opts));
}

/* ------------------------------------------------------------------ editor */
function InlineEditor({ m, ch, onDone }) {
  const [text, setText] = useState(() => decodeMentions(m.content, ch)); const ref = useRef(null);
  useEffect(() => { const el = ref.current; el.focus(); el.setSelectionRange(el.value.length, el.value.length); grow(); }, []);
  const grow = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 320) + 'px'; } };
  const save = async () => {
    const v = text.trim(); if (v === decodeMentions(m.content, ch).trim()) return onDone();
    if (!v && !(m.attachments?.length || m.gif || m.sticker)) { onDone(); return; }
    const { encodeMentions } = await import('/js/markdown.js');
    onDone(); await editMessage(ch, m.id, encodeMentions(v, ch));
  };
  return html`<div class="msg-edit"><textarea ref=${ref} class="textarea" value=${text} onInput=${(e) => { setText(e.target.value); grow(); }} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } else if (e.key === 'Escape') { e.stopPropagation(); onDone(); } }}></textarea>
    <div class="msg-edit-hint">escape to <a role="button" onClick=${onDone}>cancel</a> • enter to <a role="button" onClick=${save}>save</a></div></div>`;
}

/* ------------------------------------------------------------------ context menu */
export function messageMenu(m, ch) {
  const mine = m.authorId === state.me.id; const serverId = ch.serverId;
  const canManage = serverId ? hasChannelPerm(ch, 'MANAGE_MESSAGES') : false;
  const plain = m.content;
  return [
    hasChannelPerm(ch, 'ADD_REACTIONS') && { label: t('Add Reaction'), icon: 'smile-plus', submenu: [{ type: 'custom', render: () => html`<div class="quick-react">${['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'].map((e) => html`<button type="button" onClick=${() => { set({ ctx: null }); toggleReaction(ch, m, e); }}>${e}</button>`)}</div>` }] },
    { label: t('Reply'), icon: 'reply', onClick: () => set({ replyTo: { channelId: ch.id, id: m.id } }) },
    m.type === 'default' && (m.content || m.forward || m.gif || m.sticker || m.attachments?.some((a) => !a.voice)) && { label: t('Forward'), icon: 'arrow-right', onClick: () => openModal('forward', { channelId: ch.id, messageId: m.id }) },
    mine && m.type === 'default' && { label: t('Edit Message'), icon: 'edit', onClick: () => set({ editing: m.id }) },
    { type: 'sep' },
    (canManage || (!serverId)) && m.type === 'default' && { label: m.pinned ? t('Unpin Message') : t('Pin Message'), icon: 'pin', onClick: () => pinMessage(ch, m.id, !m.pinned) },
    plain && { label: t('Copy Text'), icon: 'copy', onClick: async () => { await copyText(decodeMentions(plain, ch)); toast('Copied to clipboard', 'success', 1400); } },
    { label: t('Copy Message Link'), icon: 'link', onClick: async () => { await copyText(`${location.origin}${serverId ? `/channels/${serverId}/${ch.id}` : `/channels/@me/${ch.id}`}?m=${m.id}`); toast('Link copied', 'success', 1400); } },
    { label: t('Mark Unread'), icon: 'eye-off', onClick: () => markUnreadFrom(ch, m) },
    state.settings.advanced.devMode && { label: t('Copy Message ID'), icon: 'copy', onClick: () => copyText(m.id) },
    (mine || canManage) && { type: 'sep' },
    (mine || canManage) && { label: t('Delete Message'), icon: 'trash', danger: true, onClick: () => deleteMessage(ch, m.id) },
    !mine && !m.bridge && m.type === 'default' && { type: 'sep' },
    !mine && !m.bridge && m.type === 'default' && { label: t('Report to Orata staff'), icon: 'flag', danger: true, onClick: () => openModal('report', { messageId: m.id, channelId: ch.id }) },
  ];
}
function markUnreadFrom(ch, m) {
  const list = state.msgs[ch.id]?.list || []; const i = list.findIndex((x) => x.id === m.id); const prev = list[i - 1];
  if (!prev) return;
  set({ reads: { ...state.reads, [ch.id]: { lastRead: prev.id, mentions: 0 } } });
  api.post(`/channels/${ch.id}/ack`, { messageId: prev.id }).catch(() => {}); // server keeps max; local state shows the divider
  toast('Marked as unread', 'info', 1400);
}

/* ------------------------------------------------------------------ message */
function SystemMessage({ m, ch }) {
  const name = nameOf(m.authorId, ch.serverId);
  let icon = 'arrow-right'; let body;
  const B = (n) => html`<b class="sys-name" onClick=${(e) => openProfile(m.authorId, e.currentTarget)}>${n}</b>`;
  if (m.type === 'join') { icon = 'arrow-right'; const line = JOIN_LINES[Number(m.id.slice(-4)) % JOIN_LINES.length]; const [a, b] = line.split('{name}'); body = html`${a}${B(name)}${b}`; }
  else if (m.type === 'pin') { icon = 'pin'; body = html`${B(name)} pinned <a role="button" class="sys-link" onClick=${() => m.replyTo && jumpToMessage(ch.id, m.replyTo)}>a message</a> to this channel.`; }
  else if (m.type === 'group_create') { icon = 'users'; body = html`${B(name)} started a group chat.`; }
  else if (m.type === 'recipient_add') { icon = 'user-plus'; body = html`${B(name)} added ${B(nameOf(m.content, ch.serverId))} to the group.`; }
  else if (m.type === 'recipient_remove') { icon = 'user-minus'; body = html`${B(name)} left the group.`; }
  else body = html`${B(name)}`;
  return html`<div class="msg system" data-mid=${m.id}><span class="sys-ic ${m.type}"><${Icon} name=${icon} size=${18} sw=${2.2} /></span><span class="sys-text">${body}</span><time class="sys-time" title=${formatFull(m.createdAt)}>${formatStamp(m.createdAt, !state.settings.chat.hour24)}</time></div>`;
}

/** "used /say" above Orbit's answer to a command. Server admins and Orata staff also see who used it (only they may ask the server). */
const usedBy = new Map();
function CommandUsed({ m, ch }) {
  const may = isStaffMe() || !!state.servers[ch.serverId]?.perms.includes('MANAGE_SERVER');
  const [by, setBy] = useState(() => usedBy.get(m.id));
  useEffect(() => { if (may && !by) api.get(`/channels/${ch.id}/messages/${m.id}/command`).then((r) => { if (r.user) { usedBy.set(m.id, r.user); setBy(r.user); } }, () => {}); }, [m.id]);
  return html`<div class="msg-reply cmd-used"><span class="reply-hook"></span>
    ${by ? html`<${Avatar} user=${by} size=${16} /><span class="reply-name" onClick=${(e) => openProfile(by.id, e.currentTarget)}>${by.displayName}</span>${t('used')}` : t('Someone used')}
    <span class="cmd-name">/${m.command.name}</span></div>`;
}

function onBodyClick(e, ch) {
  const sp = e.target.closest('[data-spoiler]'); if (sp) { sp.classList.toggle('revealed'); if (!sp.classList.contains('revealed')) return; e.preventDefault(); return; }
  const cp = e.target.closest('[data-copy]'); if (cp) { const code = cp.closest('.codeblock').querySelector('code').innerText; copyText(code).then(() => { cp.textContent = 'Copied!'; setTimeout(() => (cp.textContent = 'Copy'), 1400); }); return; }
  const um = e.target.closest('.mention[data-user]'); if (um) { openProfile(um.dataset.user, um); return; }
  const cm = e.target.closest('.mention[data-channel]'); if (cm) { const c = getChannel(cm.dataset.channel); if (c) (c.serverId ? goChannel(c.serverId, c.id) : goDm(c.id)); }
  void ch;
}

export const Message = memo(function Message({ m, head, chId, editing, replyingTo, hour12, showEmbeds, compact }) {
  const ch = getChannel(chId); const sid = ch?.serverId;
  const author = useSel((s) => s.users[m.authorId]);
  const color = useSel((s) => (sid ? roleColor(sid, m.authorId) : null));
  const nick = useSel((s) => (sid ? s.servers[sid]?.members.find((x) => x.id === m.authorId)?.nick : null));
  const replyAuthor = useSel((s) => (m.reply?.authorId ? s.users[m.reply.authorId] : null));
  const replyColor = useSel((s) => (m.reply?.authorId && sid ? roleColor(sid, m.reply.authorId) : null));
  const replyNick = useSel((s) => (m.reply?.authorId && sid ? s.servers[sid]?.members.find((x) => x.id === m.reply.authorId)?.nick : null));
  if (!ch) return null;
  if (m.type === 'application') return html`<${ApplicationCard} m=${m} ch=${ch} />`;
  if (m.type && m.type !== 'default') return html`<${SystemMessage} m=${m} ch=${ch} />`;
  const me = state.me.id;
  const mentioned = m.mentions?.includes(me) || m.mentionEveryone || (m.reply?.authorId === me && m.authorId !== me && m.mentions?.includes(me));
  const jumbo = state.settings.chat.jumbo && !m.attachments?.length && emojiOnlyCount(m.content);
  const htmlContent = m.content ? renderMarkdown(m.content, { serverId: ch.serverId, emojis: m.emojis }) : '';
  const links = m.content && !m.pending ? [...new Set((m.content.replace(/```[\s\S]*?```|`[^`]*`/g, '').match(URL_RE) || []).map((u) => u.replace(/[.,;:!?)]+$/, '')))] : [];
  const invites = [...new Set(links.map(inviteCodeOf).filter(Boolean))].slice(0, 2);   // invite links become join cards, whatever the link-preview setting says
  const urls = showEmbeds && !m.ephemeral && !LITE ? links.filter((u) => !inviteCodeOf(u)).slice(0, 2) : [];   // Orbit's private replies stay compact
  const onImage = (a) => { const imgs = (m.attachments || []).filter((x) => isImageType(x.type)).map((x) => ({ url: x.url, name: x.name })); const i = imgs.findIndex((x) => x.url === a.url); set({ lightbox: { items: i >= 0 ? imgs : [a], index: Math.max(0, i) } }); };
  const b = m.bridge;   // from a linked Discord channel: shown as the Discord sender, not as Orbit who posted it
  const who = b ? discordUser(b) : author;
  const name = b ? b.name : nick || author?.displayName || 'Unknown User';
  const open = (e) => (b ? openPopover(e.currentTarget, 'discord-user', { b }, { placement: 'right' }) : openProfile(m.authorId, e.currentTarget));
  const rb = m.reply?.bridge; const replyWho = rb ? discordUser(rb) : replyAuthor;
  const onCtx = (e) => { if (m.ephemeral || e.target.closest('a, .mention')) return; openContext(e, messageMenu(m, ch)); };
  const timeEl = html`<time class="msg-time" title=${formatFull(m.createdAt)}>${formatStamp(m.createdAt, hour12)}</time>`;
  const toolbar = !m.pending && !m.failed && !m.ephemeral ? html`<div class="msg-toolbar glass glass-toolbar">
      ${!hasChannelPerm(ch, 'ADD_REACTIONS') ? null : frequentEmoji().slice(0, 2).concat(frequentEmoji().length < 2 ? ['👍', '😂'].slice(frequentEmoji().length) : []).map((e) => html`<button type="button" class="tb-emoji" data-tip=${`React with ${e}`} onClick=${() => toggleReaction(ch, m, e)}>${e}</button>`)}
      ${hasChannelPerm(ch, 'ADD_REACTIONS') ? html`<${IconBtn} icon="smile-plus" label=${t('Add Reaction')} size=${18} glass=${null} onClick=${(e) => openPicker(e.currentTarget, (emoji) => toggleReaction(ch, m, emoji), { emojiOnly: true })} />` : null}
      <${IconBtn} icon="reply" label=${t('Reply')} size=${18} glass=${null} onClick=${() => set({ replyTo: { channelId: ch.id, id: m.id } })} />
      ${m.authorId === me ? html`<${IconBtn} icon="edit" label=${t('Edit')} size=${18} glass=${null} onClick=${() => set({ editing: m.id })} />` : null}
      <${IconBtn} icon="more-h" label=${t('More')} size=${18} glass=${null} onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); openContext({ clientX: r.left, clientY: r.bottom + 4 }, messageMenu(m, ch)); }} />
    </div>` : null;
  return html`<div class=${cx('msg', head ? 'head' : 'cont', mentioned && 'mentioned', m.pending && 'pending', m.failed && 'failed', editing && 'editing', replyingTo && 'replying', m.pinned && 'is-pinned', m.ephemeral && 'ephemeral')} data-mid=${m.id} onContextMenu=${onCtx}>
    ${m.reply ? html`<div class="msg-reply" onClick=${() => m.reply.id && !m.reply.deleted && jumpToMessage(ch.id, m.reply.id)}>
      <span class="reply-hook"></span>
      ${m.reply.deleted ? html`<span class="reply-deleted"><${Icon} name="reply" size=${13} /> Original message was deleted</span>`
        : html`<${Avatar} user=${replyWho} size=${16} /><span class="reply-name" style=${replyColor && !rb ? { color: replyColor } : null}>${m.reply.authorId === me && !rb ? '@' : ''}<${UserName} user=${replyWho} text=${rb ? rb.name : replyNick || replyAuthor?.displayName || 'Unknown'} /></span>
          <span class="reply-text">${m.reply.content ? plainPreview(m.reply.content, ch.serverId, 120) : m.reply.gif ? 'Click to see GIF' : m.reply.sticker ? 'Click to see sticker' : m.reply.attachments ? 'Click to see attachment' : ''}</span>${m.reply.attachments ? html`<${Icon} name="image" size=${14} />` : null}`}</div>` : null}
    ${m.command ? html`<${CommandUsed} m=${m} ch=${ch} />` : null}
    <div class="msg-main">
      <div class="msg-gutter">${head ? (state.settings.chat.showAvatars ? html`<${Avatar} user=${who} size=${40} onClick=${open} onContextMenu=${(e) => !b && openContext(e, [{ label: 'Profile', icon: 'user', onClick: () => openProfile(m.authorId) }, { label: 'Message', icon: 'message', onClick: () => import('/js/actions.js').then((a) => a.openDm(m.authorId)), disabled: m.authorId === me }])} />` : null) : html`<time class="msg-time hover-time">${formatClock(m.createdAt, hour12)}</time>`}</div>
      <div class="msg-body">
        ${head ? html`<div class="msg-head"><span class="msg-author" style=${color && !b ? { color } : null} role="button" tabindex="0" onClick=${open}><${UserName} user=${who} text=${name} /></span>${b ? html`<span class="bot-tag discord-tag">DISCORD</span>` : html`${author?.tag ? html`<${ServerTag} tag=${author.tag} />` : null}${author?.bot ? html`<span class="bot-tag">APP</span>` : null}`}${timeEl}</div>` : null}
        ${editing ? html`<${InlineEditor} m=${m} ch=${ch} onDone=${() => set({ editing: null })} />`
          : htmlContent ? html`<div class=${cx('msg-content', jumbo && 'jumbo')} onClick=${(e) => onBodyClick(e, ch)} dangerouslySetInnerHTML=${{ __html: htmlContent }}></div>` : null}
        ${m.editedAt && !editing ? html`<span class="edited" data-tip=${formatFull(m.editedAt)}>(${t('edited')})</span>` : null}
        ${m.forward ? html`<${Forwarded} f=${m.forward} onImage=${(a) => set({ lightbox: { items: [a], index: 0 } })} />` : null}
        ${m.gif ? html`<${GifMedia} g=${m.gif} onImage=${(a) => set({ lightbox: { items: [a], index: 0 } })} />` : null}
        ${m.sticker ? html`<${Sticker} s=${m.sticker} />` : null}
        ${m.poll ? html`<${PollView} m=${m} ch=${ch} />` : null}
        ${m.theme ? html`<${ThemeCard} m=${m} />` : null}
        ${m.playlist ? html`<${PlaylistCard} m=${m} />` : null}
        ${m.attachments?.length ? html`<div class="attachments">${m.attachments.map((a) => (a.voice ? html`<${VoiceMessage} key=${a.id || a.url} a=${a} expiresAt=${m.expiresAt} />` : html`<${Attachment} key=${a.id || a.url} a=${a} onImage=${onImage} />`))}</div>` : null}
        ${invites.map((c) => html`<${InviteCard} key=${c} code=${c} mine=${m.authorId === me} />`)}
        ${urls.map((u) => html`<${LinkEmbed} key=${u} url=${u} onImage=${(a) => set({ lightbox: { items: [a], index: 0 } })} />`)}
        <${Reactions} m=${m} ch=${ch} />
        ${m.ephemeral ? html`<div class="msg-eph"><${Icon} name="eye" size=${14} />${t('Only you can see this')} · <a role="button" onClick=${() => dismissEphemeral(ch.id, m.id)}>${t('Dismiss message')}</a></div>` : null}
        ${m.failed ? html`<div class="msg-fail"><${Icon} name="alert-circle" size=${14} /> ${m.error || 'Message failed to send.'} <a role="button" onClick=${() => retryMessage(ch, m)}>Retry</a> · <a role="button" onClick=${() => discardMessage(ch, m)}>Delete</a></div>` : null}
      </div>
      ${toolbar}
      ${m.pinned ? html`<span class="pin-flag" data-tip="Pinned"><${Icon} name="pin" size=${12} fill=${true} /></span>` : null}
    </div>
  </div>`;
}, (a, b) => shallowEq(a, b));

const discordUser = (b) => ({ id: 'discord-' + b.id, displayName: b.name, avatar: b.avatar });
/** Clicking a Discord sender: who they are (they have no Orata account, so no profile). */
POPOVERS['discord-user'] = function DiscordUser({ b }) {
  return html`<div class="pop-card discord-pop"><${Avatar} user=${discordUser(b)} size=${64} />
    <div><div class="dp-name">${b.name}<span class="bot-tag discord-tag">DISCORD</span></div><p>${t('Writes in a Discord channel linked with this one. Orbit brings their messages here, and yours to them.')}</p></div></div>`;
};

export const dmTitle = dmName;
void go; void openModal; void openPopover; void mapMessage;
