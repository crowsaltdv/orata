// Orate — a single chat message (header, markdown body, attachments, GIFs, embeds, reactions, toolbar).
import { html, useState, useEffect, useRef, memo, cx, formatStamp, formatClock, formatFull, fileSize, copyText, isImageType, shallowEq } from '/js/lib.js';
import { state, set, useSel, nameOf, roleColor, openContext, openPopover, openModal, toast, getChannel, hasPerm, dmName, goChannel, goDm, go } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, IconBtn } from '/js/ui.js';
import { renderMarkdown, emojiOnlyCount, plainPreview, decodeMentions } from '/js/markdown.js';
import { toggleReaction, deleteMessage, pinMessage, editMessage, jumpToMessage, retryMessage, discardMessage, mapMessage } from '/js/actions.js';
import { openProfile } from '/js/sidebar.js';
import { frequentEmoji } from '/js/emoji.js';
import { api } from '/js/api.js';
import { t } from '/js/i18n.js';

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
function Attachment({ a, onImage }) {
  const [revealed, setRevealed] = useState(!a.spoiler);
  const isImg = isImageType(a.type) || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(a.name || '');
  if (isImg) {
    const w = a.width || 400; const h = a.height || 300; const scale = Math.min(1, 420 / w, 340 / h);
    return html`<div class=${cx('att-img-wrap', !revealed && 'spoilered')} style=${a.width ? { width: Math.round(w * scale) + 'px', aspectRatio: `${w} / ${h}` } : null} onClick=${() => (revealed ? onImage(a) : setRevealed(true))}>
      <img class="att-img" src=${a.url} alt=${a.name} loading="lazy" draggable="false" />${!revealed ? html`<span class="spoiler-cover">SPOILER</span>` : null}</div>`;
  }
  if (a.type?.startsWith('video/')) return html`<video class="att-video" src=${a.url} controls preload="metadata" playsinline></video>`;
  if (a.type?.startsWith('audio/')) return html`<div class="att-audio"><div class="att-audio-head"><${Icon} name="music" size=${18} /><span>${a.name}</span><small>${fileSize(a.size)}</small></div><audio src=${a.url} controls preload="metadata"></audio></div>`;
  const icon = /pdf|word|text|document/.test(a.type || '') ? 'file-text' : /zip|rar|7z|tar/.test(a.type || '') ? 'folder' : 'file';
  return html`<div class="att-file"><${Icon} name=${icon} size=${30} sw=${1.6} /><div class="att-file-info"><a href=${a.url} download=${a.name} class="att-file-name" title=${a.name}>${a.name}</a><span>${fileSize(a.size)}</span></div>
    <a class="icon-btn" href=${a.url} download=${a.name} data-tip="Download" aria-label="Download"><${Icon} name="download" size=${19} /></a></div>`;
}
function GifMedia({ g, onImage }) {
  const w = Math.min(g.w || 280, 360); const h = Math.round(w * ((g.h || 200) / (g.w || 280)));
  const autoplay = state.settings.chat.gifAutoplay;
  return html`<div class="gif-wrap" style=${{ width: w + 'px', aspectRatio: `${g.w || 280} / ${g.h || 200}`, maxHeight: '320px' }} onClick=${() => onImage({ url: g.gif || g.url, name: g.title || 'GIF', video: g.mp4 })}>
    ${g.mp4 && autoplay ? html`<video src=${g.mp4} poster=${g.poster} autoplay loop muted playsinline preload="metadata" aria-label=${g.title}></video>` : html`<img src=${autoplay ? (g.gif || g.url) : (g.poster || g.url)} alt=${g.title || 'GIF'} loading="lazy" />`}
    <span class="gif-badge">GIF</span></div>`;
}

