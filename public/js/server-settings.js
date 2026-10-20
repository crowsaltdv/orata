// Orate — server settings overlay (overview, roles, channels, members, invites, bans).
import { html, useState, useEffect, useRef, cx, formatMemberSince, relTime, copyText } from '/js/lib.js';
import { state, set, useSel, openModal, closeModal, closePopover, toast, hasPerm, go, memberOf, addUsers } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Btn, Field, TextInput, Toggle, SettingRow, Section, Segmented, Modal, MODALS, Avatar, ServerIcon, ColorSwatch, Dropdown, Empty, confirmDialog, useEscape, Spinner, useSaveBar } from '/js/ui.js';
import { api, upload } from '/js/api.js';
import { act, errMsg } from '/js/actions.js';
import { chooseAndUploadImage, uploadGifFrom, pickFile, cropImage } from '/js/imageutil.js';
import { openPicker } from '/js/pickers.js';
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
  // a GIF from KLIPY becomes the icon / banner: fetched through the image proxy and stored on this server like any upload
  const gifPick = (key, anchor) => openPicker(anchor, {
    onGif: async (item) => {
      closePopover(); setUp(key);
      try { const u = await uploadGifFrom(key === 'banner' ? (item.full?.gif || item.preview?.gif || item.preview?.url) : (item.preview?.gif || item.full?.gif || item.preview?.url), `${key}.gif`); setD((p) => ({ ...p, [key]: u })); } catch (e) { toast(errMsg(e), 'error'); }
      setUp(null);
    },
  }, { gifOnly: true, tab: 'gif', placement: 'bottom-start' });
  const save = async () => { setBusy(true); await act(api.patch(`/servers/${server.id}`, d), { success: 'Server updated' }); setBusy(false); };
  const texts = server.channels.filter((c) => c.type === 'text');
  useSaveBar(dirty && can, { save, reset: () => setD(orig), busy });
  return html`<div class="s-page">
    <${Section} title=${t('Server overview')}>
      <div class="so-top"><div class="so-icon"><${ServerIcon} server=${{ ...server, ...d }} size=${96} class="so-ic" />
        ${can ? html`<div class="pe-btns"><${Btn} icon="upload" size="sm" variant="primary" loading=${up === 'icon'} onClick=${() => img('icon', { aspect: 1, out: 256, round: true, title: 'Server Icon', allowGif: true })}>${t('Upload icon')}<//>${state.gifOk !== false ? html`<${Btn} icon="sticker" size="sm" disabled=${!!up} onClick=${(e) => gifPick('icon', e.currentTarget)}>${t('Choose a GIF')}<//>` : null}${d.icon ? html`<${Btn} size="sm" variant="ghost" onClick=${() => setD({ ...d, icon: null })}>${t('Remove')}<//>` : null}</div>` : null}</div>
        <div class="so-fields"><${Field} label=${t('Server name')}><${TextInput} value=${d.name} onInput=${(v) => setD({ ...d, name: v })} maxlength="100" disabled=${!can} /><//>
          <${Field} label=${t('Description')}><textarea class="textarea" rows="3" maxlength="300" value=${d.description} onInput=${(e) => setD({ ...d, description: e.target.value })} disabled=${!can}></textarea><//></div></div>
    <//>
    <${Section} title=${t('Banner')} desc=${t('Shown big at the top of the channel list. Upload a picture or a GIF, or pick one from KLIPY — animated banners and icons play everywhere.')}>
      <div class="so-banner" style=${d.banner ? { backgroundImage: `url("${d.banner}")` } : null}>${!d.banner ? html`<span>${t('No banner')}</span>` : null}</div>
      ${can ? html`<div class="pe-btns"><${Btn} icon="image" size="sm" variant="primary" loading=${up === 'banner'} onClick=${() => img('banner', { aspect: 16 / 9, out: 1280, title: 'Server Banner', allowGif: true })}>${t('Upload banner')}<//>${state.gifOk !== false ? html`<${Btn} icon="sticker" size="sm" disabled=${!!up} onClick=${(e) => gifPick('banner', e.currentTarget)}>${t('Choose a GIF')}<//>` : null}${d.banner ? html`<${Btn} size="sm" variant="ghost" onClick=${() => setD({ ...d, banner: null })}>${t('Remove')}<//>` : null}</div>` : null}
    <//>
    <${Section} title=${t('System messages')}>
      <${SettingRow} title=${t('Join messages channel')} desc=${t('Where “member joined” notices appear.')}><${Dropdown} width=${200} value=${d.systemChannelId} options=${texts.map((c) => ({ value: c.id, label: '# ' + c.name }))} onChange=${(v) => setD({ ...d, systemChannelId: v })} /><//>
    <//>
    ${server.ownerId === state.me.id ? html`<${Section} title=${t('Danger zone')}>
      <div class="danger-zone"><div class="btn-row"><${Btn} icon="crown" onClick=${() => openModal('transfer', { serverId: server.id })}>${t('Transfer ownership')}<//><${Btn} variant="danger" icon="trash" onClick=${() => deleteServer(server)}>${t('Delete server')}<//></div></div><//>` : null}
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
  useSaveBar(dirty && can, { save, reset: () => setD({ name: role.name, color: role.color, hoist: role.hoist, permissions: role.permissions }), busy });
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
        ${items.map((c, i) => html`<div class="chs-row" key=${c.id}><${Icon} name=${c.type === 'voice' ? 'volume' : c.type === 'stage' ? 'stage' : c.private ? 'hash-lock' : 'hash'} size=${18} /><span>${c.name}</span>${c.topic ? html`<small>${c.topic}</small>` : null}
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
          ${hasPerm(server.id, 'BAN_MEMBERS') && m.id !== server.ownerId && m.id !== state.me.id ? html`<button type="button" class="danger" data-tip="Ban" onClick=${() => openModal('ban', { serverId: server.id, userId: m.id })}><${Icon} name="ban" size=${16} /></button>` : null}</span></div>`; })}</div>
    <//></div>`;
}

