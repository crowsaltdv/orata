// Orata — profile badges: the row on a profile card, and the editor developers (people with the "dev" badge) use to give badges and make new ones.
// A user's `badges` arrive whole from the server ({ id, name, icon | emoji, color }); the catalog is only fetched by the editor. See server/badges.js.
import { html, useState, useEffect, cx } from '/js/lib.js';
import { useSel, closeModal, addUsers, notify } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Modal, Btn, Field, TextInput, Dropdown, Segmented, ColorSwatch, Spinner, confirmDialog, MODALS } from '/js/ui.js';
import { api } from '/js/api.js';
import { act } from '/js/actions.js';
import { t } from '/js/i18n.js';

export const isDev = (u) => !!u?.badges?.some((b) => b.id === 'dev');
const ICON_CHOICES = ['star', 'heart', 'award', 'bolt', 'sparkles', 'shield', 'code', 'crown', 'flag', 'music', 'palette', 'target', 'check-circle', 'smile', 'globe', 'moon', 'sun', 'camera', 'gift', 'bookmark'];

function BadgeIcon({ b, size = 16 }) {
  return b.emoji ? html`<span class="bdg-emoji" style=${{ fontSize: size + 'px' }}>${b.emoji}</span>` : html`<${Icon} name=${b.icon} size=${size} sw=${2.2} />`;
}
/** The badges next to a name on a profile card; the name of each shows on hover. */
export function Badges({ user }) {
  if (!user?.badges?.length) return null;
  return html`<span class="pc-badges">${user.badges.map((b) => html`<span class="pc-badge" key=${b.id} role="img" aria-label=${b.name} data-tip=${b.name} style=${{ color: b.color }}><${BadgeIcon} b=${b} /></span>`)}</span>`;
}

MODALS.badges = function BadgesModal({ id, userId }) {
  const user = useSel((s) => s.users[userId]);
  const [all, setAll] = useState(null); const [mine, setMine] = useState(() => (user?.badges || []).map((b) => b.id)); const [busy, setBusy] = useState(false);
  const [name, setName] = useState(''); const [kind, setKind] = useState('icon'); const [icon, setIcon] = useState('star'); const [emoji, setEmoji] = useState(''); const [color, setColor] = useState('#8b5cf6');
  useEffect(() => { api.get('/badges').then(setAll).catch(() => setAll([])); }, []);
  const close = () => closeModal(id);
  const toggle = (bid) => setMine((m) => (m.includes(bid) ? m.filter((x) => x !== bid) : [...m, bid]));
  const save = async () => { setBusy(true); const r = await act(api.put(`/users/${userId}/badges`, { badges: mine }), { success: t('Badges saved') }); setBusy(false); if (r) { addUsers([r]); notify(); close(); } };
  const create = async () => {
    const b = await act(api.post('/badges', { name, color, ...(kind === 'emoji' ? { emoji } : { icon }) }));
    if (b) { setAll((a) => [...(a || []), b]); setMine((m) => [...m, b.id]); setName(''); setEmoji(''); }
  };
  const remove = async (b) => {
    if (!(await confirmDialog({ title: `${t('Delete badge')} “${b.name}”?`, body: t('It is taken away from everyone who has it.'), confirmLabel: t('Delete'), danger: true }))) return;
    if (await act(api.del(`/badges/${b.id}`))) { setAll((a) => a.filter((x) => x.id !== b.id)); setMine((m) => m.filter((x) => x !== b.id)); }
  };
  const iconOpt = (o) => html`<span class="bdg-opt"><${Icon} name=${o.value} size=${16} />${o.label}</span>`;
  return html`<${Modal} title=${t('Edit Badges')} subtitle=${user ? `@${user.username}` : null} width=${480} onClose=${close} footer=${html`<${Btn} variant="ghost" onClick=${close}>${t('Cancel')}<//><${Btn} variant="primary" loading=${busy} disabled=${!all} onClick=${save}>${t('Save')}<//>`}>
    ${!all ? html`<div class="pk-center"><${Spinner} /></div>` : html`<div class="pick-list">${all.map((b) => html`<label class=${cx('pick-row', mine.includes(b.id) && 'sel')} key=${b.id}>
      <i class="bdg-big" style=${{ color: b.color }}><${BadgeIcon} b=${b} size=${20} /></i><span><b>${b.name}</b><small>${b.builtin ? t('Built-in') : t('Custom')}</small></span>
      ${b.builtin ? null : html`<button type="button" class="bdg-del" data-tip=${t('Delete badge')} aria-label=${t('Delete badge')} onClick=${(e) => { e.preventDefault(); remove(b); }}><${Icon} name="trash" size=${15} /></button>`}
      <input type="checkbox" checked=${mine.includes(b.id)} onChange=${() => toggle(b.id)} /><span class="box"><${Icon} name="check" size=${14} sw=${3} /></span></label>`)}</div>`}
    <div class="bdg-new">
      <h5>${t('Create a badge')}</h5>
      <${Field} label=${t('Name')}><${TextInput} value=${name} onInput=${setName} maxlength="32" placeholder=${t('Badge name')} /><//>
      <div class="bdg-row"><${Segmented} size="sm" options=${[{ value: 'icon', label: t('Icon') }, { value: 'emoji', label: t('Emoji') }]} value=${kind} onChange=${setKind} />
        ${kind === 'icon' ? html`<${Dropdown} value=${icon} options=${ICON_CHOICES.map((v) => ({ value: v, label: v }))} onChange=${setIcon} renderOption=${iconOpt} />` : html`<${TextInput} value=${emoji} onInput=${setEmoji} maxlength="16" placeholder="🌸" />`}
        <${ColorSwatch} value=${color} onChange=${setColor} label=${t('Badge color')} size=${34} />
        <i class="bdg-big" style=${{ color }}><${BadgeIcon} b=${kind === 'emoji' ? { emoji: emoji || '🌸' } : { icon }} size=${20} /></i></div>
      <${Btn} icon="plus" disabled=${!name.trim() || (kind === 'emoji' && !emoji.trim())} onClick=${create}>${t('Create badge')}<//>
    </div>
  <//>`;
};
