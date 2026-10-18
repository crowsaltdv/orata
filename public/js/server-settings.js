// Orate — server settings overlay (overview, roles, channels, members, invites, bans).
import { html, useState, useEffect, useRef, cx, formatMemberSince, relTime, copyText } from '/js/lib.js';
import { state, set, useSel, openModal, closeModal, toast, hasPerm, go, memberOf, addUsers } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Btn, Field, TextInput, Toggle, SettingRow, Section, Modal, MODALS, Avatar, ServerIcon, ColorSwatch, Dropdown, Empty, confirmDialog, useEscape, Spinner } from '/js/ui.js';
import { api } from '/js/api.js';
import { act, errMsg } from '/js/actions.js';
import { chooseAndUploadImage } from '/js/imageutil.js';
import { inviteUrl } from '/js/modals.js';
import { deleteServer } from '/js/rail.js';
import { deleteChannel } from '/js/sidebar.js';
import { t } from '/js/i18n.js';
import { PERM_INFO, PERM_ORDER } from '/js/perms.js';

export function openServerSettings(id, page = 'overview') { set({ serverSettings: { id, page }, ctx: null, popover: null }); }
const close = () => set({ serverSettings: null });

/* ------------------------------------------------------------------ overview */
function Overview({ server }) {
  const [d, setD] = useState({ name: server.name, description: server.description, icon: server.icon, banner: server.banner, systemChannelId: server.systemChannelId });
  const [busy, setBusy] = useState(false); const [up, setUp] = useState(null);
  const orig = { name: server.name, description: server.description, icon: server.icon, banner: server.banner, systemChannelId: server.systemChannelId };
  const dirty = JSON.stringify(d) !== JSON.stringify(orig);
  const can = hasPerm(server.id, 'MANAGE_SERVER');
  const img = async (key, opts) => { setUp(key); try { const u = await chooseAndUploadImage(opts); if (u) setD((p) => ({ ...p, [key]: u })); } catch (e) { toast(errMsg(e), 'error'); } setUp(null); };
  const save = async () => { setBusy(true); await act(api.patch(`/servers/${server.id}`, d), { success: 'Server updated' }); setBusy(false); };
  const texts = server.channels.filter((c) => c.type === 'text');
  return html`<div class="s-page">
    <${Section} title=${t('Server overview')}>
      <div class="so-top"><div class="so-icon"><${ServerIcon} server=${{ ...server, ...d }} size=${96} class="so-ic" />
        ${can ? html`<div class="pe-btns"><${Btn} icon="upload" size="sm" variant="primary" loading=${up === 'icon'} onClick=${() => img('icon', { aspect: 1, out: 256, round: true, title: 'Server Icon' })}>${t('Upload icon')}<//>${d.icon ? html`<${Btn} size="sm" variant="ghost" onClick=${() => setD({ ...d, icon: null })}>${t('Remove')}<//>` : null}</div>` : null}</div>
        <div class="so-fields"><${Field} label=${t('Server name')}><${TextInput} value=${d.name} onInput=${(v) => setD({ ...d, name: v })} maxlength="100" disabled=${!can} /><//>
          <${Field} label=${t('Description')}><textarea class="textarea" rows="3" maxlength="300" value=${d.description} onInput=${(e) => setD({ ...d, description: e.target.value })} disabled=${!can}></textarea><//></div></div>
    <//>
    <${Section} title=${t('Banner')} desc=${t('Shown at the top of the channel list.')}>
      <div class="so-banner" style=${d.banner ? { backgroundImage: `url("${d.banner}")` } : null}>${!d.banner ? html`<span>${t('No banner')}</span>` : null}</div>
      ${can ? html`<div class="pe-btns"><${Btn} icon="image" size="sm" variant="primary" loading=${up === 'banner'} onClick=${() => img('banner', { aspect: 3, out: 960, title: 'Server Banner' })}>${t('Upload banner')}<//>${d.banner ? html`<${Btn} size="sm" variant="ghost" onClick=${() => setD({ ...d, banner: null })}>${t('Remove')}<//>` : null}</div>` : null}
    <//>
    <${Section} title=${t('System messages')}>
      <${SettingRow} title=${t('Join messages channel')} desc=${t('Where “member joined” notices appear.')}><${Dropdown} width=${200} value=${d.systemChannelId} options=${texts.map((c) => ({ value: c.id, label: '# ' + c.name }))} onChange=${(v) => setD({ ...d, systemChannelId: v })} /><//>
    <//>
    ${server.ownerId === state.me.id ? html`<${Section} title=${t('Danger zone')}>
      <div class="danger-zone"><div class="btn-row"><${Btn} icon="crown" onClick=${() => openModal('transfer', { serverId: server.id })}>${t('Transfer ownership')}<//><${Btn} variant="danger" icon="trash" onClick=${() => deleteServer(server)}>${t('Delete server')}<//></div></div><//>` : null}
    ${dirty && can ? html`<div class="save-bar slide-up"><span><${Icon} name="alert-triangle" size=${18} /> ${t('Careful — you have unsaved changes!')}</span><${Btn} variant="ghost" onClick=${() => setD(orig)}>${t('Reset')}<//><${Btn} variant="primary" loading=${busy} onClick=${save}>${t('Save Changes')}<//></div>` : null}
  </div>`;
}
MODALS.transfer = function Transfer({ id, serverId }) {
  const s = state.servers[serverId]; const [to, setTo] = useState(null);
  const members = s.members.filter((m) => m.id !== state.me.id && !state.users[m.id]?.bot);
  return html`<${Modal} title="Transfer ownership" subtitle="The new owner gets full control. You become a regular member." width=${440} onClose=${() => closeModal(id)} footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>Cancel<//><${Btn} variant="danger" disabled=${!to} onClick=${async () => { await act(api.post(`/servers/${serverId}/transfer`, { userId: to }), { success: 'Ownership transferred' }); closeModal(id); }}>Transfer<//>`}>
    <div class="pick-list">${members.map((m) => html`<label class=${cx('pick-row', to === m.id && 'sel')} key=${m.id}><${Avatar} user=${state.users[m.id]} size=${34} /><span><b>${state.users[m.id]?.displayName}</b><small>${state.users[m.id]?.username}</small></span><input type="radio" name="tf" checked=${to === m.id} onChange=${() => setTo(m.id)} /><span class="box"><${Icon} name="check" size=${13} sw=${3.5} /></span></label>`)}</div><//>`;
};

/* ------------------------------------------------------------------ roles */
function Roles({ server }) {
  const roles = [...server.roles].sort((a, b) => b.position - a.position);
  const [sel, setSel] = useState(roles.find((r) => r.id !== server.id)?.id || server.id);
  const role = server.roles.find((r) => r.id === sel) || roles[0];
  const [d, setD] = useState({ name: role.name, color: role.color, hoist: role.hoist, permissions: role.permissions }); const [busy, setBusy] = useState(false);
  useEffect(() => { const r = server.roles.find((x) => x.id === sel); if (r) setD({ name: r.name, color: r.color, hoist: r.hoist, permissions: r.permissions }); }, [sel, server.roles]);
  const can = hasPerm(server.id, 'MANAGE_ROLES');
  const dirty = JSON.stringify(d) !== JSON.stringify({ name: role.name, color: role.color, hoist: role.hoist, permissions: role.permissions });
  const create = async () => { const r = await act(api.post(`/servers/${server.id}/roles`, { name: 'new role', color: '#8b5cf6' })); if (r) setSel(r.id); };
  const save = async () => { setBusy(true); await act(api.patch(`/servers/${server.id}/roles/${role.id}`, d), { success: 'Role saved' }); setBusy(false); };
  const toggle = (p) => setD((x) => ({ ...x, permissions: x.permissions.includes(p) ? x.permissions.filter((y) => y !== p) : [...x.permissions, p] }));
  const move = async (dir) => { const i = roles.findIndex((r) => r.id === role.id); const other = roles[i - dir]; if (!other || other.id === server.id) return; await act(Promise.all([api.patch(`/servers/${server.id}/roles/${role.id}`, { position: other.position }), api.patch(`/servers/${server.id}/roles/${other.id}`, { position: role.position })])); };
  const count = (rid) => rid === server.id ? server.members.length : server.members.filter((m) => m.roles.includes(rid)).length;
  return html`<div class="s-page roles-page">
    <div class="roles-list"><div class="rl-head"><b>${t('Roles')}</b>${can ? html`<${Btn} size="sm" variant="primary" icon="plus" onClick=${create}>${t('Create')}<//>` : null}</div>
      ${roles.map((r) => html`<button type="button" key=${r.id} class=${cx('role-item', sel === r.id && 'on')} onClick=${() => setSel(r.id)}><i style=${{ background: r.color || 'var(--text-3)' }}></i><span>${r.id === server.id ? '@everyone' : r.name}</span><small>${count(r.id)}</small></button>`)}</div>
    <div class="role-edit">
      <div class="re-head"><h3>${role.id === server.id ? t('Default permissions (@everyone)') : t('Edit role')}</h3>${role.id !== server.id && can ? html`<div class="btn-row"><${Btn} size="sm" icon="chevron-up" onClick=${() => move(1)} data-tip="Move up" /><${Btn} size="sm" icon="chevron-down" onClick=${() => move(-1)} data-tip="Move down" /><${Btn} size="sm" variant="danger" icon="trash" onClick=${async () => { if (await confirmDialog({ title: 'Delete role', body: `Delete “${role.name}”? Members lose its permissions.`, confirmLabel: 'Delete', danger: true })) { await act(api.del(`/servers/${server.id}/roles/${role.id}`)); setSel(server.id); } }} /></div>` : null}</div>
      ${role.id !== server.id ? html`<div class="two-col-set"><${Field} label=${t('Role name')}><${TextInput} value=${d.name} onInput=${(v) => setD({ ...d, name: v })} maxlength="100" disabled=${!can} /><//>
        <div><h5 class="s-label">${t('Color')}</h5><div class="color-row" style="margin:0"><${ColorSwatch} value=${d.color || '#8b5cf6'} onChange=${(c) => setD({ ...d, color: c })} label="Role color" size=${38} /><button type="button" class="link-btn" onClick=${() => setD({ ...d, color: null })}>${t('No color')}</button></div></div></div>
        <${SettingRow} title=${t('Show members separately')} desc=${t('Display role members in their own group in the member list.')}><${Toggle} checked=${d.hoist} onChange=${(v) => setD({ ...d, hoist: v })} disabled=${!can} /><//>` : null}
      <h4 class="s-sub">${t('Permissions')}</h4>
      <div class="perm-list">${PERM_ORDER.map((p) => html`<${SettingRow} key=${p} title=${PERM_INFO[p][0]} desc=${PERM_INFO[p][1]}><${Toggle} checked=${d.permissions.includes(p)} onChange=${() => toggle(p)} disabled=${!can} /><//>`)}</div>
    </div>
    ${dirty && can ? html`<div class="save-bar slide-up"><span><${Icon} name="alert-triangle" size=${18} /> ${t('Careful — you have unsaved changes!')}</span><${Btn} variant="ghost" onClick=${() => setD({ name: role.name, color: role.color, hoist: role.hoist, permissions: role.permissions })}>${t('Reset')}<//><${Btn} variant="primary" loading=${busy} onClick=${save}>${t('Save Changes')}<//></div>` : null}
  </div>`;
}

/* ------------------------------------------------------------------ channels */
function Channels({ server }) {
  const can = hasPerm(server.id, 'MANAGE_CHANNELS');
  const cats = server.channels.filter((c) => c.type === 'category').sort((a, b) => a.position - b.position);
  const groups = [{ cat: null, items: server.channels.filter((c) => c.type !== 'category' && !c.parentId).sort((a, b) => a.position - b.position) }, ...cats.map((c) => ({ cat: c, items: server.channels.filter((x) => x.parentId === c.id).sort((a, b) => a.position - b.position) }))];
  const swap = async (list, i, dir) => { const a = list[i]; const b = list[i + dir]; if (!b) return; await act(api.put(`/servers/${server.id}/channel-order`, { items: [{ id: a.id, position: b.position, parentId: a.parentId }, { id: b.id, position: a.position, parentId: b.parentId }] })); };
  return html`<div class="s-page">
    <${Section} title=${t('Channels')} desc=${t('Reorder with the arrows. Create categories to keep things tidy.')} action=${can ? html`<div class="btn-row"><${Btn} size="sm" icon="folder" onClick=${() => openModal('create-channel', { serverId: server.id, type: 'category' })}>${t('Category')}<//><${Btn} size="sm" variant="primary" icon="plus" onClick=${() => openModal('create-channel', { serverId: server.id })}>${t('Channel')}<//></div>` : null}>
      ${groups.map(({ cat, items }) => html`<div class="chs-group" key=${cat?.id || 'none'}>
        ${cat ? html`<div class="chs-cat"><${Icon} name="folder" size=${16} /><b>${cat.name}</b>${can ? html`<span class="chs-acts"><button type="button" onClick=${() => swap(cats, cats.indexOf(cat), -1)} aria-label="Up"><${Icon} name="chevron-up" size=${16} /></button><button type="button" onClick=${() => swap(cats, cats.indexOf(cat), 1)} aria-label="Down"><${Icon} name="chevron-down" size=${16} /></button><button type="button" onClick=${() => openModal('edit-channel', { channelId: cat.id })}><${Icon} name="settings" size=${16} /></button></span>` : null}</div>` : (items.length ? html`<div class="chs-cat"><b>${t('No category')}</b></div>` : null)}
        ${items.map((c, i) => html`<div class="chs-row" key=${c.id}><${Icon} name=${c.type === 'voice' ? 'volume' : c.private ? 'hash-lock' : 'hash'} size=${18} /><span>${c.name}</span>${c.topic ? html`<small>${c.topic}</small>` : null}
          ${can ? html`<span class="chs-acts"><button type="button" onClick=${() => swap(items, i, -1)} aria-label="Up" disabled=${i === 0}><${Icon} name="chevron-up" size=${16} /></button><button type="button" onClick=${() => swap(items, i, 1)} aria-label="Down" disabled=${i === items.length - 1}><${Icon} name="chevron-down" size=${16} /></button><button type="button" onClick=${() => openModal('edit-channel', { channelId: c.id })} aria-label="Edit"><${Icon} name="edit" size=${16} /></button><button type="button" class="danger" onClick=${() => deleteChannel(c)} aria-label="Delete"><${Icon} name="trash" size=${16} /></button></span>` : null}</div>`)}
      </div>`)}
    <//></div>`;
}

/* ------------------------------------------------------------------ members */
function Members({ server }) {
  const [q, setQ] = useState(''); const users = useSel((s) => s.users);
  const list = server.members.filter((m) => { const u = users[m.id]; return u && (!q || u.displayName.toLowerCase().includes(q.toLowerCase()) || u.username.includes(q.toLowerCase())); });
  const roles = server.roles.filter((r) => r.id !== server.id);
  const canRoles = hasPerm(server.id, 'MANAGE_ROLES');
  return html`<div class="s-page">
    <${Section} title=${`${t('Members')} — ${server.members.length}`}>
      <${TextInput} value=${q} onInput=${setQ} placeholder=${t('Search members')} icon="search" />
      <div class="mem-table">${list.map((m) => { const u = users[m.id]; const mine = server.roles.filter((r) => m.roles.includes(r.id)); return html`<div class="mem-row" key=${m.id}>
        <${Avatar} user=${u} size=${38} status=${u.status} /><div class="mem-name"><b>${m.nick || u.displayName}${m.id === server.ownerId ? html`<${Icon} name="crown" size=${14} class="crown" />` : null}</b><small>${u.username}</small></div>
        <div class="mem-roles">${mine.map((r) => html`<span class="role-chip" key=${r.id}><i style=${{ background: r.color || 'var(--text-3)' }}></i>${r.name}${canRoles ? html`<button type="button" onClick=${() => act(api.del(`/servers/${server.id}/members/${m.id}/roles/${r.id}`))} aria-label="Remove role"><${Icon} name="x" size=${11} sw=${3} /></button>` : null}</span>`)}
          ${canRoles && roles.length > mine.length ? html`<button type="button" class="role-add" onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); import('/js/store.js').then(({ openContext }) => openContext({ clientX: r.left, clientY: r.bottom + 4 }, roles.filter((x) => !m.roles.includes(x.id)).map((x) => ({ label: x.name, onClick: () => act(api.put(`/servers/${server.id}/members/${m.id}/roles/${x.id}`)) })))); }} data-tip="Add role"><${Icon} name="plus" size=${13} sw=${3} /></button>` : null}</div>
        <small class="mem-join">${formatMemberSince(m.joinedAt)}</small>
        <span class="chs-acts">${hasPerm(server.id, 'KICK_MEMBERS') && m.id !== server.ownerId && m.id !== state.me.id ? html`<button type="button" data-tip="Kick" onClick=${async () => { if (await confirmDialog({ title: `Kick ${u.displayName}`, body: 'They can rejoin with a new invite.', confirmLabel: 'Kick', danger: true })) act(api.del(`/servers/${server.id}/members/${m.id}`)); }}><${Icon} name="log-out" size=${16} /></button>` : null}
          ${hasPerm(server.id, 'BAN_MEMBERS') && m.id !== server.ownerId && m.id !== state.me.id ? html`<button type="button" class="danger" data-tip="Ban" onClick=${async () => { if (await confirmDialog({ title: `Ban ${u.displayName}`, body: 'They will be removed and cannot rejoin until unbanned.', confirmLabel: 'Ban', danger: true })) act(api.put(`/servers/${server.id}/bans/${m.id}`)); }}><${Icon} name="ban" size=${16} /></button>` : null}</span></div>`; })}</div>
    <//></div>`;
}

/* ------------------------------------------------------------------ invites + bans */
function Invites({ server }) {
  const [list, setList] = useState(null); const users = useSel((s) => s.users);
  const load = () => api.get(`/servers/${server.id}/invites`).then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, [server.id]);
  return html`<div class="s-page"><${Section} title=${t('Invites')} action=${html`<${Btn} size="sm" variant="primary" icon="plus" onClick=${() => openModal('invite', { serverId: server.id })}>${t('Create invite')}<//>`}>
    ${!list ? html`<div class="pk-center"><${Spinner} /></div>` : list.length ? html`<div class="mem-table">${list.map((i) => html`<div class="mem-row" key=${i.code}><span class="ss-ic"><${Icon} name="link" size=${20} /></span><div class="mem-name"><b class="mono">${i.code}</b><small>${users[i.inviterId]?.displayName || '—'}</small></div><small class="mem-roles">${i.uses}${i.maxUses ? ' / ' + i.maxUses : ''} ${t('uses')} · ${i.expiresAt ? t('expires') + ' ' + new Date(i.expiresAt).toLocaleString() : t('never expires')}</small>
      <span class="chs-acts"><button type="button" data-tip="Copy link" onClick=${async () => { await copyText(inviteUrl(i.code)); toast('Link copied', 'success', 1400); }}><${Icon} name="copy" size=${16} /></button><button type="button" class="danger" data-tip="Revoke" onClick=${async () => { await act(api.del(`/invites/${i.code}`)); load(); }}><${Icon} name="trash" size=${16} /></button></span></div>`)}</div>` : html`<${Empty} icon="link" title=${t('No active invites')}>${t('Create one to bring friends in.')}<//>`}
  <//></div>`;
}
function Bans({ server }) {
  const [list, setList] = useState(null);
  const load = () => api.get(`/servers/${server.id}/bans`).then((l) => { addUsers(l); setList(l); }).catch(() => setList([]));
  useEffect(() => { load(); }, [server.id]);
  return html`<div class="s-page"><${Section} title=${t('Bans')}>
    ${!list ? html`<div class="pk-center"><${Spinner} /></div>` : list.length ? html`<div class="mem-table">${list.map((u) => html`<div class="mem-row" key=${u.id}><${Avatar} user=${u} size=${36} /><div class="mem-name"><b>${u.displayName}</b><small>${u.username}</small></div><span class="chs-acts" style="opacity:1"><${Btn} size="sm" onClick=${async () => { await act(api.del(`/servers/${server.id}/bans/${u.id}`)); load(); }}>${t('Unban')}<//></span></div>`)}</div>` : html`<${Empty} icon="ban" title=${t('No bans')}>${t('Everyone here is behaving.')}<//>`}
  <//></div>`;
}

