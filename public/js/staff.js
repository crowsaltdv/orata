// Orata — the Staff page (/staff, the shield under the + in the server rail) for holders of the staff or dev badge, and the "Report to Orata
// staff" window everyone has. The server (server/staff.js) decides who may do what; this only shows it.
import { html, useState, useEffect, relTime, formatFull, cx } from '/js/lib.js';
import { state, set, useSel, openModal, closeModal, addUsers, rebuildIndex, go, goChannel } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Modal, Btn, Spinner, Avatar, Empty, Dropdown, Field, ServerIcon, MODALS } from '/js/ui.js';
import { renderMarkdown } from '/js/markdown.js';
import { ServerTag } from '/js/server-tag.js';
import { api } from '/js/api.js';
import { act, errMsg } from '/js/actions.js';
import { openProfile } from '/js/sidebar.js';
import { t } from '/js/i18n.js';

/** Does the signed-in person have the staff or dev badge? (The server checks again.) */
export const isStaffMe = () => !!state.me?.badges?.some((b) => b.id === 'staff' || b.id === 'dev');

// what can be reported: what the Community Guidelines (/guidelines) forbid (server/staff.js has the same list)
const REASONS = [['hate', 'Hate speech'], ['threats', 'Threats or violent extremism'], ['self-harm', 'Self-harm or suicide'], ['child-safety', 'Sexualizing minors'], ['nonconsensual', 'Intimate images shared without consent'],
  ['nsfw', 'Adult or gory content where it isn’t allowed'], ['privacy', 'Sharing someone’s private info'], ['scam', 'Scam, phishing or malware'], ['impersonation', 'Pretending to be someone or Orata staff'],
  ['ban-evasion', 'Dodging a ban with another account'], ['illegal', 'Illegal goods, services or piracy'], ['misinformation', 'Harmful misinformation']];
/** Report a message (messageId + channelId), an account (userId) or a server (serverId) to Orata staff. */
MODALS.report = function Report({ id, messageId, channelId, userId, serverId }) {
  const [reason, setReason] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const send = async () => { setBusy(true); if (await act(api.post('/reports', { messageId, channelId, userId, serverId, reason, note }))) setDone(true); setBusy(false); };
  return html`<${Modal} title=${messageId ? t('Report message') : serverId ? t('Report server') : t('Report account')} subtitle=${t('Pick which of Orata’s Community Guidelines it breaks. It goes to Orata staff; a server’s own rules are up to its moderators.')} width=${460} onClose=${() => closeModal(id)}
    footer=${done ? html`<${Btn} variant="primary" onClick=${() => closeModal(id)}>${t('Done')}<//>` : html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Cancel')}<//><${Btn} variant="danger" icon="flag" loading=${busy} disabled=${!reason} onClick=${send}>${t('Send report')}<//>`}>
    ${done ? html`<div class="rep-done"><${Icon} name="check-circle" size=${40} sw=${1.6} /><b>${t('Thanks, staff will take a look.')}</b><p>${t('If it was in a DM, staff can read that conversation around the message you reported, and nothing else.')}</p></div>`
      : html`<div class="rep-reasons">${REASONS.map(([k, label]) => html`<button type="button" key=${k} class=${cx('rep-opt', reason === k && 'on')} onClick=${() => setReason(k)}><span class="radio"></span>${t(label)}</button>`)}</div>
        <textarea class="textarea" rows="3" maxlength="500" value=${note} onInput=${(e) => setNote(e.target.value)} placeholder=${t('Anything staff should know (optional)')}></textarea>`}
  <//>`;
};