/* ------------------------------------------------------------------ reactions */
function Reactions({ m, ch }) {
  const entries = Object.entries(m.reactions || {}); const me = state.me.id;
  if (!entries.length) return null;
  const names = (ids) => { const s = ids.slice(0, 10).map((id) => nameOf(id, ch.serverId)); return s.join(', ') + (ids.length > 10 ? ` and ${ids.length - 10} more` : ''); };
  return html`<div class="reactions">
    ${entries.map(([emoji, ids]) => html`<button type="button" key=${emoji} class=${cx('reaction', ids.includes(me) && 'mine')} data-tip=${`${names(ids)} reacted with ${emoji}`} onClick=${() => toggleReaction(ch, m, emoji)}><span class="r-emoji">${emoji}</span><span class="r-count">${ids.length}</span></button>`)}
    <button type="button" class="reaction add" data-tip=${t('Add Reaction')} onClick=${(e) => openPicker(e.currentTarget, (emoji) => toggleReaction(ch, m, emoji), { emojiOnly: true })}><${Icon} name="smile-plus" size=${16} /></button>
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
  const canManage = serverId ? hasPerm(serverId, 'MANAGE_MESSAGES') : false;
  const plain = m.content;
  return [
    { label: t('Add Reaction'), icon: 'smile-plus', submenu: [{ type: 'custom', render: () => html`<div class="quick-react">${['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'].map((e) => html`<button type="button" onClick=${() => { set({ ctx: null }); toggleReaction(ch, m, e); }}>${e}</button>`)}</div>` }] },
    { label: t('Reply'), icon: 'reply', onClick: () => set({ replyTo: { channelId: ch.id, id: m.id } }) },
    mine && m.type === 'default' && { label: t('Edit Message'), icon: 'edit', onClick: () => set({ editing: m.id }) },
    { type: 'sep' },
    (canManage || (!serverId)) && m.type === 'default' && { label: m.pinned ? t('Unpin Message') : t('Pin Message'), icon: 'pin', onClick: () => pinMessage(ch, m.id, !m.pinned) },
    plain && { label: t('Copy Text'), icon: 'copy', onClick: async () => { await copyText(decodeMentions(plain, ch)); toast('Copied to clipboard', 'success', 1400); } },
    { label: t('Copy Message Link'), icon: 'link', onClick: async () => { await copyText(`${location.origin}${serverId ? `/channels/${serverId}/${ch.id}` : `/channels/@me/${ch.id}`}?m=${m.id}`); toast('Link copied', 'success', 1400); } },
    { label: t('Mark Unread'), icon: 'eye-off', onClick: () => markUnreadFrom(ch, m) },
    state.settings.advanced.devMode && { label: t('Copy Message ID'), icon: 'copy', onClick: () => copyText(m.id) },
    (mine || canManage) && { type: 'sep' },
    (mine || canManage) && { label: t('Delete Message'), icon: 'trash', danger: true, onClick: () => deleteMessage(ch, m.id) },
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
  if (m.type && m.type !== 'default') return html`<${SystemMessage} m=${m} ch=${ch} />`;
  const me = state.me.id;
  const mentioned = m.mentions?.includes(me) || m.mentionEveryone || (m.reply?.authorId === me && m.authorId !== me && m.mentions?.includes(me));
  const jumbo = state.settings.chat.jumbo && !m.attachments?.length && emojiOnlyCount(m.content);
  const htmlContent = m.content ? renderMarkdown(m.content, { serverId: ch.serverId }) : '';
  const urls = showEmbeds && m.content && !m.pending ? [...new Set((m.content.replace(/```[\s\S]*?```|`[^`]*`/g, '').match(URL_RE) || []).map((u) => u.replace(/[.,;:!?)]+$/, '')))].slice(0, 2) : [];
  const onImage = (a) => { const imgs = (m.attachments || []).filter((x) => isImageType(x.type)).map((x) => ({ url: x.url, name: x.name })); const i = imgs.findIndex((x) => x.url === a.url); set({ lightbox: { items: i >= 0 ? imgs : [a], index: Math.max(0, i) } }); };
  const name = nick || author?.displayName || 'Unknown User';
  const open = (e) => openProfile(m.authorId, e.currentTarget);
  const onCtx = (e) => { if (e.target.closest('a, .mention')) return; openContext(e, messageMenu(m, ch)); };
  const timeEl = html`<time class="msg-time" title=${formatFull(m.createdAt)}>${formatStamp(m.createdAt, hour12)}</time>`;
  const toolbar = !m.pending && !m.failed ? html`<div class="msg-toolbar glass glass-toolbar">
      ${frequentEmoji().slice(0, 2).concat(frequentEmoji().length < 2 ? ['👍', '😂'].slice(frequentEmoji().length) : []).map((e) => html`<button type="button" class="tb-emoji" data-tip=${`React with ${e}`} onClick=${() => toggleReaction(ch, m, e)}>${e}</button>`)}
      <${IconBtn} icon="smile-plus" label=${t('Add Reaction')} size=${18} glass=${null} onClick=${(e) => openPicker(e.currentTarget, (emoji) => toggleReaction(ch, m, emoji), { emojiOnly: true })} />
      <${IconBtn} icon="reply" label=${t('Reply')} size=${18} glass=${null} onClick=${() => set({ replyTo: { channelId: ch.id, id: m.id } })} />
      ${m.authorId === me ? html`<${IconBtn} icon="edit" label=${t('Edit')} size=${18} glass=${null} onClick=${() => set({ editing: m.id })} />` : null}
      <${IconBtn} icon="more-h" label=${t('More')} size=${18} glass=${null} onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); openContext({ clientX: r.left, clientY: r.bottom + 4 }, messageMenu(m, ch)); }} />
    </div>` : null;
  return html`<div class=${cx('msg', head ? 'head' : 'cont', mentioned && 'mentioned', m.pending && 'pending', m.failed && 'failed', editing && 'editing', replyingTo && 'replying', m.pinned && 'is-pinned')} data-mid=${m.id} onContextMenu=${onCtx}>
    ${m.reply ? html`<div class="msg-reply" onClick=${() => m.reply.id && !m.reply.deleted && jumpToMessage(ch.id, m.reply.id)}>
      <span class="reply-hook"></span>
      ${m.reply.deleted ? html`<span class="reply-deleted"><${Icon} name="reply" size=${13} /> Original message was deleted</span>`
        : html`<${Avatar} user=${replyAuthor} size=${16} /><span class="reply-name" style=${replyColor ? { color: replyColor } : null}>${m.reply.authorId === me ? '@' : ''}${replyNick || replyAuthor?.displayName || 'Unknown'}</span>
          <span class="reply-text">${m.reply.content ? plainPreview(m.reply.content, ch.serverId, 120) : m.reply.gif ? 'Click to see GIF' : m.reply.sticker ? 'Click to see sticker' : m.reply.attachments ? 'Click to see attachment' : ''}</span>${m.reply.attachments ? html`<${Icon} name="image" size=${14} />` : null}`}</div>` : null}
    <div class="msg-main">
      <div class="msg-gutter">${head ? (state.settings.chat.showAvatars ? html`<${Avatar} user=${author} size=${40} onClick=${open} onContextMenu=${(e) => openContext(e, [{ label: 'Profile', icon: 'user', onClick: () => openProfile(m.authorId) }, { label: 'Message', icon: 'message', onClick: () => import('/js/actions.js').then((a) => a.openDm(m.authorId)), disabled: m.authorId === me }])} />` : null) : html`<time class="msg-time hover-time">${formatClock(m.createdAt, hour12)}</time>`}</div>
      <div class="msg-body">
        ${head ? html`<div class="msg-head"><span class="msg-author" style=${color ? { color } : null} role="button" tabindex="0" onClick=${open}>${name}</span>${author?.bot ? html`<span class="bot-tag">APP</span>` : null}${timeEl}</div>` : null}
        ${editing ? html`<${InlineEditor} m=${m} ch=${ch} onDone=${() => set({ editing: null })} />`
          : htmlContent ? html`<div class=${cx('msg-content', jumbo && 'jumbo')} onClick=${(e) => onBodyClick(e, ch)} dangerouslySetInnerHTML=${{ __html: htmlContent }}></div>` : null}
        ${m.editedAt && !editing ? html`<span class="edited" data-tip=${formatFull(m.editedAt)}>(${t('edited')})</span>` : null}
        ${m.gif ? html`<${GifMedia} g=${m.gif} onImage=${(a) => set({ lightbox: { items: [a], index: 0 } })} />` : null}
        ${m.sticker ? html`<img class="msg-sticker" src=${m.sticker.url} alt=${m.sticker.title || 'sticker'} title=${m.sticker.title} loading="lazy" />` : null}
        ${m.attachments?.length ? html`<div class="attachments">${m.attachments.map((a) => html`<${Attachment} key=${a.id || a.url} a=${a} onImage=${onImage} />`)}</div>` : null}
        ${urls.map((u) => html`<${LinkEmbed} key=${u} url=${u} onImage=${(a) => set({ lightbox: { items: [a], index: 0 } })} />`)}
        <${Reactions} m=${m} ch=${ch} />
        ${m.failed ? html`<div class="msg-fail"><${Icon} name="alert-circle" size=${14} /> ${m.error || 'Message failed to send.'} <a role="button" onClick=${() => retryMessage(ch, m)}>Retry</a> · <a role="button" onClick=${() => discardMessage(ch, m)}>Delete</a></div>` : null}
      </div>
      ${toolbar}
      ${m.pinned ? html`<span class="pin-flag" data-tip="Pinned"><${Icon} name="pin" size=${12} fill=${true} /></span>` : null}
    </div>
  </div>`;
}, (a, b) => shallowEq(a, b));

export const dmTitle = dmName;
void go; void openModal; void openPopover; void mapMessage;