/* ------------------------------------------------------------------ custom emoji + stickers */
const EXPR = { emojis: { max: 50, title: 'Emoji', one: 'emoji', size: 128, desc: 'Custom emoji anyone in the server can use in messages and reactions — type :name: or pick them from the emoji picker. PNG, JPEG, GIF or WebP under 512 KB.' },
  stickers: { max: 30, title: 'Stickers', one: 'sticker', size: 320, desc: 'Stickers anyone in the server can send from the sticker picker. PNG, JPEG, GIF or WebP under 512 KB.' } };
/** Picks a picture, squares it up (GIFs stay as they are so they keep moving) and uploads it. Resolves { url, name } or null. */
async function pickExpressionImage(kind) {
  const file = await pickFile('image/png,image/jpeg,image/webp,image/gif'); if (!file) return null;
  const base = file.name.replace(/\.[^.]+$/, '');
  let up;
  if (file.type === 'image/gif') { if (file.size > 512 * 1024) throw new Error('Animated pictures must be under 512 KB'); up = await upload(file); }
  else { const blob = await cropImage(file, { aspect: 1, out: EXPR[kind].size, title: kind === 'emojis' ? 'Custom Emoji' : 'Sticker' }); if (!blob) return null; if (blob.size > 512 * 1024) throw new Error('That picture is too big even after resizing'); up = await upload(new File([blob], 'image.webp', { type: 'image/webp' })); }
  return { url: up.url, name: base };
}
const uniqueName = (base, list, kind) => {
  let n = kind === 'emojis' ? base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) : base.replace(/[_-]+/g, ' ').trim().slice(0, 26);
  if (n.length < 2) n = kind === 'emojis' ? 'emoji' : 'sticker';
  let out = n; let i = 2; while (list.some((x) => x.name.toLowerCase() === out.toLowerCase())) out = n + (kind === 'emojis' ? '_' : ' ') + i++;
  return out;
};
function ExprRow({ server, kind, item, can }) {
  const [name, setName] = useState(item.name); const users = useSel((s) => s.users);
  useEffect(() => setName(item.name), [item.name]);
  const commit = async () => { const v = name.trim(); if (v === item.name) return; const r = await act(api.patch(`/servers/${server.id}/${kind}/${item.id}`, { name: v })); if (!r) setName(item.name); };
  return html`<div class=${cx('expr-item', kind)}><div class="expr-img"><img src=${item.url} alt=${item.name} draggable=${false} /></div>
    <div class="expr-meta">${can ? html`<input class="input expr-name" value=${name} maxlength="32" onInput=${(e) => setName(e.target.value)} onBlur=${commit} onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()} aria-label=${t('Name')} />` : html`<b>${kind === 'emojis' ? ':' + item.name + ':' : item.name}</b>`}
      <small>${item.animated ? `${t('Animated')} · ` : ''}${users[item.by]?.displayName || ''}</small></div>
    ${can ? html`<button type="button" class="expr-del danger" data-tip=${t('Delete')} aria-label=${t('Delete')} onClick=${async () => { if (await confirmDialog({ title: `${t('Delete')} ${item.name}?`, body: t('Messages that already used it keep showing it.'), confirmLabel: t('Delete'), danger: true })) act(api.del(`/servers/${server.id}/${kind}/${item.id}`)); }}><${Icon} name="trash" size=${16} /></button>` : null}</div>`;
}
function Expressions({ server, kind }) {
  const cfg = EXPR[kind]; const list = server[kind] || []; const can = hasPerm(server.id, 'MANAGE_EXPRESSIONS'); const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try { const f = await pickExpressionImage(kind); if (f) { await api.post(`/servers/${server.id}/${kind}`, { name: uniqueName(f.name, list, kind), url: f.url }); toast(`${t('Added')} ${cfg.one}`, 'success', 1800); } } catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };
  return html`<div class="s-page"><${Section} title=${`${t(cfg.title)} — ${list.length} / ${cfg.max}`} desc=${t(cfg.desc)} action=${can ? html`<${Btn} size="sm" variant="primary" icon="upload" loading=${busy} disabled=${list.length >= cfg.max} onClick=${add}>${t('Upload')} ${t(cfg.one)}<//>` : null}>
    ${list.length ? html`<div class=${cx('expr-grid', kind)}>${list.map((it) => html`<${ExprRow} key=${it.id} server=${server} kind=${kind} item=${it} can=${can} />`)}</div>` : html`<${Empty} icon=${kind === 'emojis' ? 'smile' : 'sticker'} title=${`${t('No')} ${t(cfg.title).toLowerCase()} ${t('yet')}`}>${can ? t('Upload one to get started.') : t('Ask someone with Manage Expressions to add some.')}<//>`}
  <//></div>`;
}
const EmojiPage = ({ server }) => html`<${Expressions} server=${server} kind="emojis" />`;
const StickerPage = ({ server }) => html`<${Expressions} server=${server} kind="stickers" />`;

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
  return html`<div class="s-page"><${Section} title=${t('Bans')} desc=${t('Banning also blocks the person’s device and network and bans their other accounts (alts), so they can’t simply make a new account and rejoin. Unbanning frees them again.')}>
    ${!list ? html`<div class="pk-center"><${Spinner} /></div>` : list.length ? html`<div class="mem-table">${list.map((u) => html`<div class="mem-row" key=${u.id}><${Avatar} user=${u} size=${36} /><div class="mem-name"><b>${u.displayName}</b><small>${u.username}${u.ban?.reason ? ` · ${u.ban.reason}` : ''}</small></div>
      <small class="mem-join">${u.ban?.by ? `${t('by')} ${u.ban.by}` : ''}${u.ban?.at ? ` · ${formatMemberSince(u.ban.at)}` : ''}</small>
      ${u.ban?.altOf ? html`<span class="role-chip" data-tip=${t('Banned along with this person because they share a device or network')}><i style=${{ background: '#f59e0b' }}></i>${t('Alt of')} ${u.ban.altOf}</span>` : u.ban?.ipBanned ? html`<span class="role-chip" data-tip=${t('Their device and network are blocked too')}><i style=${{ background: '#e5314f' }}></i>${t('IP ban')}</span>` : null}
      <span class="chs-acts" style="opacity:1"><${Btn} size="sm" onClick=${async () => { await act(api.del(`/servers/${server.id}/bans/${u.id}`)); load(); }}>${t('Unban')}<//></span></div>`)}</div>` : html`<${Empty} icon="ban" title=${t('No bans')}>${t('Everyone here is behaving.')}<//>`}
  <//></div>`;
}

