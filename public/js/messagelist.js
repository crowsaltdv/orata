// Orata — scrolling message list with date dividers, NEW marker, infinite history and jump-to-present.
import { html, useState, useEffect, useRef, useLayoutEffect, useMemo, cx, sameDay, formatDay, cmpId, formatStamp } from '/js/lib.js';
import { state, useSel, set, getChannel, dmName, dmUserId } from '/js/store.js';
import { Icon, Logo } from '/js/icons.js';
import { Avatar, Spinner } from '/js/ui.js';
import { Message } from '/js/message.js';
import { loadMessages, loadOlder, loadNewer, jumpToLatest, ackChannel, getEntry } from '/js/actions.js';
import { t } from '/js/i18n.js';

function buildRows(list, lastRead, meId) {
  const rows = []; let prev = null; let newPlaced = !lastRead;
  for (const m of list) {
    if (!newPlaced && cmpId(m.id, lastRead) > 0 && !m.id.startsWith('n:')) {
      newPlaced = true;
      if (m.authorId !== meId) { rows.push({ type: 'new', key: 'new', ts: m.createdAt }); prev = null; }
    }
    if (!prev || !sameDay(prev.createdAt, m.createdAt)) { rows.push({ type: 'date', key: 'd' + m.id, ts: m.createdAt }); prev = null; }
    const sys = m.type && m.type !== 'default';
    const head = !prev || sys || prev.type !== 'default' && prev.type !== undefined || prev.authorId !== m.authorId || prev.bridge?.id !== m.bridge?.id || m.createdAt - prev.createdAt > 7 * 60_000 || !!m.reply;
    rows.push({ type: 'msg', key: m.id.startsWith('n:') ? m.id : m.id, m, head });
    prev = m;
  }
  return rows;
}

function ChannelIntro({ ch }) {
  const server = ch.serverId ? state.servers[ch.serverId] : null;
  const other = ch.type === 'dm' ? state.users[dmUserId(ch)] : null;
  if (ch.type === 'dm') return html`<div class="intro"><${Avatar} user=${other} size=${88} /><h2>${other?.displayName}</h2><div class="intro-sub">@${other?.username}</div><p>This is the beginning of your direct message history with <b>${other?.displayName}</b>.</p></div>`;
  if (ch.type === 'group') return html`<div class="intro"><span class="group-av big"><${Icon} name="users" size=${42} /></span><h2>${dmName(ch)}</h2><p>Welcome to the beginning of the <b>${dmName(ch)}</b> group.</p></div>`;
  if (ch.type === 'post') return html`<div class="intro"><span class="intro-hash"><${Icon} name="forum" size=${38} sw=${2} /></span><h2>${ch.name}</h2></div>`;
  return html`<div class="intro"><span class="intro-hash">${ch.emoji ? html`<span class="intro-emoji">${ch.emoji}</span>` : html`<${Icon} name="hash" size=${40} sw=${2.2} />`}</span><h2>${t('Welcome to #{name}!', { name: ch.name })}</h2><p>${t("This is the start of the #{name} channel.", { name: ch.name })}${ch.topic ? ' ' + ch.topic : ''}</p>${server ? '' : ''}</div>`;
}

