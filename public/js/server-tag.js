// Orate — server tags: a server's short tag (1–5 letters or numbers) with an icon and a color, which members can wear next to their name.
// Admins set it in Server Settings → Overview (once a week); people pick the one they wear in User Settings → Profile or from the server menu.
import { html, useState, cx } from '/js/lib.js';
import { state } from '/js/store.js';
import { Btn, TextInput, ColorSwatch, Section } from '/js/ui.js';
import { Icon } from '/js/icons.js';
import { api } from '/js/api.js';
import { act } from '/js/actions.js';
import { formatDuration } from '/js/orbit-commands.js';
import { t } from '/js/i18n.js';

export const TAG_ICONS = ['star', 'heart', 'bolt', 'crown', 'sparkles', 'shield', 'flag', 'music', 'moon', 'sun', 'globe', 'target', 'award', 'gift', 'code', 'smile', 'camera', 'palette'];
const WEEK = 7 * 86400_000;

/** A tag pill: the icon in the tag's color, then its text. Hovering names the server it belongs to. */
export function ServerTag({ tag }) {
  if (!tag?.text) return null;
  return html`<span class="srv-tag" style=${{ '--tc': tag.color }} data-tip=${tag.server || null}><${Icon} name=${tag.icon} size=${11} sw=${2.8} />${tag.text}</span>`;
}

/** Server Settings → Overview: the server's tag. Admins edit it (once a week); everyone else just sees it. */
export function ServerTagSection({ server }) {
  const me = state.me.id; const admin = server.ownerId === me || server.coOwners?.includes(me) || server.perms.includes('ADMINISTRATOR');
  const cur = server.tag; const [d, setD] = useState({ text: cur?.text || '', icon: cur?.icon || 'star', color: cur?.color || '#8b5cf6' }); const [busy, setBusy] = useState(false);
  const left = cur ? cur.changedAt + WEEK - Date.now() : 0; const locked = left > 0;
  if (!admin && !cur) return null;
  const same = !!cur && d.text === cur.text && d.icon === cur.icon && d.color === cur.color;
  const save = async () => { setBusy(true); await act(api.put(`/servers/${server.id}/tag`, d), { success: t('Server tag saved') }); setBusy(false); };
  return html`<${Section} title=${t('Server tag')} desc=${t('Up to 5 letters or numbers with an icon. Members can wear it next to their name everywhere. Only admins can change it, once a week.')}>
    <div class="stag-edit"><span class="stag-preview"><${ServerTag} tag=${{ ...d, server: server.name }} /></span>
      ${admin ? html`<${TextInput} class="stag-text" value=${d.text} maxlength="5" placeholder="ORATE" disabled=${locked} aria-label=${t('Tag')} onInput=${(v, e) => { const text = v.replace(/[^A-Za-z0-9]/g, '').slice(0, 5); e.target.value = text; setD({ ...d, text }); }} />
        <${ColorSwatch} value=${d.color} onChange=${(c) => { if (!locked) setD({ ...d, color: c }); }} label=${t('Tag color')} size=${34} />
        <${Btn} variant="primary" loading=${busy} disabled=${!d.text || same || locked} onClick=${save}>${cur ? t('Change') : t('Save')}<//>` : null}</div>
    ${admin ? html`<div class="stag-icons">${TAG_ICONS.map((ic) => html`<button type="button" key=${ic} class=${cx('stag-ic', d.icon === ic && 'on')} style=${{ '--tc': d.color }} disabled=${locked} aria-label=${ic} aria-pressed=${d.icon === ic} onClick=${() => setD({ ...d, icon: ic })}><${Icon} name=${ic} size=${18} /></button>`)}</div>
      <p class="field-hint">${locked ? `${t('You can change it again in')} ${formatDuration(left)}.` : t('Once you save it, the tag can’t be changed for a week.')}</p>` : null}
  <//>`;
}
