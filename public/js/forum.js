// Orata — forum channels: a list of posts (with tags, search and sorting), the "new post" dialog and the post menu.
// A post is a small channel of its own, so once you open one it is an ordinary chat (ChatView) with a different header.
// An Application channel is a forum with `apply`: posts are applications that only their author and the reviewers (Access Applications)
// see until a reviewer accepts them (server/api.js /decision); reviewers get Waiting / Accepted / Denied tabs.
import { html, useState, useEffect, useRef, cx, relTime } from '/js/lib.js';
import { state, set, notify, useSel, getChannel, hasChannelPerm, hasPerm, openModal, closeModal, goChannel, addUsers, toast, rebuildIndex, nameOf } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, Btn, IconBtn, Field, TextInput, Modal, MODALS, Dropdown, Empty, Spinner, confirmDialog } from '/js/ui.js';
import { api, gateway, upload } from '/js/api.js';
import { act, errMsg } from '/js/actions.js';
import { encodeMentions, plainPreview } from '/js/markdown.js';
import { t } from '/js/i18n.js';
import { currentLook } from '/js/theme-card.js';

/* ------------------------------------------------------------------ the post store: postIndex (every post we know) + postLists (which ones a forum list shows) */
export function putPost(p) {
  set({ postIndex: { ...state.postIndex, [p.id]: { ...state.postIndex[p.id], ...p } } });
  rebuildIndex(); notify();
}
function dropPost(forumId, postId) {
  const idx = { ...state.postIndex }; delete idx[postId];
  const lists = { ...state.postLists }; if (lists[forumId]) lists[forumId] = { ...lists[forumId], ids: lists[forumId].ids.filter((i) => i !== postId), total: Math.max(0, (lists[forumId].total || 1) - 1) };
  set({ postIndex: idx, postLists: lists }); rebuildIndex(); notify();
}
export async function loadPosts(forumId, params, append = false) {
  const cur = state.postLists[forumId];
  const qs = new URLSearchParams({ sort: params.sort || 'recent', limit: '25', offset: String(append && cur ? cur.ids.length : 0) });
  if (params.tag) qs.set('tag', params.tag); if (params.q) qs.set('q', params.q); if (params.status) qs.set('status', params.status);
  const key = `${params.sort}|${params.tag}|${params.q}|${params.status || ''}`;
  const r = await api.get(`/channels/${forumId}/posts?${qs}`);
  addUsers(r.users);
  const idx = { ...state.postIndex }; for (const p of r.posts) idx[p.id] = { ...idx[p.id], ...p };
  const ids = append && cur?.key === key ? [...cur.ids, ...r.posts.map((p) => p.id).filter((i) => !cur.ids.includes(i))] : r.posts.map((p) => p.id);
  set({ postIndex: idx, postLists: { ...state.postLists, [forumId]: { ids, total: r.total, hasMore: r.hasMore, key, filtered: !!(params.tag || params.q), status: params.status || '', counts: r.counts || null } } });
  rebuildIndex(); notify();
}
/** Makes sure a post we only know the id of (a link, a reload) is in the store. Resolves the channel, or null. */
export async function ensurePost(id) {
  if (state.postIndex[id]) return state.postIndex[id];
  try { const c = await api.get(`/channels/${id}`); if (c.type === 'post') { putPost(c); return c; } } catch { /* not ours to see */ }
  return null;
}

gateway.on('post_create', ({ post, users }) => {
  addUsers(users); putPost(post);
  const l = state.postLists[post.forumId];
  if (l && !l.filtered && (!l.status || l.status === post.status) && !l.ids.includes(post.id)) set({ postLists: { ...state.postLists, [post.forumId]: { ...l, ids: [post.id, ...l.ids], total: l.total + 1 } } });
});
gateway.on('post_update', ({ post }) => {
  if (!state.postIndex[post.id] && !state.postLists[post.forumId]) return;
  putPost(post);
  const l = state.postLists[post.forumId];   // an application that was just decided leaves the "Waiting" tab
  if (l?.status && post.status && post.status !== l.status && l.ids.includes(post.id)) set({ postLists: { ...state.postLists, [post.forumId]: { ...l, ids: l.ids.filter((i) => i !== post.id), total: Math.max(0, l.total - 1) } } });
});
gateway.on('post_delete', ({ forumId, postId }) => {
  const here = state.route.channelId === postId; dropPost(forumId, postId);
  if (here) goChannel(state.route.serverId, forumId);
});