const TABS = [['overview', 'bar-chart', 'Overview'], ['accounts', 'users', 'Accounts'], ['servers', 'server', 'Servers'], ['dms', 'message', 'DMs'], ['flags', 'flag', 'Flags & reports'], ['log', 'list', 'Staff log']];
export function StaffPage() {
  const [tab, setTab] = useState('overview');
  if (!isStaffMe()) return html`<main class="main panel staff-page"><${Empty} icon="shield" title=${t('Staff only')}>${t('This page is for Orata staff.')}<//></main>`;
  return html`<main class="main panel staff-page view-anim">
    <header class="m-header">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label=${t('Menu')}><${Icon} name="menu" size=${22} /></button>
      <div class="m-title"><${Icon} name="shield" size=${23} /><span class="name">${t('Staff')}</span></div>
      <div class="staff-tabs">${TABS.map(([k, ic, label]) => html`<button type="button" key=${k} class=${cx('staff-tab', tab === k && 'on')} onClick=${() => setTab(k)}><${Icon} name=${ic} size=${16} />${t(label)}</button>`)}</div>
    </header>
    <div class="staff-scroll">${tab === 'overview' ? html`<${Overview} go=${setTab} />` : tab === 'accounts' ? html`<${Accounts} />` : tab === 'servers' ? html`<${Servers} />` : tab === 'dms' ? html`<${Dms} />` : tab === 'flags' ? html`<${Flags} />` : html`<${Log} />`}</div>
  </main>`;
}

function Overview({ go }) {
  const [d, setD] = useState(null);
  const load = () => api.get('/staff/overview').then(setD, () => setD({ error: true }));
  useEffect(() => { load(); }, []);
  const run = async (u, what) => { if (await moderate(u, what)) load(); };
  if (!d) return html`<div class="pk-center"><${Spinner} /></div>`;
  if (d.error) return html`<p class="text-danger">${t('Couldn’t load the numbers.')}</p>`;
  const s = d.stats;
  const tiles = [['users', s.accounts, 'Active accounts'], ['globe', s.online, 'Online now'], ['user-plus', s.newToday, 'New accounts today'], ['server', s.servers, 'Servers'],
    ['flag', s.openFlags, 'Open flags', 'flags'], ['alert-triangle', s.openReports, 'Open reports', 'flags'], ['lock', s.locked, 'Locked accounts'], ['ban', s.terminated, 'Terminated accounts']];
  return html`<div class="staff-grid">${tiles.map(([ic, n, label, tab]) => html`<button type="button" class=${cx('stat-tile', tab && n && 'link')} key=${label} disabled=${!(tab && n)} onClick=${() => go(tab)}><${Icon} name=${ic} size=${20} /><b>${Number(n).toLocaleString()}</b><span>${t(label)}</span></button>`)}</div>
    <h3 class="staff-h">${t('Needs a look')}</h3>
    ${d.attention.length ? html`<div class="mem-table">${d.attention.map((u) => html`<${UserRow} key=${u.id} u=${u} run=${run} why=${u.why} />`)}</div>`
      : html`<p class="text-muted">${t('No open flags or reports.')}</p>`}
    ${d.locked.length ? html`<h3 class="staff-h">${t('Locked right now')}</h3><div class="mem-table">${d.locked.map((u) => html`<${UserRow} key=${u.id} u=${u} run=${run} />`)}</div>` : null}
    <h3 class="staff-h">${t('Newest accounts')}</h3>
    <div class="mem-table">${d.newest.map((u) => html`<${UserRow} key=${u.id} u=${u} run=${run} />`)}</div>
    <h3 class="staff-h">${t('Staff team')}</h3>
    <div class="mem-table">${d.team.map((u) => html`<div class="mem-row" key=${u.id}><${Avatar} user=${u} size=${36} /><div class="mem-name"><b>${u.displayName}</b><small>@${u.username}${u.founder ? ` · ${t('founder')}` : ''}</small></div>
      <small class="mem-join">${u.actions} ${u.actions === 1 ? t('action') : t('actions')} ${t('in 30 days')}</small></div>`)}</div>`;
}

const STATE = { active: ['Active', ''], locked: ['Locked', 'warn'], terminated: ['Terminated', 'bad'] };
function StateChip({ u }) { const [label, c] = STATE[u.state] || STATE.active; return html`<span class=${cx('state-chip', c)}>${t(label)}${u.state === 'locked' && u.lockedUntil ? ` ${t('until')} ${new Date(u.lockedUntil).toLocaleString()}` : ''}</span>`; }

