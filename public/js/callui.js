// Orate — incoming call overlay.
import { html } from '/js/lib.js';
import { state, useSel, goDm, getChannel, dmName } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar } from '/js/ui.js';
import { voice } from '/js/voice.js';
import { dismissCall } from '/js/events.js';
import { gateway } from '/js/api.js';
import { t } from '/js/i18n.js';

export function CallOverlay() {
  const calls = useSel((s) => s.calls); const users = useSel((s) => s.users);
  const id = Object.keys(calls)[0]; if (!id) return null;
  const ch = getChannel(id); const from = users[calls[id].from];
  if (!ch) return null;
  const accept = () => { dismissCall(id); goDm(id); voice.join(id); };
  const decline = () => { gateway.send('call_decline', { channelId: id }); dismissCall(id); };
  return html`<div class="call-ring" role="alertdialog" aria-label="Incoming call"><${Avatar} user=${from} size=${52} /><div><b>${ch.type === 'group' ? dmName(ch) : from?.displayName}</b><span>${ch.type === 'group' ? `${from?.displayName} ${t('is calling…')}` : t('Incoming voice call…')}</span></div>
    <div class="cr-btns"><button type="button" class="ctl bad" onClick=${decline} aria-label="Decline" data-tip=${t('Decline')}><${Icon} name="phone-off" size=${20} /></button><button type="button" class="ctl ok" onClick=${accept} aria-label="Accept" data-tip=${t('Accept')}><${Icon} name="phone" size=${20} /></button></div></div>`;
}
void state;