/* ------------------------------------------------------------------ small pieces */
export function TagChip({ tag, on, onClick, small }) {
  return html`<button type="button" class=${cx('tag-chip', on && 'on', small && 'sm')} onClick=${onClick} disabled=${!onClick}>${tag.emoji ? html`<span>${tag.emoji}</span>` : null}${tag.name}</button>`;
}
function TagPicker({ forum, value, onChange }) {
  if (!forum?.tags?.length) return null;
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : value.length >= 5 ? value : [...value, id]);
  return html`<div class="tag-picker">${forum.tags.map((tg) => html`<${TagChip} key=${tg.id} tag=${tg} on=${value.includes(tg.id)} onClick=${() => toggle(tg.id)} />`)}</div>`;
}

/* ------------------------------------------------------------------ new post / edit post */
MODALS['new-post'] = function NewPost({ id, forumId }) {
  const forum = getChannel(forumId);
  const [title, setTitle] = useState(''); const [content, setContent] = useState(''); const [tags, setTags] = useState([]); const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const fileInput = useRef(null); const [withTheme, setWithTheme] = useState(false);
  if (!forum) return null;
  const app = !!forum.apply;
  const canAttach = hasChannelPerm(forum, 'ATTACH_FILES');
  const addFiles = async (list) => {
    for (const f of [...list].slice(0, 10 - files.length)) {
      const entry = { key: Math.random().toString(36).slice(2), name: f.name, size: f.size, type: f.type, status: 'uploading' };
      setFiles((cur) => [...cur, entry]);
      upload(f).then((r) => setFiles((cur) => cur.map((x) => (x.key === entry.key ? { ...x, status: 'done', result: r } : x)))).catch((e) => { toast(errMsg(e), 'error'); setFiles((cur) => cur.filter((x) => x.key !== entry.key)); });
    }
  };
  const ready = files.filter((f) => f.status === 'done');
  const missingTag = forum.requireTag && forum.tags?.length && !tags.length;
  const create = async () => {
    if (!title.trim()) { setErr(app ? t('Give your application a title') : t('Give your post a title')); return; }
    if (!content.trim() && !ready.length && !withTheme) { setErr(app ? t('Write something in your application') : t('Write something in your post')); return; }
    if (missingTag) { setErr(t('Pick at least one tag')); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/channels/${forumId}/posts`, { title: title.trim(), content: encodeMentions(content.trim(), forum), tags, attachments: ready.map((f) => f.result), theme: withTheme ? { data: currentLook() } : undefined });
      putPost(r.post); closeModal(id); goChannel(forum.serverId, r.post.id);
      if (app) toast(t('Application sent. Orbit will message you when the team decides.'), 'success');
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  return html`<${Modal} title=${app ? t('Apply') : t('New Post')} subtitle=${`#${forum.name}`} width=${560} onClose=${() => closeModal(id)} footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Cancel')}<//><${Btn} variant="primary" loading=${busy} disabled=${files.some((f) => f.status === 'uploading')} onClick=${create}>${app ? t('Send Application') : t('Post')}<//>`}>
    ${forum.topic ? html`<div class="forum-guide"><${Icon} name="info" size=${16} /><span>${forum.topic}</span></div>` : null}
    <${Field} label=${t('Title')} error=${err}><${TextInput} value=${title} onInput=${(v) => { setTitle(v); setErr(null); }} maxlength="100" autofocus placeholder=${app ? t('Give your application a title') : t('What is this post about?')} /><//>
    ${forum.tags?.length ? html`<${Field} label=${forum.requireTag ? `${t('Tags')} (${t('pick at least one')})` : `${t('Tags')} (${t('up to 5')})`}><${TagPicker} forum=${forum} value=${tags} onChange=${setTags} /><//>` : null}
    <${Field} label=${app ? t('Application') : t('Post')}><textarea class="textarea" rows="6" maxlength="4000" value=${content} onInput=${(e) => { setContent(e.target.value); setErr(null); }} placeholder=${app ? t('Tell the team about yourself and your work… markdown and @mentions work here.') : t('Say more… markdown, @mentions and custom emoji work here.')}></textarea><//>
    ${canAttach ? html`<div class="np-files">${files.map((f) => html`<span class="np-file" key=${f.key}><${Icon} name=${/^image\//.test(f.type) ? 'image' : 'file'} size=${14} />${f.name}${f.status === 'uploading' ? html`<${Spinner} size=${12} />` : html`<button type="button" aria-label="Remove" onClick=${() => setFiles((c) => c.filter((x) => x.key !== f.key))}><${Icon} name="x" size=${12} sw=${3} /></button>`}</span>`)}
      <button type="button" class="link-btn" onClick=${() => fileInput.current?.click()}><${Icon} name="paperclip" size=${14} /> ${t('Attach files')}</button><input ref=${fileInput} type="file" multiple hidden onChange=${(e) => { addFiles(e.target.files); e.target.value = ''; }} /></div>` : null}
    <label class="check-row np-theme"><input type="checkbox" checked=${withTheme} onChange=${(e) => { setWithTheme(e.target.checked); setErr(null); }} /><span class="box"><${Icon} name="check" size=${13} sw=${3.5} /></span><span>${t('Attach my current theme')}</span></label>
  <//>`;
};
MODALS['deny-application'] = function DenyApplication({ id, postId }) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const deny = async () => { setBusy(true); const r = await act(api.post(`/channels/${postId}/decision`, { decision: 'deny', reason: reason.trim() })); setBusy(false); if (r) { putPost(r); closeModal(id); } };
  return html`<${Modal} title=${t('Deny application')} width=${440} onClose=${() => closeModal(id)} footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Cancel')}<//><${Btn} variant="danger" loading=${busy} onClick=${deny}>${t('Deny')}<//>`}>
    <${Field} label=${t('Reason (optional)')}><textarea class="textarea" rows="3" maxlength="300" value=${reason} onInput=${(e) => setReason(e.target.value)} placeholder=${t('Orbit sends this to them with the decision.')} autofocus></textarea><//>
  <//>`;
};
/** Above an application's chat while it waits (with Accept / Deny for reviewers), or after it was denied. Accepted ones are ordinary posts. */
export function ApplicationBar({ post }) {
  const [busy, setBusy] = useState(false);
  if (!post.status || post.status === 'accepted') return null;
  if (post.status === 'denied') return html`<div class="app-bar no"><${Icon} name="x-circle" size=${18} /><span><b>${t('Not accepted')}</b>${post.reason ? html` · ${post.reason}` : null}</span></div>`;
  const review = hasPerm(post.serverId, 'ACCESS_APPLICATIONS');
  const accept = async () => { setBusy(true); const r = await act(api.post(`/channels/${post.id}/decision`, { decision: 'accept' })); setBusy(false); if (r) putPost(r); };
  return html`<div class="app-bar wait"><${Icon} name="clock" size=${18} /><span><b>${t('Waiting for a decision')}</b> · ${review ? t('Only the applicant and reviewers can see it until it’s accepted.') : t('Only you and the reviewers can see it until it’s accepted.')}</span>
    ${review ? html`<span class="app-acts"><${Btn} size="sm" variant="primary" icon="check" loading=${busy} onClick=${accept}>${t('Accept')}<//><${Btn} size="sm" variant="danger" icon="x" onClick=${() => openModal('deny-application', { postId: post.id })}>${t('Deny')}<//></span>` : null}</div>`;
}
MODALS['edit-post'] = function EditPost({ id, postId }) {
  const post = state.postIndex[postId]; const forum = post && getChannel(post.forumId);
  const [title, setTitle] = useState(post?.name || ''); const [tags, setTags] = useState(post?.tagIds || []); const [busy, setBusy] = useState(false);
  if (!post || !forum) return null;
  const save = async () => { if (!title.trim()) return; setBusy(true); const r = await act(api.patch(`/channels/${postId}`, { name: title.trim(), tagIds: tags })); setBusy(false); if (r) closeModal(id); };
  return html`<${Modal} title=${t('Edit Post')} width=${460} onClose=${() => closeModal(id)} footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Cancel')}<//><${Btn} variant="primary" loading=${busy} onClick=${save}>${t('Save')}<//>`}>
    <${Field} label=${t('Title')}><${TextInput} value=${title} onInput=${setTitle} maxlength="100" autofocus onKeyDown=${(e) => e.key === 'Enter' && save()} /><//>
    ${forum.tags?.length ? html`<${Field} label=${t('Tags')}><${TagPicker} forum=${forum} value=${tags} onChange=${setTags} /><//>` : null}
  <//>`;
};

/** The ⋯ menu of a post: edit, lock, pin, delete (owners and moderators). */
export function postMenu(post) {
  const mine = post.ownerId === state.me.id; const mod = hasChannelPerm(post, 'MANAGE_MESSAGES') || hasChannelPerm(post, 'MANAGE_CHANNELS');
  return [
    (mine || mod) && { label: t('Edit Post'), icon: 'edit', onClick: () => openModal('edit-post', { postId: post.id }) },
    (mine || mod) && { label: post.locked ? t('Unlock Post') : t('Lock Post'), icon: 'lock', onClick: () => act(api.patch(`/channels/${post.id}`, { locked: !post.locked })) },
    mod && { label: post.pinned ? t('Unpin Post') : t('Pin Post'), icon: 'pin', onClick: () => act(api.patch(`/channels/${post.id}`, { pinned: !post.pinned })) },
    (mine || mod) && { type: 'sep' },
    (mine || mod) && { label: t('Delete Post'), icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog({ title: t('Delete this post?'), body: t('The post and all of its replies will be deleted for good.'), confirmLabel: t('Delete'), danger: true })) act(api.del(`/channels/${post.id}`)); } },
  ].filter(Boolean);
}

