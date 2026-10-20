// Orate — create/join server, invites, channels, DMs.
import { html, useState, useEffect, useMemo, cx, copyText } from '/js/lib.js';
import { state, set, useSel, openModal, closeModal, go, goChannel, goDm, toast, getChannel, dmName, hasPerm, hasChannelPerm, addUsers } from '/js/store.js';
import { Icon, Logo } from '/js/icons.js';
import { Modal, Btn, Field, TextInput, Toggle, Segmented, Avatar, ServerIcon, Spinner, MODALS, SettingRow, confirmDialog, Dropdown } from '/js/ui.js';
import { api } from '/js/api.js';
import { act, errMsg, sendMessage, openDm } from '/js/actions.js';
import { chooseAndUploadImage } from '/js/imageutil.js';
import { ls, lsRemove } from '/js/lib.js';
import { deleteChannel } from '/js/sidebar.js';
import { t } from '/js/i18n.js';
import { PermissionsEditor, cloneOverwrites, overwritesEqual } from '/js/channel-perms.js';

const TEMPLATES = [
  { id: 'default', icon: '✨', name: 'Create My Own', sub: 'Start from scratch' },
  { id: 'gaming', icon: '🎮', name: 'Gaming', sub: 'LFG, clips and squads' },
  { id: 'friends', icon: '🫶', name: 'Friends', sub: 'Photos, plans and chill' },
  { id: 'study', icon: '📚', name: 'Study Group', sub: 'Resources and help' },
  { id: 'community', icon: '🌍', name: 'Community', sub: 'Welcome, news, showcase' },
];
export const inviteUrl = (code) => `${location.origin}/invite/${code}`;