const HOURS = [[1, '1 hour'], [6, '6 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week'], [720, '30 days']];
/** Asks why (and, for a lock, how long). Resolves { reason, hours } or null. */
MODALS['staff-action'] = function StaffAction({ id, title, body, confirmLabel, lock, resolve }) {
  const [reason, setReason] = useState(''); const [hours, setHours] = useState(24);
  const done = (v) => { closeModal(id); resolve(v); };
  return html`<${Modal} title=${title} width=${440} onClose=${() => done(null)}
    footer=${html`<${Btn} variant="ghost" onClick=${() => done(null)}>${t('Cancel')}<//><${Btn} variant="danger" disabled=${!reason.trim()} onClick=${() => done({ reason: reason.trim(), hours })}>${confirmLabel}<//>`}>
    <p class="confirm-body">${body}</p>
    ${lock ? html`<${Field} label=${t('How long')}><${Dropdown} value=${hours} options=${HOURS.map(([value, label]) => ({ value, label: t(label) }))} onChange=${setHours} /><//>` : null}
    <${Field} label=${t('Reason (they see it)')}><textarea class="textarea" rows="3" maxlength="300" value=${reason} onInput=${(e) => setReason(e.target.value)} autofocus></textarea><//>
  <//>`;
};
/** Lock / unlock / terminate / unterminate (asking why for the first two). Resolves with the updated row. */
async function moderate(u, what) {
  if (what === 'lock' || what === 'terminate') {
    const a = await new Promise((resolve) => openModal('staff-action', what === 'lock'
      ? { title: `${t('Lock')} ${u.displayName}`, body: t('They are signed out and can’t sign in until the lock ends.'), confirmLabel: t('Lock'), lock: true, resolve }
      : { title: `${t('Terminate')} ${u.displayName}`, body: t('They are signed out, removed from every server they don’t own, and can never sign in again. Staff can undo it.'), confirmLabel: t('Terminate'), resolve }));
    return a ? act(api.post(`/staff/users/${u.id}/${what}`, a)) : null;
  }
  return act(api.post(`/staff/users/${u.id}/${what}`, {}));
}

function Accounts() {
  const [q, setQ] = useState(''); const [list, setList] = useState(null); const [open, setOpen] = useState(null);
  const load = (query = q) => api.get(`/staff/users?q=${encodeURIComponent(query)}`).then(setList, () => setList([]));
  useEffect(() => { const id = setTimeout(() => load(q), 250); return () => clearTimeout(id); }, [q]);
  const run = async (u, what) => { const r = await moderate(u, what); if (r) { setList((l) => l.map((x) => (x.id === r.id ? r : x))); if (open?.id === r.id) setOpen({ ...open, ...r }); } };
  return html`<div class="staff-bar"><div class="input-wrap staff-search"><${Icon} name="search" size=${18} class="in-icon" /><input class="input" placeholder=${t('Search by username, name or ID…')} value=${q} onInput=${(e) => setQ(e.target.value)} /></div></div>
    ${!list ? html`<div class="pk-center"><${Spinner} /></div>` : !list.length ? html`<${Empty} icon="users" title=${t('Nobody found')} />`
      : html`<div class="mem-table">${list.map((u) => html`<${UserRow} key=${u.id} u=${u} run=${run} sel=${open?.id === u.id}>
          <${Btn} size="sm" variant="ghost" onClick=${() => (open?.id === u.id ? setOpen(null) : api.get(`/staff/users/${u.id}`).then(setOpen))}>${open?.id === u.id ? t('Close') : t('Details')}<//><//>
        ${open?.id === u.id ? html`<${AccountDetail} d=${open} />` : null}`)}</div>`}`;
}
/** One account: who, how old, alts and open flags (and `why`, what those flags are about), its state, and Lock / Unlock / Terminate. `children` go before those buttons. */
function UserRow({ u, run, sel, why, children }) {
  return html`<div class=${cx('mem-row staff-row', sel && 'sel')}>
    <${Avatar} user=${u} size=${36} onClick=${(e) => openProfile(u.id, e.currentTarget)} />
    <div class="mem-name"><b>${u.displayName} ${u.staff ? html`<span class="state-chip">${t('staff')}</span>` : null}</b><small>@${u.username} · ${t('joined')} ${relTime(u.createdAt)} · ${u.servers} ${t('servers')}${u.alts ? ` · ${u.alts} ${t('other accounts on their browser')}` : ''}${u.openFlags ? ` · ${u.openFlags} ${t('open flags')}` : ''}</small>
      ${why ? html`<span class="staff-why">${why.map((w) => html`<span class=${cx('flag-kind', w.startsWith('Reported') && 'report')} key=${w}>${w}</span>`)}</span>` : null}</div>
    <${StateChip} u=${u} />
    <span class="staff-acts">${children}
      ${u.founder || u.id === state.me?.id ? null : u.state === 'terminated' ? html`<${Btn} size="sm" onClick=${() => run(u, 'unterminate')}>${t('Undo termination')}<//>`
        : html`${u.state === 'locked' ? html`<${Btn} size="sm" onClick=${() => run(u, 'unlock')}>${t('Unlock')}<//>` : html`<${Btn} size="sm" icon="lock" onClick=${() => run(u, 'lock')}>${t('Lock')}<//>`}
          <${Btn} size="sm" variant="danger" icon="ban" onClick=${() => run(u, 'terminate')}>${t('Terminate')}<//>`}</span></div>`;
}
function AccountDetail({ d }) {
  return html`<div class="staff-detail">
    ${d.terminated ? html`<p class="text-danger">${t('Terminated')} ${relTime(d.terminated.at)}: ${d.terminated.reason}</p>` : null}
    ${d.state === 'locked' ? html`<p class="text-warn">${t('Locked until')} ${new Date(d.lockedUntil).toLocaleString()}: ${d.lockReason}</p>` : null}
    <div><b>${t('Servers')}</b> ${d.serverList.length ? d.serverList.map((s) => html`<span class="state-chip" key=${s.id}>${s.name}${s.owner ? ` (${t('owner')})` : ''}</span>`) : html`<small class="text-muted">${t('none')}</small>`}</div>
    <div><b>${t('Other accounts on their browser')}</b> ${d.altList.length ? d.altList.map((u) => html`<span class="state-chip" key=${u.id}>@${u.username}</span>`) : html`<small class="text-muted">${t('none')}</small>`}</div>
    ${d.flags.length ? html`<div><b>${t('Flags')}</b>${d.flags.map((f) => html`<div class="staff-mini" key=${f.id}>${f.reportedBy ? t('Report') : t('Auto')}: ${f.reason} · ${f.detail || ''} · ${relTime(f.at)} · ${f.status}</div>`)}</div>` : null}
    ${d.log.length ? html`<div><b>${t('Staff actions')}</b>${d.log.map((e) => html`<div class="staff-mini" key=${e.id}>${e.action}${e.reason ? ` · ${e.reason}` : ''} · ${relTime(e.at)}</div>`)}</div>` : null}
  </div>`;
}