/* ------------------------------------------------------------------ safety */
function Safety({ server }) {
  const can = hasPerm(server.id, 'MANAGE_SERVER');
  const orig = { profanity: server.safety?.profanity || 'off', blockedWords: (server.safety?.words || []).join(', ') };
  const [d, setD] = useState(orig); const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(d) !== JSON.stringify(orig);
  const save = async () => { setBusy(true); await act(api.patch(`/servers/${server.id}`, d), { success: 'Safety settings saved' }); setBusy(false); };
  useSaveBar(dirty && can, { save, reset: () => setD(orig), busy });
  const MODES = [{ value: 'off', label: t('Off') }, { value: 'censor', label: t('Hide the words') }, { value: 'block', label: t('Block the message') }];
  const desc = { off: t('Nothing is filtered.'), censor: t('Swear words are replaced with symbols (f∗∗∗) and the message is sent.'), block: t('A message with a swear word is not sent; the person is told why.') }[d.profanity];
  return html`<div class="s-page">
    <${Section} title=${t('Swearing protection')} desc=${t('Keeps the language in this server clean. It catches the usual tricks (extra letters, symbols between letters, look-alike characters) but never ordinary words. Off by default.')}>
      <${SettingRow} title=${t('What happens to a swear word')} desc=${desc}><${Segmented} options=${MODES} value=${d.profanity} onChange=${(v) => setD({ ...d, profanity: v })} /><//>
      <${Field} label=${t('Blocked words')} hint=${t('Your own words, separated by commas or new lines. They are treated like the built-in ones.')}><textarea class="textarea" rows="4" maxlength="1500" value=${d.blockedWords} disabled=${!can} onInput=${(e) => setD({ ...d, blockedWords: e.target.value })} placeholder=${t('pineapple pizza, heck …')}></textarea><//>
      <p class="text-muted" style="font-size:13px;margin:6px 0 0">${t('Applies to messages, edits, polls and forum posts in this server — not to DMs. The owner and administrators are never filtered.')}</p>
    <//>
  </div>`;
}

/* ------------------------------------------------------------------ shell */
const NAV = [['overview', 'server', 'Overview'], ['roles', 'tag', 'Roles'], ['channels', 'hash', 'Channels'], ['emoji', 'smile', 'Emoji'], ['stickers', 'sticker', 'Stickers'], ['members', 'users', 'Members'], ['invites', 'link', 'Invites'], ['bans', 'ban', 'Bans'], ['safety', 'shield', 'Safety']];
const PAGES = { overview: Overview, roles: Roles, channels: Channels, emoji: EmojiPage, stickers: StickerPage, members: Members, invites: Invites, bans: Bans, safety: Safety };
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
