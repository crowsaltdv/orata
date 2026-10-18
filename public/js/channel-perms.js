// Orate — the channel / category permission editor (Discord-style: pick a role or member, then Allow / Inherit / Deny each permission).
// Channels inside a category can be "synced" with it: they then simply use the category's permissions.
import { html, useState, cx } from '/js/lib.js';
import { state, useSel } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, Btn, TextInput } from '/js/ui.js';
import { t } from '/js/i18n.js';
import { CHANNEL_PERM_INFO, CHANNEL_PERM_GROUPS } from '/js/perms.js';

export const cloneOverwrites = (list) => (list || []).map((o) => ({ type: o.type, id: o.id, allow: [...o.allow], deny: [...o.deny] }));
export const overwritesEqual = (a, b) => {
  const norm = (l) => JSON.stringify((l || []).filter((o) => o.allow.length || o.deny.length).map((o) => ({ type: o.type, id: o.id, allow: [...o.allow].sort(), deny: [...o.deny].sort() })).sort((x, y) => ((x.type + x.id) < (y.type + y.id) ? -1 : 1)));
  return norm(a) === norm(b);
};
const stateOf = (o, p) => (o?.allow.includes(p) ? 'allow' : o?.deny.includes(p) ? 'deny' : 'inherit');

/**
 * ch: the channel being edited · ows: working copy of its overwrites · onChange(nextOws) · synced / onSync(bool) only for channels in a category ·
 * parent: that category · kids: how many channels follow a category.
 */