/** Opens a server you aren't in, read only and invisible (the server writes it in the staff log). Leave from the banner or the server's menu. */
export async function ghostIn(serverId, channelId = null) {
  if (state.servers[serverId] && !state.servers[serverId].ghost) return goChannel(serverId, channelId);   // you're in it anyway
  const r = await act(api.post(`/staff/servers/${serverId}/ghost`)); if (!r) return;
  addUsers(r.users); set({ servers: { ...state.servers, [r.server.id]: { ...r.server, ghost: true } } }); rebuildIndex(); goChannel(r.server.id, null);
}
export function leaveGhost(serverId) {
  api.del(`/staff/servers/${serverId}/ghost`).catch(() => {});
  const servers = { ...state.servers }; delete servers[serverId]; set({ servers }); rebuildIndex(); go({ view: 'staff', serverId: '@me', channelId: null });
}

function Servers() {
  const [q, setQ] = useState(''); const [list, setList] = useState(null);
  useEffect(() => { const id = setTimeout(() => api.get(`/staff/servers?q=${encodeURIComponent(q)}`).then(setList, () => setList([])), 250); return () => clearTimeout(id); }, [q]);
  const row = (s) => html`<div class="mem-row staff-row" key=${s.id}><${ServerIcon} server=${s} size=${36} />
    <div class="mem-name"><b>${s.name}${s.tag ? html`<${ServerTag} tag=${s.tag} />` : null}</b><small>${s.members} ${t('members')} · ${t('owner')} @${s.owner?.username || '?'} · ${t('made')} ${relTime(s.createdAt)}${s.joinMode === 'apply' ? ` · ${t('apply to join')}` : ''}</small>
      ${s.score ? html`<span class="staff-why">${[s.reports && [`${s.reports} ${s.reports === 1 ? t('report') : t('reports')}`, 'report'], s.flagged && [`${s.flagged} ${s.flagged === 1 ? t('flagged message') : t('flagged messages')}`], s.terminated && [`${s.terminated} ${s.terminated === 1 ? t('terminated member') : t('terminated members')}`, 'report'], s.scamName && [t('Scam-looking name')]]
        .filter(Boolean).map(([w, c]) => html`<span class=${cx('flag-kind', c)} key=${w}>${w}</span>`)}</span>` : null}</div>
    <span class="staff-acts">${s.canGhost ? html`<${Btn} size="sm" icon="eye" onClick=${() => ghostIn(s.id)}>${t('Ghost in')}<//>` : null}</span></div>`;
  const fishy = (list || []).filter((s) => s.canGhost); const rest = (list || []).filter((s) => !s.canGhost);
  return html`<div class="staff-bar"><div class="input-wrap staff-search"><${Icon} name="search" size=${18} class="in-icon" /><input class="input" placeholder=${t('Search servers by name or ID…')} value=${q} onInput=${(e) => setQ(e.target.value)} /></div></div>
    <p class="text-muted">${t('You can only ghost into a server that was reported, has flagged messages or a scam-looking name. Nobody there sees you, you can’t post or react, and it goes in the staff log.')}</p>
    ${!list ? html`<div class="pk-center"><${Spinner} /></div>` : !list.length ? html`<${Empty} icon="server" title=${t('No servers found')} />` : html`
      ${fishy.length ? html`<h3 class="staff-h">${t('Looks fishy')}</h3><div class="mem-table">${fishy.map(row)}</div>` : null}
      ${rest.length ? html`<h3 class="staff-h">${fishy.length ? t('Everything else') : t('All servers')}</h3><div class="mem-table">${rest.map(row)}</div>` : null}`}`;
}