/* ------------------------------------------------------------------ the forum itself */
function PostCard({ post, forum, onOpen }) {
  const tags = (post.tagIds || []).map((id) => forum.tags?.find((x) => x.id === id)).filter(Boolean);
  const owner = useSel((s) => s.users[post.ownerId]);
  const preview = plainPreview(post.preview, forum.serverId, 180);
  const pill = post.status === 'pending' ? html`<span class="app-pill wait">${t('Waiting')}</span>` : post.status === 'denied' ? html`<span class="app-pill no">${t('Denied')}</span>` : null;
  return html`<button type="button" class=${cx('post-card', post.pinned && 'pinned', post.locked && 'locked')} onClick=${onOpen}>
    <div class="pc-main">
      <h3>${post.pinned ? html`<${Icon} name="pin" size=${15} class="pc-flag" />` : null}${post.locked ? html`<${Icon} name="lock" size=${14} class="pc-flag" />` : null}${pill}<span>${post.name}</span></h3>
      ${tags.length ? html`<div class="pc-tags">${tags.map((tg) => html`<${TagChip} key=${tg.id} tag=${tg} small=${true} />`)}</div>` : null}
      ${preview ? html`<p class="pc-prev">${preview}</p>` : null}
      <div class="pc-foot"><${Avatar} user=${owner} size=${20} /><b>${nameOf(post.ownerId, forum.serverId)}</b><span>· ${relTime(post.createdAt)}</span><span class="pc-sp"></span>
        <span class="pc-stat"><${Icon} name="message" size=${14} /> ${post.messageCount} ${post.messageCount === 1 ? t('reply') : t('replies')}</span><span class="pc-stat">${t('Active')} ${relTime(post.lastActivity)}</span></div>
    </div>
    ${post.image ? html`<img class="pc-thumb" src=${post.image} alt="" loading="lazy" draggable=${false} />` : null}
  </button>`;
}
export function ForumView() {
  const chId = useSel((s) => s.route.channelId); const forum = useSel((s) => getChannel(s.route.channelId));
  const list = useSel((s) => s.postLists[s.route.channelId]); const index = useSel((s) => s.postIndex);
  const [sort, setSort] = useState('recent'); const [tag, setTag] = useState(''); const [q, setQ] = useState(''); const [qd, setQd] = useState('');
  const [loading, setLoading] = useState(false); const [err, setErr] = useState(null); const [status, setStatus] = useState('pending');
  const app = !!forum?.apply; const review = app && hasPerm(forum.serverId, 'ACCESS_APPLICATIONS'); const st = review ? status : '';   // reviewers pick a tab; everyone else sees the accepted ones (and their own)
  useEffect(() => { const id = setTimeout(() => setQd(q.trim()), 300); return () => clearTimeout(id); }, [q]);
  useEffect(() => { if (!forum) return; setLoading(true); setErr(null); loadPosts(forum.id, { sort, tag, q: qd, status: st }).catch((e) => setErr(errMsg(e))).finally(() => setLoading(false)); }, [chId, sort, tag, qd, st]);
  if (!forum) return html`<main class="main panel"></main>`;
  const byNew = sort === 'new';
  const own = (p) => (app && p.ownerId === state.me.id && p.status !== 'accepted' ? 1 : 0);   // your own waiting / denied application comes first
  const items = (list?.ids || []).map((id) => index[id]).filter(Boolean).sort((a, b) => (own(b) - own(a)) || (Number(!!b.pinned) - Number(!!a.pinned)) || (byNew ? b.createdAt - a.createdAt : b.lastActivity - a.lastActivity));
  const canPost = hasChannelPerm(forum, 'SEND_MESSAGES');
  const mine = app && !review ? items.find((p) => p.ownerId === state.me.id && p.status !== 'denied') : null;   // waiting or accepted: no second application
  const empty = qd || tag ? [t('No posts match'), t('Try another search or tag.')]
    : !app ? [t('No posts yet'), canPost ? t('Start the first conversation with “New Post”.') : t('Nothing has been posted here yet.')]
      : st === 'pending' ? [t('No applications waiting'), t('New applications show up here for you to accept or deny.')]
        : st === 'denied' ? [t('No denied applications'), '']
          : [t('No accepted applications yet'), canPost && !review ? t('Press Apply to send yours. Accepted applications are shown here for everyone.') : t('Accepted applications are shown here for everyone.')];
  return html`<main class="main panel forum-view view-anim" key=${chId}>
    <header class="m-header">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label="Menu"><${Icon} name="menu" size=${22} /></button>
      <div class="m-title"><${Icon} name=${app ? 'file-text' : 'forum'} size=${23} /><span class="name">${forum.name}</span></div>
      ${forum.topic ? html`<div class="m-topic" onClick=${() => openModal('topic', { channelId: forum.id })} title=${forum.topic}>${forum.topic}</div>` : null}
      <div class="m-actions"><label class="m-search"><${Icon} name="search" size=${15} /><input placeholder=${app ? t('Search applications') : t('Search posts')} value=${q} onInput=${(e) => setQ(e.target.value)} /></label></div>
    </header>
    <div class="forum-body">
      <div class="forum-bar">
        ${mine ? html`<${Btn} icon="file-text" onClick=${() => goChannel(forum.serverId, mine.id)}>${t('Your application')}<//>`
          : canPost ? html`<${Btn} variant="primary" icon=${app ? 'file-text' : 'plus'} onClick=${() => openModal('new-post', { forumId: forum.id })}>${app ? t('Apply') : t('New Post')}<//>` : null}
        ${review ? html`<div class="forum-tags">${[['pending', t('Waiting')], ['accepted', t('Accepted')], ['denied', t('Denied')]].map(([k, l]) => html`<${TagChip} key=${k} tag=${{ name: list?.counts ? `${l} (${list.counts[k]})` : l }} on=${st === k} onClick=${() => setStatus(k)} />`)}</div>` : null}
        <${Dropdown} width=${190} value=${sort} options=${[{ value: 'recent', label: t('Recent activity') }, { value: 'new', label: t('Newest posts') }]} onChange=${setSort} />
        ${forum.tags?.length ? html`<div class="forum-tags"><${TagChip} tag=${{ name: t('All') }} on=${!tag} onClick=${() => setTag('')} />${forum.tags.map((tg) => html`<${TagChip} key=${tg.id} tag=${tg} on=${tag === tg.id} onClick=${() => setTag(tag === tg.id ? '' : tg.id)} />`)}</div>` : null}
      </div>
      <div class="forum-list">
        ${err ? html`<${Empty} icon="alert-circle" title=${t('Couldn’t load posts')}>${err}<//>`
          : items.length ? items.map((p) => html`<${PostCard} key=${p.id} post=${p} forum=${forum} onOpen=${() => goChannel(forum.serverId, p.id)} />`)
            : loading ? html`<div class="pk-center"><${Spinner} /></div>`
              : html`<${Empty} icon=${app ? 'file-text' : 'forum'} title=${empty[0]}>${empty[1]}<//>`}
        ${list?.hasMore ? html`<div class="forum-more"><${Btn} onClick=${() => loadPosts(forum.id, { sort, tag, q: qd, status: st }, true).catch((e) => toast(errMsg(e), 'error'))}>${t('Load more')}<//></div>` : null}
      </div>
    </div>
  </main>`;
}