export function MessageList({ chId }) {
  const ch = getChannel(chId);
  const entry = useSel((s) => s.msgs[chId]);
  const editing = useSel((s) => s.editing);
  const replyTo = useSel((s) => (s.replyTo?.channelId === chId ? s.replyTo.id : null));
  const jump = useSel((s) => s.jump);
  const hour12 = useSel((s) => !s.settings.chat.hour24);
  const embeds = useSel((s) => s.settings.chat.linkPreviews);
  const compact = useSel((s) => s.settings.chat.compact);
  const focused = useSel((s) => s.focused);
  const lastMsg = useSel((s) => s.lastMsg[chId]);
  const scroller = useRef(null); const atBottom = useRef(true); const prevLen = useRef(0); const prevH = useRef(0); const lastPrepended = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [unreadAnchor, setUnreadAnchor] = useState(null);
  const initial = useRef(true);

  // snapshot of the read marker when the channel is opened (so the NEW divider stays while we read)
  useEffect(() => { setUnreadAnchor(state.reads[chId]?.lastRead || null); loadMessages(chId); atBottom.current = true; setShowJump(false); prevLen.current = 0; }, [chId]);
  const list = entry?.list || [];
  const rows = useMemo(() => buildRows(list, unreadAnchor, state.me.id), [list, unreadAnchor]);
  const firstNewIndex = rows.findIndex((r) => r.type === 'new');
  const newCount = firstNewIndex >= 0 ? rows.slice(firstNewIndex).filter((r) => r.type === 'msg').length : 0;

  const toBottom = (smooth) => { const el = scroller.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };
  useLayoutEffect(() => {
    const el = scroller.current; if (!el || !entry?.loaded) return;
    if (initial.current) { initial.current = false; el.scrollTop = el.scrollHeight; prevLen.current = list.length; prevH.current = el.scrollHeight; return; }
    if (entry.prepended && entry.prepended !== lastPrepended.current) { lastPrepended.current = entry.prepended; el.scrollTop += el.scrollHeight - prevH.current; }
    else if (atBottom.current) toBottom(false);
    else if (list.length > prevLen.current) setShowJump(true);
    prevLen.current = list.length; prevH.current = el.scrollHeight;
  }, [entry?.list, entry?.loaded]);

  // keep pinned to the bottom when images/embeds finish loading
  useEffect(() => {
    const el = scroller.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => { if (atBottom.current && !initial.current) el.scrollTop = el.scrollHeight; });
    for (const c of el.children) ro.observe(c);
    const mo = new MutationObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    mo.observe(el, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [chId, entry?.loaded]);

  // jump requests (reply click, search result, new local message)
  useEffect(() => {
    if (!jump || jump.chId !== chId) return;
    const el = scroller.current; if (!el) return;
    if (jump.bottom) { requestAnimationFrame(() => toBottom(!jump.soft)); atBottom.current = true; setShowJump(false); return; }
    requestAnimationFrame(() => {
      const target = el.querySelector(`[data-mid="${jump.id}"]`); if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 2200);
    });
  }, [jump?.ts]);

  const onScroll = () => {
    const el = scroller.current; const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const ab = dist < 90; atBottom.current = ab;
    if (ab && showJump && !entry?.hasNewer) setShowJump(false);
    if (el.scrollTop < 260 && entry?.hasMore && !entry.loading) { prevH.current = el.scrollHeight; loadOlder(chId); }
    if (dist < 400 && entry?.hasNewer && !entry.loading) loadNewer(chId);
    if (ab && state.focused && state.route.channelId === chId && !entry?.hasNewer) ackChannel(chId);
  };

  // mark read while viewing at the bottom
  useEffect(() => { if (focused && atBottom.current && entry?.loaded && !entry.hasNewer && state.route.channelId === chId) ackChannel(chId); }, [lastMsg, focused, entry?.loaded, chId]);

  const jumpToUnread = () => { const el = scroller.current?.querySelector('.new-divider'); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  const jumpPresent = async () => { if (entry?.hasNewer) await jumpToLatest(chId); else toBottom(true); setShowJump(false); };

  if (!ch) return null;
  const grouped = rows;
  const showUnreadBar = unreadAnchor && newCount > 0 && firstNewIndex >= 0;
  return html`<div class="msg-area">
    ${showUnreadBar ? html`<div class="unread-bar slide-down"><button type="button" onClick=${jumpToUnread}>${newCount}${newCount >= 50 ? '+' : ''} ${t('new messages')} ${grouped[firstNewIndex]?.ts ? t('since') + ' ' + formatStamp(grouped[firstNewIndex].ts, hour12) : ''}</button><button type="button" class="mark" onClick=${() => { ackChannel(chId); setUnreadAnchor(null); }}>${t('Mark As Read')} <${Icon} name="check" size=${14} sw=${3} /></button></div>` : null}
    <div class=${cx('msg-scroller', compact && 'compact')} ref=${scroller} onScroll=${onScroll} role="log" aria-live="polite" aria-label="Messages">
      <div class="msg-pad"></div>
      ${entry?.loading && !list.length ? html`<div class="msg-loading">${[0, 1, 2, 3, 4].map((i) => html`<div class="sk-msg" key=${i}><span class="skeleton sk-av"></span><div><span class="skeleton" style=${{ width: 90 + i * 22 + 'px', height: '12px', display: 'block', marginBottom: '8px' }}></span><span class="skeleton" style=${{ width: 180 + ((i * 53) % 220) + 'px', height: '12px', display: 'block' }}></span></div></div>`)}</div>` : null}
      ${entry?.loaded && !entry.hasMore ? html`<${ChannelIntro} ch=${ch} />` : null}
      ${entry?.loading && list.length ? html`<div class="msg-loading-more"><${Spinner} size=${22} /></div>` : null}
      ${grouped.map((r) => r.type === 'date' ? html`<div class="date-divider" key=${r.key}><span>${formatDay(r.ts)}</span></div>`
        : r.type === 'new' ? html`<div class="new-divider" key=${r.key}><span>${t('NEW')}</span></div>`
          : html`<${Message} key=${r.key} m=${r.m} head=${r.head} chId=${chId} editing=${editing === r.m.id} replyingTo=${replyTo === r.m.id} hour12=${hour12} showEmbeds=${embeds} compact=${compact} />`)}
      ${entry?.error ? html`<div class="msg-error"><${Icon} name="alert-circle" size=${18} /> ${entry.error} <button type="button" class="link-btn" onClick=${() => loadMessages(chId, { force: true })}>Retry</button></div>` : null}
      <div class="msg-end"></div>
    </div>
    ${showJump || entry?.hasNewer ? html`<button type="button" class="jump-present slide-up" onClick=${jumpPresent}><span>${entry?.hasNewer ? t("You're viewing older messages") : t('New messages below')}</span><b>${t('Jump to Present')} <${Icon} name="arrow-down" size=${15} sw=${2.6} /></b></button>` : null}
  </div>`;
}
void Logo; void set;
