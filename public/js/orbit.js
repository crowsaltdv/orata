// Orata — Orbit in a server, on the browser side: who may use a command (mirrors server/orbit.js), replies only you can see, and the /settings dialog.
import { html, useState, cx } from '/js/lib.js';
import { state, useSel, closeModal, closePopover, toast } from '/js/store.js';
import { Modal, Btn, Field, TextInput, Avatar, Dropdown, MODALS } from '/js/ui.js';
import { Icon } from '/js/icons.js';
import { api } from '/js/api.js';
import { act, patchEntry } from '/js/actions.js';
import { chooseAndUploadImage } from '/js/imageutil.js';
import { ORBIT_COMMANDS } from '/js/orbit-commands.js';
import { PERM_INFO } from '/js/perms.js';
import { t } from '/js/i18n.js';

/** May I use `cmd` in `server`? Owners and admins always; otherwise the command's permission, then the roles picked in /settings. */
export function mayUseOrbit(server, cmd) {
  const me = state.me?.id; if (!server?.orbitId || !me || !cmd) return false;
  if (server.ownerId === me || server.coOwners?.includes(me) || server.perms.includes('ADMINISTRATOR')) return true;
  if (cmd.perm && !server.perms.includes(cmd.perm)) return false;
  const roles = server.orbitRoles?.[cmd.name]; const mine = server.members.find((m) => m.id === me)?.roles || [];
  return !roles?.length || roles.some((r) => mine.includes(r));
}

/** A reply from Orbit that only I see: it lives in this browser's copy of the channel until it is dismissed or the page reloads. */
let seq = 0;
export function orbitSays(chId, server, content) {
  const msg = { id: String(Date.now() * 1000 + (seq++ % 1000)), channelId: chId, authorId: server.orbitId, content, createdAt: Date.now(), editedAt: null, attachments: [], reactions: {}, mentions: [], mentionRoles: [], type: 'default', ephemeral: true };
  patchEntry(chId, (cur) => ({ ...cur, list: [...cur.list, msg] }));
}
export const dismissEphemeral = (chId, id) => patchEntry(chId, (cur) => ({ ...cur, list: cur.list.filter((m) => m.id !== id) }));

MODALS['orbit-settings'] = function OrbitSettings({ id, serverId }) {
  const server = useSel((s) => s.servers[serverId]); const bot = useSel((s) => s.users[s.servers[serverId]?.orbitId]);
  const [name, setName] = useState(bot?.displayName || 'Orbit'); const [bio, setBio] = useState(bot?.bio || ''); const [avatar, setAvatar] = useState(bot?.avatar || null);
  const [roles, setRoles] = useState(() => ({ ...(server?.orbitRoles || {}) })); const [busy, setBusy] = useState(false); const [up, setUp] = useState(false);
  const close = () => closeModal(id);
  if (!server || !bot) return null;
  const list = server.roles.filter((r) => r.id !== server.id).sort((a, b) => b.position - a.position);
  const flip = (cmd, rid) => setRoles((p) => { const cur = p[cmd] || []; return { ...p, [cmd]: cur.includes(rid) ? cur.filter((x) => x !== rid) : [...cur, rid] }; });
  const pick = async () => { setUp(true); try { const u = await chooseAndUploadImage({ aspect: 1, out: 256, round: true, title: t('Orbit’s picture'), allowGif: true }); if (u) setAvatar(u); } catch (e) { toast(e.message, 'error'); } setUp(false); };
  const save = async () => { setBusy(true); const r = await act(api.patch(`/servers/${serverId}/orbit`, { displayName: name, bio, avatar, roles }), { success: t('Orbit updated') }); setBusy(false); if (r) close(); };
  return html`<${Modal} title=${t('Orbit settings')} subtitle=${t('How Orbit looks in this server, and who can use each command.')} width=${580} onClose=${close}
    footer=${html`<${Btn} variant="ghost" onClick=${close}>${t('Cancel')}<//><${Btn} variant="primary" loading=${busy} disabled=${!name.trim()} onClick=${save}>${t('Save')}<//>`}>
    <div class="orbit-top"><${Avatar} user=${{ ...bot, avatar }} size=${72} />
      <div class="pe-btns"><${Btn} size="sm" variant="primary" icon="upload" loading=${up} onClick=${pick}>${t('Change picture')}<//>${avatar ? html`<${Btn} size="sm" variant="ghost" onClick=${() => setAvatar(null)}>${t('Remove')}<//>` : null}</div></div>
    <${Field} label=${t('Name')}><${TextInput} value=${name} onInput=${setName} maxlength="32" placeholder="Orbit" /><//>
    <${Field} label=${t('About')}><textarea class="textarea" rows="2" maxlength="190" value=${bio} onInput=${(e) => setBio(e.target.value)}></textarea><//>
    <div class="orbit-cmds"><h5>${t('Who can use each command')}</h5>
      <p class="field-hint">${t('With no role picked, anyone who has the permission shown can use it. Pick roles to narrow it to them. Owners and admins can always use every command.')}</p>
      ${ORBIT_COMMANDS.map((c) => html`<div class="oc-row" key=${c.name}><div class="oc-name"><b>/${c.name}</b><small>${c.perm ? PERM_INFO[c.perm]?.[0] || c.perm : t('Everyone')}</small></div>
        <div class="oc-roles">${list.length ? list.map((r) => html`<button type="button" key=${r.id} class=${cx('oc-role', (roles[c.name] || []).includes(r.id) && 'on')} style=${{ '--rc': r.color || 'var(--text-3)' }} onClick=${() => flip(c.name, r.id)}><i></i>${r.name}</button>`) : html`<small class="text-muted">${t('Make roles in Server Settings to narrow commands.')}</small>`}</div></div>`)}
    </div>
  <//>`;
};