/** The DM a flagged or reported message is in (50 messages either side), read only. Staff can only get here from a flag; the server logs each look. */
MODALS['staff-dm'] = function StaffDm({ id, flagId }) {
  const [d, setD] = useState(null); const users = useSel((s) => s.users);
  useEffect(() => { api.get(`/staff/flags/${flagId}/conversation`).then((r) => { addUsers(r.users); setD(r); }, (e) => setD({ error: errMsg(e) })); }, []);
  useEffect(() => { if (d?.messages) document.querySelector('.sdm-msg.flagged')?.scrollIntoView({ block: 'center' }); }, [d]);
  return html`<${Modal} title=${d?.group ? t('Flagged group DM') : t('Flagged DM')} subtitle=${t('Read only. Opening this is written in the staff log.')} width=${620} onClose=${() => closeModal(id)}>
    ${!d ? html`<div class="pk-center"><${Spinner} /></div>` : d.error ? html`<p class="text-danger">${d.error}</p>` : html`<div class="staff-dm">${d.messages.filter((m) => m.type === "default").map((m) => { const u = users[m.authorId]; return html`<div class=${cx('sdm-msg', m.id === d.flagged && 'flagged')} key=${m.id}>
      <${Avatar} user=${u} size=${32} /><div class="sdm-body"><div class="sdm-head"><b>${u?.displayName || '?'}</b><small>${formatFull(m.createdAt)}</small></div>
        ${m.content ? html`<div class="sdm-text" dangerouslySetInnerHTML=${{ __html: renderMarkdown(m.content, { emojis: m.emojis }) }}></div>` : null}
        ${(m.attachments || []).map((a) => html`<a class="sdm-file" key=${a.url} href=${a.url} target="_blank" rel="noopener">${/^image\//.test(a.type) ? html`<img src=${a.url} alt=${a.name} />` : a.name}</a>`)}
        ${m.gif ? html`<small class="text-muted">[GIF]</small>` : null}${m.sticker ? html`<small class="text-muted">[${t('sticker')}]</small>` : null}</div></div>`; })}</div>`}
  <//>`;
};

/** Every DM and group DM with a flagged or reported message; Read opens the conversation around the latest one. */
function Dms() {
  const [list, setList] = useState(null);
  useEffect(() => { api.get('/staff/dms').then((r) => { addUsers(r.flatMap((c) => c.recipients)); setList(r); }, () => setList([])); }, []);
  if (!list) return html`<div class="pk-center"><${Spinner} /></div>`;
  return html`<p class="text-muted">${t('DMs and group DMs are private. They show up here only when a message in them was reported or flagged, and you can only read around that message. Each look goes in the staff log.')}</p>
    ${!list.length ? html`<${Empty} icon="message" title=${t('No flagged DMs')} />` : html`<div class="mem-table">${list.map((c) => html`<div class="mem-row staff-row" key=${c.id}>
      <span class="sdm-avs">${c.recipients.slice(0, 3).map((u) => html`<${Avatar} key=${u.id} user=${u} size=${28} />`)}</span>
      <div class="mem-name"><b>${c.group ? c.name || t('Group DM') : c.recipients.map((u) => u.displayName).join(' & ')} <span class="state-chip">${c.group ? `${t('Group DM')} · ${c.recipients.length}` : t('DM')}</span></b>
        <small>${c.group ? `${c.recipients.map((u) => '@' + u.username).join(', ')} · ` : ''}${c.open} ${t('open')} / ${c.total} ${c.total === 1 ? t('flag') : t('flags')} · ${t('latest')} ${relTime(c.last.at)}</small>
        <span class="staff-why"><span class=${cx('flag-kind', c.last.reportedBy && 'report')}>${c.last.label}</span>${c.last.excerpt ? html`<small class="sdm-excerpt">“${c.last.excerpt}”</small>` : null}</span></div>
      <span class="staff-acts"><${Btn} size="sm" icon="message" onClick=${() => openModal('staff-dm', { flagId: c.last.id })}>${t('Read')}<//></span></div>`)}</div>`}`;
}

function Flags() {
  const [all, setAll] = useState(false); const [jokes, setJokes] = useState(false); const [d, setD] = useState(null);   // jokes: the reports that look fake
  const load = () => api.get(`/staff/flags?${all ? 'status=all&' : ''}${jokes ? 'hidden=1' : ''}`).then((r) => { addUsers(r.users); setD(r); }, (e) => setD({ error: errMsg(e) }));
  useEffect(() => { setD(null); load(); }, [all, jokes]);
  const users = useSel((s) => s.users);
  const handle = async (f, action) => { const r = await act(api.post(`/staff/flags/${f.id}`, { action })); if (r) setD((x) => ({ ...x, flags: all ? x.flags.map((y) => (y.id === f.id ? r : y)) : x.flags.filter((y) => y.id !== f.id) })); };
  const userAct = async (uid, what) => { const u = users[uid]; if (u && await moderate(u, what)) load(); };
  if (!d) return html`<div class="pk-center"><${Spinner} /></div>`;
  if (d.error) return html`<p class="text-danger">${d.error}</p>`;
  return html`<div class="staff-bar"><p class="text-muted">${t('Accounts and messages Orata found suspicious, and what people reported. Server rules are each server’s business.')}</p>
      <label class="staff-lock-len"><input type="checkbox" checked=${all} onChange=${(e) => setAll(e.target.checked)} /> ${t('Show handled ones too')}</label>
      <label class="staff-lock-len"><input type="checkbox" checked=${jokes} onChange=${(e) => setJokes(e.target.checked)} /> ${t('Only reports that look fake')} (${d.hidden || 0})</label></div>
    ${!d.flags.length ? html`<${Empty} icon="check-circle" title=${t('Nothing to look at')}>${t('No open flags or reports.')}<//>`
      : html`<div class="flag-list">${d.flags.map((f) => { const u = users[f.userId]; const by = f.reportedBy && users[f.reportedBy]; return html`<div class=${cx('flag-row', f.status !== 'open' && 'done')} key=${f.id}>
        <div class="flag-top"><span class=${cx('flag-kind', f.reportedBy && 'report')}><${Icon} name=${f.reportedBy ? 'alert-triangle' : 'flag'} size=${14} />${f.label}</span>
          <span class="flag-who" onClick=${(e) => u && openProfile(u.id, e.currentTarget)}><${Avatar} user=${u} size=${22} /><b>${u?.displayName || '?'}</b><small>@${u?.username || '?'}</small></span>
          <small class="flag-when" title=${formatFull(f.at)}>${relTime(f.at)}${f.where ? ` · ${f.where}` : ''}</small></div>
        ${f.detail && f.detail !== 'reported' ? html`<div class="flag-detail">${f.detail}</div>` : null}
        ${f.excerpt ? html`<blockquote class="flag-excerpt">${f.excerpt}${f.gone ? html` <small>(${t('already deleted')})</small>` : null}</blockquote>` : null}
        ${by ? html`<div class="flag-detail">${t('Reported by')} ${by.displayName}${f.note ? `: “${f.note}”` : ''}</div>` : null}
        ${f.hidden ? html`<div class="flag-detail flag-hidden"><${Icon} name="eye-off" size=${14} />${t('Hidden from staff because')} ${f.hidden}.</div>` : null}
        ${f.doubt ? html`<div class="flag-detail flag-hidden"><span class="flag-kind">${t('Looks like a joke')}</span>${f.doubt}. ${t('Shown anyway because of what it’s about.')}</div>` : null}
        <div class="flag-acts">${f.status === 'open' ? html`
          ${f.messageId && !f.gone ? html`<${Btn} size="sm" variant="danger" icon="trash" onClick=${() => handle(f, 'delete')}>${t('Delete message')}<//>` : null}
          ${f.hidden || f.doubt ? html`<${Btn} size="sm" icon="check" onClick=${() => handle(f, 'unhide')}>${t('Not a joke')}<//>` : null}
          ${f.serverId && !f.hidden ? html`<${Btn} size="sm" icon="eye" onClick=${() => ghostIn(f.serverId, f.channelId)}>${t('Ghost in')}<//>` : null}
          ${f.channelId && !f.serverId && !f.hidden ? html`<${Btn} size="sm" icon="message" onClick=${() => openModal('staff-dm', { flagId: f.id })}>${t('Read the DM')}<//>` : null}
          <${Btn} size="sm" icon="lock" onClick=${() => userAct(f.userId, 'lock')}>${t('Lock account')}<//>
          <${Btn} size="sm" variant="danger" icon="ban" onClick=${() => userAct(f.userId, 'terminate')}>${t('Terminate')}<//>
          <${Btn} size="sm" variant="ghost" onClick=${() => handle(f, 'dismiss')}>${t('Dismiss')}<//>`
          : html`<small class="text-muted">${f.status === 'done' ? t('Message deleted') : t('Dismissed')}${f.handledBy && users[f.handledBy] ? ` ${t('by')} ${users[f.handledBy].displayName}` : ''}</small><${Btn} size="sm" variant="ghost" onClick=${() => handle(f, 'reopen')}>${t('Reopen')}<//>`}</div>
      </div>`; })}</div>`}`;
}

const ACTION = { terminate: 'terminated', unterminate: 'undid the termination of', lock: 'locked', unlock: 'unlocked', delete_message: 'deleted a flagged message by', dismiss_flag: 'dismissed a flag about', ghost: 'ghosted into', view_dm: 'read a flagged DM of', unhide_flag: 'said a report wasn’t a joke, about', unpublish_theme: 'removed a theme from Discovery by' };
function Log() {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/staff/log').then((r) => { addUsers(r.users); setD(r); }, () => setD({ log: [] })); }, []);
  const users = useSel((s) => s.users);
  if (!d) return html`<div class="pk-center"><${Spinner} /></div>`;
  if (!d.log.length) return html`<${Empty} icon="list" title=${t('No staff actions yet')} />`;
  return html`<div class="al-list">${d.log.map((e) => html`<div class="al-row" key=${e.id}><span class=${cx('al-ic', ['terminate', 'lock', 'delete_message'].includes(e.action) && 'bad')}><${Icon} name=${e.action.includes('lock') ? 'lock' : e.action.includes('terminate') ? 'ban' : e.action === 'ghost' ? 'eye' : e.action === 'view_dm' ? 'message' : 'flag'} size=${16} /></span>
    <div class="al-text"><div><b>${users[e.by]?.displayName || '?'}</b> ${t(ACTION[e.action] || e.action)} <b>${e.action === 'ghost' ? e.serverName : users[e.target]?.displayName || '?'}</b>${e.hours ? ` ${t('for')} ${HOURS.find(([h]) => h === e.hours)?.[1] || `${e.hours}h`}` : ''}</div>${e.reason ? html`<small>${t('Reason')}: ${e.reason}</small>` : null}</div>
    <time title=${formatFull(e.at)}>${relTime(e.at)}</time></div>`)}</div>`;
}
