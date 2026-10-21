// Orata — Server Settings → Audit Log: who did what in the server (moderators' actions, settings changes and AutoMod blocks), newest first.
import { html, useState, useEffect, relTime, formatFull } from '/js/lib.js';
import { state, addUsers } from '/js/store.js';
import { Btn, Dropdown, Spinner, Empty } from '/js/ui.js';
import { Icon } from '/js/icons.js';
import { api } from '/js/api.js';
import { errMsg } from '/js/actions.js';
import { formatDuration } from '/js/orbit-commands.js';
import { t } from '/js/i18n.js';

const KINDS = [['', 'Everything'], ['member_', 'Members'], ['role_', 'Roles'], ['channel_', 'Channels'], ['message_', 'Messages'], ['automod', 'AutoMod'], ['server_,invite_,vanity_,tag_,orbit_,reaction_,discord_', 'Server & Orbit']];
const ICON = { member_kick: 'log-out', member_ban: 'ban', member_unban: 'user-check', member_timeout: 'clock', member_timeout_remove: 'clock', member_role_add: 'tag', member_role_remove: 'tag', member_nick: 'edit',
  role_create: 'tag', role_update: 'tag', role_delete: 'tag', channel_create: 'hash', channel_update: 'hash', channel_delete: 'hash', server_update: 'settings', server_transfer: 'crown',
  invite_create: 'link', invite_delete: 'link', vanity_update: 'link', tag_update: 'tag', discord_link: 'link', discord_unlink: 'link', message_delete: 'trash', message_bulk_delete: 'trash', message_pin: 'pin', message_unpin: 'pin', automod_block: 'shield', orbit_add: 'sparkles', orbit_remove: 'sparkles', orbit_update: 'sparkles', reaction_roles_create: 'smile' };
const FIELD = { name: 'name', description: 'description', icon: 'icon', banner: 'banner', accent: 'color', systemChannelId: 'join messages channel', profanity: 'swearing protection', blockedWords: 'blocked words', automod: 'AutoMod', onboarding: 'onboarding', topic: 'topic', slowmode: 'slowmode', nsfw: 'age limit', parentId: 'category', overwrites: 'permissions', synced: 'permissions', tags: 'tags', requireTag: 'tags', color: 'color', hoist: 'shown separately', position: 'order', permissions: 'permissions', displayName: 'name', bio: 'about', avatar: 'picture', roles: 'command roles' };
const fields = (list) => (list?.length ? ` (${[...new Set(list.map((f) => FIELD[f] || f))].join(', ')})` : '');
const BAD = new Set(['member_kick', 'member_ban', 'member_timeout', 'role_delete', 'channel_delete', 'message_delete', 'message_bulk_delete', 'automod_block', 'invite_delete', 'orbit_remove']);