export function PermissionsEditor({ ch, server, ows, onChange, synced, onSync, parent, kids }) {
  const users = useSel((s) => s.users);
  const [sel, setSel] = useState({ type: 'role', id: server.id });
  const [adding, setAdding] = useState(false); const [q, setQ] = useState('');
  const mine = ch.cperms || server.perms; const admin = server.ownerId === state.me.id || mine.includes('ADMINISTRATOR');
  const isEveryone = (o) => o.type === 'role' && o.id === server.id;
  const rows = [ows.find(isEveryone) || { type: 'role', id: server.id, allow: [], deny: [] }, ...ows.filter((o) => !isEveryone(o))];
  const current = rows.find((o) => o.type === sel.type && o.id === sel.id) || rows[0];
  const label = (o) => (o.type === 'role' ? server.roles.find((r) => r.id === o.id)?.name || t('Deleted role') : state.servers[server.id].members.find((m) => m.id === o.id)?.nick || users[o.id]?.displayName || t('Unknown member'));

  const setPerm = (p, v) => {
    const next = cloneOverwrites(ows); let o = next.find((x) => x.type === current.type && x.id === current.id);
    if (!o) { o = { type: current.type, id: current.id, allow: [], deny: [] }; next.push(o); }
    o.allow = o.allow.filter((x) => x !== p); o.deny = o.deny.filter((x) => x !== p);
    if (v === 'allow') o.allow.push(p); else if (v === 'deny') o.deny.push(p);
    onChange(next);
  };
  const clearTarget = () => onChange(cloneOverwrites(ows).map((o) => (o.type === current.type && o.id === current.id ? { ...o, allow: [], deny: [] } : o)));
  const removeTarget = (o) => { onChange(cloneOverwrites(ows).filter((x) => !(x.type === o.type && x.id === o.id))); if (sel.type === o.type && sel.id === o.id) setSel({ type: 'role', id: server.id }); };
  const add = (type, id) => { if (!ows.some((o) => o.type === type && o.id === id)) onChange([...cloneOverwrites(ows), { type, id, allow: [], deny: [] }]); setSel({ type, id }); setAdding(false); setQ(''); };

  const term = q.trim().toLowerCase();
  const roleHits = server.roles.filter((r) => r.id !== server.id && !ows.some((o) => o.type === 'role' && o.id === r.id) && (!term || r.name.toLowerCase().includes(term)));
  const memberHits = term ? server.members.filter((m) => !ows.some((o) => o.type === 'member' && o.id === m.id) && !users[m.id]?.bot && ((m.nick || users[m.id]?.displayName || '').toLowerCase().includes(term) || (users[m.id]?.username || '').includes(term))).slice(0, 8) : [];
  const groups = CHANNEL_PERM_GROUPS[ch.type] || CHANNEL_PERM_GROUPS.text;

  return html`<div class="perm-editor">
    ${ch.type !== 'category' && ch.parentId && parent
      ? html`<div class=${cx('sync-banner', synced ? 'on' : 'off')}><span class="sb-ic"><${Icon} name=${synced ? 'link' : 'lock'} size=${18} /></span>
          <div><b>${synced ? t('Synced with category') : t('Not synced with category')}: <em>${parent.name}</em></b><small>${synced ? t('This channel uses the category’s permissions. Changing anything here unsyncs it.') : t('This channel has its own permissions, which no longer follow the category.')}</small></div>
          ${synced ? html`<${Btn} size="sm" onClick=${() => onSync(false)}>${t('Unsync')}<//>` : html`<${Btn} size="sm" variant="primary" onClick=${() => onSync(true)}>${t('Sync Now')}<//>`}</div>`
      : ch.type === 'category'
        ? html`<div class="sync-banner info"><span class="sb-ic"><${Icon} name="layers" size=${18} /></span><div><b>${kids ? t('Channels in this category follow these permissions') : t('Permissions for this category')}</b><small>${kids ? `${kids} ${kids === 1 ? t('channel is') : t('channels are')} ${t('synced with it. Unsynced channels keep their own settings.')}` : t('Channels you add here start out synced with it.')}</small></div></div>`
        : null}
    <div class="pe-grid">
      <div class="pe-targets">
        <div class="pe-th"><span>${t('Roles / Members')}</span><button type="button" class="icon-btn sm" data-tip=${t('Add roles or members')} aria-label=${t('Add roles or members')} onClick=${() => setAdding(!adding)}><${Icon} name=${adding ? 'x' : 'plus'} size=${16} sw=${2.6} /></button></div>
        ${adding ? html`<div class="pe-add slide-down"><${TextInput} value=${q} onInput=${setQ} placeholder=${t('Search roles or members')} icon="search" autofocus />
          <div class="pe-add-list">${roleHits.map((r) => html`<button type="button" key=${r.id} onClick=${() => add('role', r.id)}><i style=${{ background: r.color || 'var(--text-3)' }}></i>${r.name}</button>`)}
            ${memberHits.map((m) => html`<button type="button" key=${m.id} onClick=${() => add('member', m.id)}><${Avatar} user=${users[m.id]} size=${20} />${m.nick || users[m.id]?.displayName}</button>`)}
            ${!roleHits.length && !memberHits.length ? html`<div class="muted-note">${term ? t('Nothing found') : t('Type a name to find members')}</div>` : null}</div></div>` : null}
        <div class="pe-list">${rows.map((o) => {
          const role = o.type === 'role' ? server.roles.find((r) => r.id === o.id) : null;
          return html`<div key=${o.type + o.id} role="button" tabindex="0" class=${cx('pe-target', current.type === o.type && current.id === o.id && 'sel')} onClick=${() => setSel({ type: o.type, id: o.id })}>
            ${o.type === 'member' ? html`<${Avatar} user=${users[o.id]} size=${22} />` : html`<i class="pe-dot" style=${{ background: role?.color || 'var(--text-3)' }}></i>`}
            <span>${isEveryone(o) ? '@everyone' : label(o)}</span>
            ${!isEveryone(o) ? html`<button type="button" class="pe-x" aria-label=${t('Remove')} data-tip=${t('Remove')} onClick=${(e) => { e.stopPropagation(); removeTarget(o); }}><${Icon} name="x" size=${13} sw=${2.6} /></button>` : null}</div>`;
        })}</div>
      </div>
      <div class="pe-perms">
        <div class="pe-ph"><b>${isEveryone(current) ? '@everyone' : label(current)}</b>${current.allow.length || current.deny.length ? html`<button type="button" class="link-btn" onClick=${clearTarget}>${t('Clear permissions')}</button>` : null}</div>
        ${groups.map(([title, list]) => html`<div class="pe-group" key=${title}><h5>${t(title)} ${t('permissions')}</h5>
          ${list.map((p) => {
            const [name, desc] = CHANNEL_PERM_INFO[p] || [p, '']; const v = stateOf(current, p); const blocked = !admin && !mine.includes(p);
            return html`<div class=${cx('perm-row', v)} key=${p}><div class="pr-text"><b>${t(name)}</b><small>${t(desc)}</small></div>
              <div class="tri" role="group" aria-label=${name}>
                <button type="button" class=${cx('deny', v === 'deny' && 'on')} aria-pressed=${v === 'deny'} data-tip=${t('Deny')} onClick=${() => setPerm(p, v === 'deny' ? 'inherit' : 'deny')}><${Icon} name="x" size=${15} sw=${3} /></button>
                <button type="button" class=${cx('inherit', v === 'inherit' && 'on')} aria-pressed=${v === 'inherit'} data-tip=${t('Inherit from role')} onClick=${() => setPerm(p, 'inherit')}><span>/</span></button>
                <button type="button" class=${cx('allow', v === 'allow' && 'on')} aria-pressed=${v === 'allow'} disabled=${blocked} data-tip=${blocked ? t('You can only allow permissions you have') : t('Allow')} onClick=${() => setPerm(p, v === 'allow' ? 'inherit' : 'allow')}><${Icon} name="check" size=${15} sw=${3} /></button>
              </div></div>`;
          })}</div>`)}
      </div>
    </div>
  </div>`;
}