/** /reactionroles: a message from Orbit with one reaction per role; anyone who reacts gets that role (server/orbit.js). */
MODALS['reaction-roles'] = function ReactionRoles({ id, channelId }) {
  const ch = state.channelIndex[channelId]; const server = useSel((s) => s.servers[ch?.serverId]);
  const [text, setText] = useState(t('Pick your roles! React below to get one, take your reaction back to drop it.'));
  const [rows, setRows] = useState([{ emoji: '', roleId: '' }]); const [busy, setBusy] = useState(false);
  const close = () => closeModal(id);
  if (!server) return null;
  const me = state.me.id; const boss = server.ownerId === me || server.coOwners?.includes(me);
  const myTop = Math.max(0, ...(server.members.find((m) => m.id === me)?.roles || []).map((rid) => server.roles.find((r) => r.id === rid)?.position || 0));
  const roles = server.roles.filter((r) => r.id !== server.id && !r.permissions.includes('ADMINISTRATOR') && (boss || r.position < myTop)).sort((a, b) => b.position - a.position);
  const put = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const pickEmoji = (i, anchor) => import('/js/pickers.js').then((p) => p.openPicker(anchor, (c) => { put(i, { emoji: c }); closePopover(); }, { emojiOnly: true }));
  const ready = rows.filter((r) => r.emoji && r.roleId);
  const post = async () => { setBusy(true); const r = await act(api.post(`/channels/${channelId}/reaction-roles`, { content: text, pairs: ready }), { success: t('Reaction roles posted') }); setBusy(false); if (r) close(); };
  return html`<${Modal} title=${t('Reaction roles')} subtitle=${`${t('Orbit posts this in')} #${ch.name}. ${t('Anyone who reacts gets the role.')}`} width=${520} onClose=${close}
    footer=${html`<${Btn} variant="ghost" onClick=${close}>${t('Cancel')}<//><${Btn} variant="primary" loading=${busy} disabled=${!ready.length} onClick=${post}>${t('Post')}<//>`}>
    <${Field} label=${t('Message')}><textarea class="textarea" rows="3" maxlength="1500" value=${text} onInput=${(e) => setText(e.target.value)}></textarea><//>
    <div class="rr-rows">${rows.map((r, i) => html`<div class="rr-row" key=${i}>
      <button type="button" class="rr-emoji" aria-label=${t('Pick an emoji')} onClick=${(e) => pickEmoji(i, e.currentTarget)}>${r.emoji ? (r.emoji.startsWith('<') ? `:${r.emoji.split(':')[1]}:` : r.emoji) : html`<${Icon} name="smile-plus" size=${20} />`}</button>
      <${Dropdown} value=${r.roleId} options=${roles.map((x) => ({ value: x.id, label: x.name }))} onChange=${(v) => put(i, { roleId: v })} placeholder=${t('Pick a role')} />
      ${rows.length > 1 ? html`<button type="button" class="icon-btn" aria-label=${t('Remove')} onClick=${() => setRows((rs) => rs.filter((_, j) => j !== i))}><${Icon} name="x" size=${16} /></button>` : null}</div>`)}</div>
    ${rows.length < 10 ? html`<${Btn} size="sm" icon="plus" onClick=${() => setRows((rs) => [...rs, { emoji: '', roleId: '' }])}>${t('Add a role')}<//>` : null}
    ${!roles.length ? html`<p class="field-hint">${t('No roles you can hand out yet. Make some under Server Settings → Roles. Roles above yours, or that make someone an administrator, can’t be given with a reaction.')}</p>` : null}
  <//>`;
};