/** What happened, as a sentence after the actor's name. */
function said(e, who) {
  const d = e.details || {}; const T = who(e.target); const ch = (n) => html`<b>#${n || '?'}</b>`;
  switch (e.action) {
    case 'member_kick': return html`kicked ${T}`;
    case 'member_ban': return html`banned ${T}${d.alts ? ` (and ${d.alts} other account${d.alts === 1 ? '' : 's'} of theirs)` : ''}`;
    case 'member_unban': return html`unbanned ${T}`;
    case 'member_timeout': return html`timed out ${T} for ${formatDuration((d.minutes || 0) * 60_000)}`;
    case 'member_timeout_remove': return html`removed the timeout of ${T}`;
    case 'member_role_add': return html`gave ${T} the role <b>${d.role}</b>`;
    case 'member_role_remove': return html`took the role <b>${d.role}</b> from ${T}`;
    case 'member_nick': return d.nick ? html`changed ${T}’s nickname to <b>${d.nick}</b>` : html`cleared ${T}’s nickname`;
    case 'role_create': return html`created the role <b>${d.name}</b>`;
    case 'role_update': return html`changed the role <b>${d.name}</b>${fields(d.fields)}`;
    case 'role_delete': return html`deleted the role <b>${d.name}</b>`;
    case 'channel_create': return html`created ${ch(d.name)}`;
    case 'channel_update': return html`changed ${ch(d.name)}${fields(d.fields)}`;
    case 'channel_delete': return html`deleted ${ch(d.name)}`;
    case 'server_update': return html`changed the server settings${fields(d.fields)}`;
    case 'server_transfer': return html`made ${T} the owner of the server`;
    case 'invite_create': return html`created the invite <b>${d.code}</b>`;
    case 'invite_delete': return html`deleted the invite <b>${d.code}</b>`;
    case 'tag_update': return d.old ? html`changed the server tag from <b>${d.old}</b> to <b>${d.text}</b>` : html`set the server tag to <b>${d.text}</b>`;
    case 'discord_link': return html`linked ${ch(d.channel)} with <b>#${d.discordChannel}</b>${d.guild ? ` (${d.guild})` : ''} on Discord`;
    case 'discord_unlink': return html`unlinked ${ch(d.channel)} from Discord${d.why ? ` (${d.why})` : ''}`;
    case 'vanity_update': return d.old ? html`changed the custom invite link from <b>${d.old}</b> to <b>${d.code}</b>` : html`set the custom invite link to <b>${d.code}</b>`;
    case 'message_delete': return html`deleted a message by ${T} in ${ch(d.channel)}`;
    case 'message_bulk_delete': return html`deleted ${d.count} messages in ${ch(d.channel)}`;
    case 'message_pin': return html`pinned a message by ${T} in ${ch(d.channel)}`;
    case 'message_unpin': return html`unpinned a message by ${T} in ${ch(d.channel)}`;
    case 'automod_block': return html`blocked a message by ${T} in ${ch(d.channel)} (${d.rule})`;
    case 'orbit_add': return html`added Orbit to the server`;
    case 'orbit_remove': return html`removed Orbit from the server`;
    case 'orbit_update': return html`changed Orbit’s settings${fields(d.fields)}`;
    case 'reaction_roles_create': return html`posted reaction roles (${d.count}) in ${ch(d.channel)}`;
    default: return html`did ${e.action}`;
  }
}

export function AuditLog({ server }) {
  const [kind, setKind] = useState(''); const [rows, setRows] = useState(null); const [more, setMore] = useState(false); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const load = async (before) => {
    setBusy(true);
    try {
      const r = await api.get(`/servers/${server.id}/audit-log?action=${encodeURIComponent(kind)}${before ? `&before=${before}` : ''}`);
      addUsers(r.users); setRows((cur) => (before ? [...(cur || []), ...r.entries] : r.entries)); setMore(r.hasMore); setErr(null);
    } catch (e) { setErr(errMsg(e)); setRows([]); }
    setBusy(false);
  };
  useEffect(() => { setRows(null); load(); }, [kind, server.id]);
  const who = (id) => html`<b>${id ? (state.users[id]?.displayName || t('someone')) : t('someone')}</b>`;
  return html`<div class="s-page">
    <div class="al-top"><p class="text-muted">${t('Who kicked, banned, timed out, changed roles, channels or settings — and every message AutoMod blocked. The last 500 actions are kept.')}</p>
      <${Dropdown} width=${190} value=${kind} options=${KINDS.map(([value, label]) => ({ value, label: t(label) }))} onChange=${setKind} /></div>
    ${err ? html`<p class="text-danger">${err}</p>` : null}
    ${!rows ? html`<div class="pk-center"><${Spinner} /></div>` : !rows.length && !err ? html`<${Empty} icon="list" title=${t('Nothing here yet')}>${t('Moderator actions and AutoMod blocks will show up here.')}<//>`
      : html`<div class="al-list">${rows.map((e) => html`<div class="al-row" key=${e.id}>
        <span class=${`al-ic ${BAD.has(e.action) ? 'bad' : ''}`}><${Icon} name=${ICON[e.action] || 'info'} size=${16} /></span>
        <div class="al-text"><div>${e.actorId ? who(e.actorId) : e.details?.discordUser ? html`<b>${e.details.discordUser}</b> (Discord)` : html`<b>${e.action.startsWith('discord_') ? 'Orbit' : 'AutoMod'}</b>`} ${said(e, who)}</div>
          ${e.reason ? html`<small>${t('Reason')}: ${e.reason}</small>` : null}${e.details?.excerpt ? html`<small class="al-ex">“${e.details.excerpt}”</small>` : null}</div>
        <time title=${formatFull(e.at)}>${relTime(e.at)}</time></div>`)}</div>`}
    ${more ? html`<${Btn} size="sm" loading=${busy} onClick=${() => load(rows[rows.length - 1]?.id)}>${t('Show older')}<//>` : null}
  </div>`;
}
