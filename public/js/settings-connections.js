// Orata — Settings → Connections: link your Discord account to your Orata account. Orata gives a one-time code; typing it as /orata-account in Discord (in a server that has
// the Orata bot, or in a DM with it) links the Discord account that typed it. Discord itself tells the bot who typed it, so no password or login is ever handed over
// (server/discord.js). A linked account shows on your profile and next to your messages from a linked Discord channel, unless you switch that off.
import { html, useState, useEffect, copyText, relTime } from '/js/lib.js';
import { useSel, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Btn, Section, SettingRow, Toggle, confirmDialog } from '/js/ui.js';
import { api } from '/js/api.js';
import { act } from '/js/actions.js';
import { t } from '/js/i18n.js';

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function DiscordConnection() {
  const on = useSel((s) => s.discordOk); const link = useSel((s) => s.me?.discord);
  const [code, setCode] = useState(null); const [busy, setBusy] = useState(false); const [left, setLeft] = useState(0);
  useEffect(() => {   // the code runs out after 10 minutes
    if (!code) return undefined;
    const id = setInterval(() => { const s = Math.max(0, Math.round((code.until - Date.now()) / 1000)); setLeft(s); if (!s) setCode(null); }, 500);
    return () => clearInterval(id);
  }, [code]);
  useEffect(() => { if (link && code) { setCode(null); toast(t('Discord linked'), 'success', 2400); } }, [link?.at]);   // it worked (the server told this window): the code is spent
  const start = async () => {
    setBusy(true); const r = await act(api.post('/me/discord/code')); setBusy(false);
    if (r) { setCode({ ...r, until: Date.now() + r.expiresIn * 1000 }); setLeft(r.expiresIn); }
  };
  const unlink = async () => {
    if (await confirmDialog({ title: t('Unlink Discord?'), body: t('Your Discord account stops showing on your Orata profile. You can link it again any time.'), confirmLabel: t('Unlink'), danger: true })) await act(api.del('/me/discord'), { success: t('Discord unlinked') });
  };
  return html`<${Section} title="Discord" desc=${t('Link your Discord account to your Orata account. It shows on your profile, and next to your messages that come from a Discord channel linked with an Orata one.')}>
    ${link ? html`<div class="conn-card">
        <img class="conn-av" src=${link.avatar} alt="" referrerpolicy="no-referrer" />
        <div class="conn-text"><b>${link.name}</b><small>@${link.username} · ${t('linked')} ${relTime(link.at)}</small></div>
        <${Btn} variant="ghost" icon="link" onClick=${start} loading=${busy}>${t('Link another')}<//>
        <${Btn} variant="danger" icon="x" onClick=${unlink}>${t('Unlink')}<//></div>
      <${SettingRow} title=${t('Show it on my profile')} desc=${t('Anyone who opens your profile sees your Discord name, and your Discord messages in linked channels name your Orata account. Turn it off to keep the link private to you.')}>
        <${Toggle} checked=${link.show !== false} onChange=${(v) => act(api.patch('/me/discord', { show: v }))} /><//>`
      : html`<div class="conn-card none"><span class="conn-ic"><${Icon} name="link" size=${22} /></span><div class="conn-text"><b>${t('No Discord account linked')}</b><small>${on ? t('Press Link Discord, then type the command it shows in Discord.') : t('This Orata server hasn’t set up its Discord bot, so Discord can’t be linked here.')}</small></div>
        <${Btn} variant="primary" icon="link" disabled=${!on} loading=${busy} onClick=${start}>${t('Link Discord')}<//></div>`}
    ${code ? html`<div class="conn-code">
      <p>${t('In Discord, in a server that has the Orata bot (or in a DM with the bot), type:')}</p>
      <div class="conn-cmd"><code>${code.command}</code><${Btn} size="sm" icon="copy" onClick=${async () => { await copyText(code.command); toast(t('Copied'), 'success', 1400); }}>${t('Copy')}<//></div>
      <small>${t('This window updates by itself when it works. The code runs out in')} <b>${clock(left)}</b> ${t('and works once.')}${code.invite ? html` ${t('Is the bot not in your Discord server yet?')} <a href=${code.invite} target="_blank" rel="noopener">${t('Add it here')}</a>.` : null}</small>
      ${code.warning ? html`<small class="conn-warn">${code.warning}</small>` : null}</div>` : null}
  <//>`;
}

export function ConnectionsPage() {
  return html`<div class="s-page"><${DiscordConnection} /></div>`;
}