/* ------------------------------------------------------------------ add / create / join */
MODALS['add-server'] = function AddServer({ id }) {
  const [step, setStep] = useState('choose'); const [dir, setDir] = useState(1);
  const [tpl, setTpl] = useState('default'); const [name, setName] = useState(`${state.me.displayName}'s server`); const [icon, setIcon] = useState(null);
  const [code, setCode] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [uploading, setUploading] = useState(false);
  const go2 = (s, d = 1) => { setDir(d); setStep(s); setErr(null); };
  const close = () => closeModal(id);
  const create = async () => {
    if (name.trim().length < 2) { setErr('Server name must be at least 2 characters'); return; }
    setBusy(true);
    try { const s = await api.post('/servers', { name: name.trim(), template: tpl, icon }); close(); goChannel(s.id, null); } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const join = async () => {
    const c = code.trim().split('/').pop(); if (!c) return; setBusy(true); setErr(null);
    try { const s = await api.post(`/invites/${c}/join`); close(); goChannel(s.id, null); toast(`Joined ${s.name}!`, 'success'); } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const pickIcon = async () => { setUploading(true); try { const u = await chooseAndUploadImage({ aspect: 1, out: 256, round: true, title: 'Server Icon', allowGif: true }); if (u) setIcon(u); } catch (e) { toast(errMsg(e), 'error'); } setUploading(false); };
  return html`<${Modal} title=${step === 'choose' ? t('Create a server') : step === 'template' ? t('Pick a template') : step === 'customize' ? t('Customize your server') : t('Join a server')}
    subtitle=${step === 'choose' ? t('Your server is where you and your friends hang out. Make yours and start talking.') : step === 'template' ? t('Choose a starting point. You can change everything later.') : step === 'customize' ? t('Give your new server a personality with a name and an icon.') : t('Enter an invite below to join an existing server.')} width=${480} onClose=${close}>
    <div class="step-wrap" key=${step} style=${{ '--d': dir }}>
    ${step === 'choose' ? html`<div class="choice-list">
      <button type="button" class="choice" onClick=${() => go2('template')}><span class="choice-ic">🛠️</span><span><b>${t('Create My Own')}</b><small>${t('Build a space for friends, a club or a community.')}</small></span><${Icon} name="chevron-right" size=${20} /></button>
      <button type="button" class="choice" onClick=${() => go2('join')}><span class="choice-ic">🔗</span><span><b>${t('Join a Server')}</b><small>${t('Got an invite link or code? Paste it in.')}</small></span><${Icon} name="chevron-right" size=${20} /></button></div>`
      : step === 'template' ? html`<div class="tpl-grid">${TEMPLATES.map((x) => html`<button type="button" class=${cx('tpl', tpl === x.id && 'sel')} onClick=${() => { setTpl(x.id); go2('customize'); }}><span class="tpl-ic">${x.icon}</span><b>${x.name}</b><small>${x.sub}</small></button>`)}</div><div class="step-foot"><${Btn} variant="ghost" onClick=${() => go2('choose', -1)}>${t('Back')}<//></div>`
        : step === 'customize' ? html`<div class="cs-icon-row"><button type="button" class="icon-drop" onClick=${pickIcon} aria-label="Upload icon">${icon ? html`<img src=${icon} alt="" />` : html`<span class="id-ring"><${Icon} name="camera" size=${26} /><small>${t('UPLOAD')}</small></span>`}${uploading ? html`<span class="id-busy"><${Spinner} size=${22} /></span>` : null}<span class="id-plus"><${Icon} name="plus" size=${14} sw=${3} /></span></button></div>
          <${Field} label=${t('Server name')} error=${err}><${TextInput} value=${name} onInput=${setName} maxlength="100" autofocus onKeyDown=${(e) => e.key === 'Enter' && create()} /><//>
          <div class="step-foot"><${Btn} variant="ghost" onClick=${() => go2('template', -1)}>${t('Back')}<//><${Btn} variant="primary" loading=${busy} onClick=${create}>${t('Create')}<//></div>`
          : html`<${Field} label=${t('Invite link or code')} error=${err}><${TextInput} value=${code} onInput=${setCode} placeholder=${`${location.origin}/invite/aBcD1234`} autofocus onKeyDown=${(e) => e.key === 'Enter' && join()} icon="link" /><//>
            <div class="step-foot"><${Btn} variant="ghost" onClick=${() => go2('choose', -1)}>${t('Back')}<//><${Btn} variant="primary" loading=${busy} disabled=${!code.trim()} onClick=${join}>${t('Join Server')}<//></div>`}
    </div>
  <//>`;
};

/* ------------------------------------------------------------------ invite */
const EXPIRES = [{ value: 1800, label: '30 minutes' }, { value: 3600, label: '1 hour' }, { value: 21600, label: '6 hours' }, { value: 43200, label: '12 hours' }, { value: 86400, label: '1 day' }, { value: 604800, label: '7 days' }, { value: 0, label: 'Never' }];
const USES = [{ value: 0, label: 'No limit' }, { value: 1, label: '1 use' }, { value: 5, label: '5 uses' }, { value: 10, label: '10 uses' }, { value: 25, label: '25 uses' }, { value: 100, label: '100 uses' }];
MODALS.invite = function InviteModal({ id, serverId }) {
  const server = state.servers[serverId]; const [inv, setInv] = useState(null); const [copied, setCopied] = useState(false); const [edit, setEdit] = useState(false);
  const [maxAge, setMaxAge] = useState(604800); const [maxUses, setMaxUses] = useState(0); const [busy, setBusy] = useState(false); const [q, setQ] = useState(''); const [sent, setSent] = useState({});
  const rel = useSel((s) => s.relationships); const users = useSel((s) => s.users);
  const gen = async (age = maxAge, uses = maxUses) => { setBusy(true); try { setInv(await api.post(`/servers/${serverId}/invites`, { maxAge: age, maxUses: uses })); setCopied(false); } catch (e) { toast(errMsg(e), 'error'); } setBusy(false); };
  useEffect(() => { gen(); }, []);
  if (!server) return null;
  const friends = Object.keys(rel).filter((i) => rel[i] === 'friend' && users[i] && !server.members.some((m) => m.id === i) && (!q || users[i].displayName.toLowerCase().includes(q.toLowerCase())));
  const copy = async () => { if (!inv) return; await copyText(inviteUrl(inv.code)); setCopied(true); setTimeout(() => setCopied(false), 2200); };
  const sendTo = async (uidd) => { const dm = Object.values(state.dms).find((c) => c.type === 'dm' && c.recipients.includes(uidd)) || await act(api.post('/dms', { recipientId: uidd })); if (!dm) return; if (!state.dms[dm.id]) set({ dms: { ...state.dms, [dm.id]: dm } }); await sendMessage(dm, { content: inviteUrl(inv.code) }); setSent((s) => ({ ...s, [uidd]: true })); };
  return html`<${Modal} title=${`${t('Invite friends to')} ${server.name}`} width=${460} onClose=${() => closeModal(id)}>
    <div class="invite-search"><${TextInput} value=${q} onInput=${setQ} placeholder=${t('Search for friends')} icon="search" /></div>
    <div class="invite-friends">${friends.length ? friends.map((f) => html`<div class="inv-row" key=${f}><${Avatar} user=${users[f]} size=${34} status=${users[f].status} /><b>${users[f].displayName}</b><${Btn} size="sm" variant=${sent[f] ? 'secondary' : 'primary'} disabled=${sent[f] || !inv} onClick=${() => sendTo(f)}>${sent[f] ? t('Sent') : t('Invite')}<//></div>`) : html`<div class="muted-note">${rel && Object.values(rel).includes('friend') ? t('No friends to invite right now.') : t('Add friends to invite them directly — or share the link below.')}</div>`}</div>
    <div class="invite-link"><div class="il-label">${t('Or send a server invite link to a friend')}</div>
      <div class=${cx('il-box', copied && 'copied')}><span class="il-url">${inv ? inviteUrl(inv.code) : '…'}</span><${Btn} variant=${copied ? 'success' : 'primary'} size="sm" disabled=${!inv} loading=${busy} onClick=${copy}>${copied ? t('Copied') : t('Copy')}<//></div>
      <div class="il-meta">${inv ? (inv.expiresAt ? `${t('Your invite link expires in')} ${Math.round((inv.expiresAt - Date.now()) / 3600000)}h.` : t('Your invite link never expires.')) : ''} <button type="button" class="link-btn" onClick=${() => setEdit(!edit)}>${t('Edit invite link')}</button></div>
      ${edit ? html`<div class="il-edit slide-down"><${Field} label=${t('Expire after')}><${Dropdown} value=${maxAge} options=${EXPIRES} onChange=${(v) => { setMaxAge(v); gen(v, maxUses); }} /><//><${Field} label=${t('Max number of uses')}><${Dropdown} value=${maxUses} options=${USES} onChange=${(v) => { setMaxUses(v); gen(maxAge, v); }} /><//></div>` : null}
    </div>
  <//>`;
};

MODALS['invite-accept'] = function InviteAccept({ id, code }) {
  const [info, setInfo] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/invites/${code}`).then(setInfo).catch((e) => setErr(errMsg(e))); }, [code]);
  const join = async () => { setBusy(true); try { const s = await api.post(`/invites/${code}/join`); closeModal(id); goChannel(s.id, null); } catch (e) { setErr(errMsg(e)); setBusy(false); } };
  return html`<${Modal} width=${420} hideClose onClose=${() => closeModal(id)}>
    ${err ? html`<div class="invite-card"><div class="ic-bad"><${Icon} name="alert-circle" size=${42} sw=${1.6} /></div><h2>${t('Invite Invalid')}</h2><p>${err}</p><${Btn} variant="primary" onClick=${() => closeModal(id)}>${t('Continue to Orate')}<//></div>`
      : !info ? html`<div class="pk-center" style="padding:40px"><${Spinner} /></div>`
        : html`<div class="invite-card">${info.inviter ? html`<div class="ic-from"><${Avatar} user=${info.inviter} size=${24} /> <b>${info.inviter.displayName}</b> ${t('invited you to join')}</div>` : null}
          <${ServerIcon} server=${info.server} size=${84} class="ic-icon" /><h2>${info.server.name}</h2>
          <div class="ic-stats"><span><i class="on"></i>${info.server.onlineCount} ${t('Online')}</span><span><i></i>${info.server.memberCount} ${t('Members')}</span></div>
          ${info.server.description ? html`<p>${info.server.description}</p>` : null}
          <${Btn} variant="primary" size="lg" class="btn-block" loading=${busy} onClick=${info.joined ? () => { closeModal(id); goChannel(info.server.id, null); } : join}>${info.joined ? t('Open Server') : t('Accept Invite')}<//></div>`}
  <//>`;
};

/* ------------------------------------------------------------------ channels */
MODALS['create-channel'] = function CreateChannel({ id, serverId, parentId, type: initial }) {
  const server = state.servers[serverId]; const [type, setType] = useState(initial || 'text'); const [name, setName] = useState(''); const [priv, setPriv] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const [roles, setRoles] = useState([]);
  const cats = server.channels.filter((c) => c.type === 'category'); const [parent, setParent] = useState(parentId || null);
  const create = async () => {
    if (!name.trim()) { setErr('Give it a name'); return; } setBusy(true);
    try { const c = await api.post(`/servers/${serverId}/channels`, { name: name.trim(), type, parentId: type === 'category' ? null : parent, private: priv, allowedRoles: roles }); closeModal(id); if (c.type !== 'category') setTimeout(() => goChannel(serverId, c.id), 80); } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const types = [['text', 'hash', t('Text'), t('Send messages, images, GIFs, emoji and more')], ['voice', 'volume', t('Voice'), t('Hang out together with voice, video and screen share')], ['stage', 'stage', t('Stage'), t('Host a talk — speakers on stage, everyone else listens and can raise a hand')], ['forum', 'forum', t('Forum'), t('Organized discussions — every topic gets its own post')], ['category', 'folder', t('Category'), t('Organize channels into groups')]];
  return html`<${Modal} title=${t('Create Channel')} subtitle=${parentId ? `${t('in')} ${server.channels.find((c) => c.id === parentId)?.name}` : null} width=${470} onClose=${() => closeModal(id)} footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Cancel')}<//><${Btn} variant="primary" loading=${busy} disabled=${!name.trim()} onClick=${create}>${t('Create Channel')}<//>`}>
    <div class="type-list">${types.map(([k, ic, l, d]) => html`<button type="button" class=${cx('type-opt', type === k && 'sel')} onClick=${() => setType(k)}><${Icon} name=${ic} size=${24} /><span><b>${l}</b><small>${d}</small></span><span class="radio"></span></button>`)}</div>
    <${Field} label=${type === 'category' ? t('Category name') : t('Channel name')} error=${err}><${TextInput} value=${name} onInput=${(v) => { setName(type === 'text' || type === 'forum' ? v.toLowerCase().replace(/\s+/g, '-') : v); setErr(null); }} icon=${type === 'voice' ? 'volume' : type === 'stage' ? 'stage' : type === 'category' ? 'folder' : type === 'forum' ? 'forum' : 'hash'} placeholder=${type === 'text' ? 'new-channel' : type === 'forum' ? 'new-forum' : type === 'voice' ? 'General' : type === 'stage' ? 'Town Hall' : 'New Category'} autofocus onKeyDown=${(e) => e.key === 'Enter' && create()} /><//>
    ${type !== 'category' && cats.length ? html`<${Field} label=${t('Category')}><${Dropdown} value=${parent} options=${[{ value: null, label: t('No category') }, ...cats.map((c) => ({ value: c.id, label: c.name }))]} onChange=${setParent} /><//>` : null}
    ${type !== 'category' ? html`<${SettingRow} title=${t('Private Channel')} desc=${t('Only selected roles and admins will be able to view this channel.')}><${Toggle} checked=${priv} onChange=${setPriv} /><//>` : null}
    ${priv && type !== 'category' ? html`<div class="role-pick slide-down">${server.roles.filter((r) => r.id !== server.id).map((r) => html`<label class="role-opt"><input type="checkbox" checked=${roles.includes(r.id)} onChange=${(e) => setRoles(e.target.checked ? [...roles, r.id] : roles.filter((x) => x !== r.id))} /><i style=${{ background: r.color || 'var(--text-3)' }}></i>${r.name}</label>`)}${server.roles.length <= 1 ? html`<div class="muted-note">${t('Create roles in Server Settings to grant access.')}</div>` : null}</div>` : null}
  <//>`;
};

MODALS['edit-channel'] = function EditChannel({ id, channelId, tab: startTab }) {
  const ch = getChannel(channelId); const server = state.servers[ch?.serverId];
  const canProps = !!ch && hasChannelPerm(ch, 'MANAGE_CHANNELS'); const canPerms = !!ch && Array.isArray(ch.overwrites);   // the server only sends overwrites to people who may change them
  const orig = { name: ch?.name || '', topic: ch?.topic || '', nsfw: !!ch?.nsfw, slowmode: ch?.slowmode || 0, ...(ch?.type === 'forum' ? { tags: ch.tags || [], requireTag: !!ch.requireTag } : {}) };
  const [f, setF] = useState(orig); const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(startTab === 'permissions' && canPerms ? 'permissions' : canProps ? 'overview' : 'permissions');
  const [ows, setOws] = useState(() => cloneOverwrites(ch?.overwrites)); const [synced, setSynced] = useState(!!ch?.synced);
  if (!ch || !server) return null;
  const isCat = ch.type === 'category'; const parent = !isCat && ch.parentId ? server.channels.find((c) => c.id === ch.parentId) : null;
  const kids = isCat ? server.channels.filter((c) => c.parentId === ch.id && c.synced).length : 0;
  const permsDirty = canPerms && (synced !== !!ch.synced || !overwritesEqual(ows, ch.overwrites));
  const propsDirty = canProps && JSON.stringify(f) !== JSON.stringify(orig);
  const editOws = (next) => { setOws(next); if (synced) setSynced(false); };   // changing a synced channel's permissions detaches it from its category
  const sync = (on) => { if (on) { setOws(cloneOverwrites(parent?.overwrites ?? ows)); setSynced(true); } else setSynced(false); };
  const everyone = ows.find((o) => o.type === 'role' && o.id === server.id);
  const isPrivate = !!everyone?.deny.includes('VIEW_CHANNEL');
  const setPrivate = (on) => {
    const next = cloneOverwrites(ows); let o = next.find((x) => x.type === 'role' && x.id === server.id);
    if (!o) { o = { type: 'role', id: server.id, allow: [], deny: [] }; next.push(o); }
    o.deny = o.deny.filter((p) => p !== 'VIEW_CHANNEL'); o.allow = o.allow.filter((p) => p !== 'VIEW_CHANNEL'); if (on) o.deny.push('VIEW_CHANNEL');
    editOws(next);
  };
  const save = async () => {
    const body = {};
    if (propsDirty) for (const k of Object.keys(orig)) if (f[k] !== orig[k]) body[k] = f[k];
    if (permsDirty) { if (synced) body.synced = true; else { body.overwrites = ows.filter((o) => o.allow.length || o.deny.length); if (parent) body.synced = false; } }
    if (!Object.keys(body).length) { closeModal(id); return; }
    setBusy(true); const r = await act(api.patch(`/channels/${ch.id}`, body)); setBusy(false); if (r) closeModal(id);
  };
  const SLOW = [{ value: 0, label: 'Off' }, { value: 5, label: '5s' }, { value: 10, label: '10s' }, { value: 30, label: '30s' }, { value: 60, label: '1m' }, { value: 300, label: '5m' }, { value: 3600, label: '1h' }];
  const tabBtn = (k, label) => html`<button type="button" class=${cx('chan-tab', tab === k && 'on')} onClick=${() => setTab(k)}>${label}</button>`;
  return html`<${Modal} title=${isCat ? t('Edit Category') : t('Edit Channel')} subtitle=${isCat ? ch.name : (ch.type === 'voice' || ch.type === 'stage' ? '' : '#') + ch.name} width=${tab === 'permissions' ? 720 : 480} onClose=${() => closeModal(id)}
    footer=${html`${canProps ? html`<${Btn} variant="danger" class="mr-auto" icon="trash" onClick=${async () => { closeModal(id); await deleteChannel(ch); }}>${t('Delete')}<//>` : null}<${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Cancel')}<//><${Btn} variant="primary" loading=${busy} disabled=${!propsDirty && !permsDirty} onClick=${save}>${t('Save Changes')}<//>`}>
    ${canProps && canPerms ? html`<div class="chan-tabs">${tabBtn('overview', t('Overview'))}${tabBtn('permissions', t('Permissions'))}</div>` : null}
    ${tab === 'permissions' && canPerms ? html`<${PermissionsEditor} ch=${ch} server=${server} ows=${ows} onChange=${editOws} synced=${synced} onSync=${sync} parent=${parent} kids=${kids} />` : html`<div>
      <${Field} label=${isCat ? t('Category name') : t('Channel name')}><${TextInput} value=${f.name} onInput=${(v) => setF({ ...f, name: ch.type === 'text' || ch.type === 'forum' ? v.toLowerCase().replace(/\s+/g, '-') : v })} maxlength="100" disabled=${!canProps} /><//>
      ${ch.type === 'forum' ? html`<${Field} label=${t('Guidelines')}><textarea class="textarea" value=${f.topic} maxlength="1024" onInput=${(e) => setF({ ...f, topic: e.target.value })} placeholder=${t('Tell people what belongs here before they post.')}></textarea><//>
        <${Field} label=${`${t('Tags')} (${f.tags.length}/20)`}><div class="tag-edit">${f.tags.map((tg, i) => html`<div class="tag-row" key=${tg.id}><input class="input tg-emoji" value=${tg.emoji || ''} maxlength="4" placeholder="🙂" aria-label=${t('Emoji')} onInput=${(e) => setF({ ...f, tags: f.tags.map((x, j) => (j === i ? { ...x, emoji: e.target.value } : x)) })} /><input class="input" value=${tg.name} maxlength="20" placeholder=${t('Tag name')} onInput=${(e) => setF({ ...f, tags: f.tags.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /><button type="button" class="icon-btn" aria-label=${t('Remove')} onClick=${() => setF({ ...f, tags: f.tags.filter((_, j) => j !== i) })}><${Icon} name="x" size=${16} /></button></div>`)}
          <${Btn} size="sm" icon="plus" disabled=${f.tags.length >= 20} onClick=${() => setF({ ...f, tags: [...f.tags, { id: 't' + Math.random().toString(36).slice(2, 9), name: '', emoji: '' }] })}>${t('Add tag')}<//></div><//>
        <${SettingRow} title=${t('Require a tag')} desc=${t('People must pick at least one tag when they start a post.')}><${Toggle} checked=${f.requireTag} onChange=${(v) => setF({ ...f, requireTag: v })} /><//>` : null}
      ${ch.type === 'stage' ? html`<${Field} label=${t('Stage topic')}><textarea class="textarea" value=${f.topic} maxlength="1024" onInput=${(e) => setF({ ...f, topic: e.target.value })} placeholder=${t('What is this stage about?')}></textarea><//>` : null}
      ${ch.type === 'text' ? html`<${Field} label=${t('Channel topic')}><textarea class="textarea" value=${f.topic} maxlength="1024" onInput=${(e) => setF({ ...f, topic: e.target.value })} placeholder=${t('Let everyone know how to use this channel!')}></textarea><//>
        <${SettingRow} title=${t('Slowmode')} desc=${t('Members must wait between messages unless they can manage messages.')}><${Dropdown} width=${110} value=${f.slowmode} options=${SLOW} onChange=${(v) => setF({ ...f, slowmode: v })} /><//>` : null}
      ${canPerms ? html`<${SettingRow} title=${isCat ? t('Private Category') : t('Private Channel')} desc=${t('Only the roles and members you allow in Permissions can view it. Admins always can.')}><${Toggle} checked=${isPrivate} onChange=${setPrivate} /><//>
        <button type="button" class="link-btn" onClick=${() => setTab('permissions')}>${t('Fine-tune who can do what in Permissions →')}</button>` : null}
    </div>`}
  <//>`;
};

/* ------------------------------------------------------------------ ban */
MODALS.ban = function BanModal({ id, serverId, userId }) {
  const u = state.users[userId]; const server = state.servers[serverId];
  const [reason, setReason] = useState(''); const [del, setDel] = useState(0); const [busy, setBusy] = useState(false); const [alts, setAlts] = useState(true);
  if (!u || !server) return null;
  const DEL = [{ value: 0, label: t('Don’t delete any') }, { value: 1, label: t('Previous hour') }, { value: 24, label: t('Previous 24 hours') }, { value: 168, label: t('Previous 7 days') }];
  const go2 = async () => {
    setBusy(true); const r = await act(api.put(`/servers/${serverId}/bans/${userId}`, { reason: reason.trim(), deleteHours: del, alts }));
    setBusy(false);
    if (r) { toast(r.alts?.length ? `${u.displayName} and ${r.alts.length} other account${r.alts.length === 1 ? '' : 's'} (${r.alts.map((a) => a.displayName).join(', ')}) were banned` : `${u.displayName} was banned`, 'success', 4500); closeModal(id); }
  };
  return html`<${Modal} title=${`${t('Ban')} ${u.displayName}`} subtitle=${t('They are removed from the server and can’t rejoin — with this account or any other from the same browser — until you unban them.')} width=${460} onClose=${() => closeModal(id)}
    footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Cancel')}<//><${Btn} variant="danger" icon="ban" loading=${busy} onClick=${go2}>${t('Ban')}<//>`}>
    <${Field} label=${t('Reason (only moderators see it)')}><${TextInput} value=${reason} onInput=${setReason} maxlength="200" placeholder=${t('Optional')} autofocus onKeyDown=${(e) => e.key === 'Enter' && go2()} /><//>
    <${Field} label=${t('Delete their recent messages')}><${Dropdown} value=${del} options=${DEL} onChange=${setDel} /><//>
    <${SettingRow} title=${t('Also ban their other accounts')} desc=${t('Accounts that share their browser (their alts) are banned too. Turn this off to ban just this one.')}><${Toggle} checked=${alts} onChange=${setAlts} /><//>
  <//>`;
};

/* ------------------------------------------------------------------ DMs */
MODALS['create-dm'] = function CreateDm({ id, fromChannel }) {
  const rel = useSel((s) => s.relationships); const users = useSel((s) => s.users);
  const base = fromChannel ? state.dms[fromChannel] : null;
  const [sel, setSel] = useState([]); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false); const [name, setName] = useState('');
  const max = base ? 10 - base.recipients.length : 9;
  const list = Object.keys(rel).filter((i) => rel[i] === 'friend' && users[i] && !(base?.recipients.includes(i)) && (!q || users[i].displayName.toLowerCase().includes(q.toLowerCase()) || users[i].username.includes(q.toLowerCase())));
  const toggle = (i) => setSel((s) => (s.includes(i) ? s.filter((x) => x !== i) : s.length < max ? [...s, i] : s));
  const go3 = async () => {
    setBusy(true);
    try {
      if (base?.type === 'group') { for (const i of sel) await api.put(`/channels/${base.id}/recipients/${i}`); closeModal(id); }
      else if (base?.type === 'dm') { const o = base.recipients.find((x) => x !== state.me.id); let g; for (const i of sel) g = await api.put(`/channels/${base.id}/recipients/${i}`); closeModal(id); void o; if (g) setTimeout(() => goDm(g.id), 100); }
      else if (sel.length === 1) { closeModal(id); openDm(sel[0]); }
      else { const ch = await api.post('/dms', { recipientIds: sel, name: name.trim() || undefined }); closeModal(id); setTimeout(() => goDm(ch.id), 100); }
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false); }
  };
  return html`<${Modal} title=${base ? t('Add friends to this DM') : t('Select Friends')} subtitle=${`${t('You can add')} ${max - sel.length} ${t('more friends.')}`} width=${440} onClose=${() => closeModal(id)} footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Cancel')}<//><${Btn} variant="primary" loading=${busy} disabled=${!sel.length} onClick=${go3}>${base ? t('Add') : sel.length > 1 ? t('Create Group DM') : t('Create DM')}<//>`}>
    <${TextInput} value=${q} onInput=${setQ} placeholder=${t('Type the username of a friend')} icon="search" autofocus />
    ${sel.length > 1 && !base ? html`<${Field} label=${t('Group name (optional)')}><${TextInput} value=${name} onInput=${setName} maxlength="100" placeholder=${sel.map((i) => users[i].displayName).join(', ')} /><//>` : null}
    <div class="pick-list">${list.length ? list.map((i) => html`<label class=${cx('pick-row', sel.includes(i) && 'sel')} key=${i}><${Avatar} user=${users[i]} size=${34} status=${users[i].status} /><span class="pick-name">${users[i].displayName}</span><input type="checkbox" checked=${sel.includes(i)} onChange=${() => toggle(i)} /><span class="box"><${Icon} name="check" size=${13} sw=${3.5} /></span></label>`) : html`<div class="muted-note">${t('No friends found. Add friends from the Friends page.')}</div>`}</div>
  <//>`;
};
void set; void go; void lsRemove; void ls; void hasPerm; void addUsers; void dmName; void Logo; void Segmented; void useMemo;