/* ------------------------------------------------------------------ shell */
const NAV = [['overview', 'server', 'Overview'], ['roles', 'tag', 'Roles'], ['channels', 'hash', 'Channels'], ['members', 'users', 'Members'], ['invites', 'link', 'Invites'], ['bans', 'ban', 'Bans']];
const PAGES = { overview: Overview, roles: Roles, channels: Channels, members: Members, invites: Invites, bans: Bans };
export function ServerSettingsHost() {
  const ss = useSel((s) => s.serverSettings); const server = useSel((s) => (s.serverSettings ? s.servers[s.serverSettings.id] : null));
  useEscape(() => { if (!state.modals.length && !state.popover && !state.ctx) close(); }, !!ss);
  if (!ss || !server) return null;
  const Page = PAGES[ss.page] || Overview; const label = NAV.find((n) => n[0] === ss.page)?.[2];
  return html`<div class="settings live" role="dialog" aria-label="Server settings">
    <nav class="settings-nav panel"><div class="sn-scroll"><div class="sn-group"><h5>${server.name}</h5>
      ${NAV.map(([k, ic, l]) => html`<button type="button" class=${cx('sn-item', ss.page === k && 'on')} onClick=${() => set({ serverSettings: { ...ss, page: k } })}><${Icon} name=${ic} size=${18} /><span>${t(l)}</span></button>`)}</div></div></nav>
    <section class="settings-body panel"><header class="sb-title"><h2 key=${ss.page}>${t(label)}</h2><button type="button" class="settings-close" onClick=${close} aria-label="Close"><span><${Icon} name="x" size=${20} /></span><small>ESC</small></button></header>
      <div class="settings-scroll"><div class="s-wrap" key=${ss.page + server.id}><${Page} server=${server} /></div></div></section></div>`;
}
void relTime; void go; void memberOf; void useRef;
