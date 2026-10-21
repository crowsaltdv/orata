// Orata — joining a server that asks people to apply first (server/applications.js): the Apply window, the application cards in the server's
// applications channel (Accept / Reject for people with Access Applications), and the server preview a worn server tag opens.
import { html, useState, useEffect, relTime } from '/js/lib.js';
import { useSel, openModal, closeModal, closePopover, goChannel, toast, hasPerm } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Modal, Btn, Spinner, Avatar, ServerIcon, MODALS, POPOVERS, TextInput } from '/js/ui.js';
import { api } from '/js/api.js';
import { act, errMsg } from '/js/actions.js';
import { t } from '/js/i18n.js';

/** Joins with an invite code; a server that takes applications opens the Apply window instead (resolves null then). */
export async function joinInvite(code) {
  try { return await api.post(`/invites/${code}/join`); } catch (e) { if (e.code === 'apply_required') { openModal('apply', { code }); return null; } throw e; }
}

/** Where someone stands with a server that takes applications. */
function AppStatus({ info }) {
  const a = info.application;
  if (a?.status === 'pending') return html`<div class="app-note"><${Icon} name="clock" size=${16} />${t('Your application is waiting for the server’s team.')} <small>${t('Sent')} ${relTime(a.at)}</small></div>`;
  if (a?.status === 'rejected') return html`<div class="app-note bad"><${Icon} name="x-circle" size=${16} />${t('Your last application wasn’t accepted.')}${a.reason ? ` ${t('Reason')}: ${a.reason}` : ''}${a.again > Date.now() ? html` <small>${t('You can apply again')} ${relTime(a.again)}</small>` : null}</div>`;
  return null;
}

/** The Apply window: from an invite (`code`) or a server tag (`serverId`). */
MODALS.apply = function Apply({ id, code, serverId }) {
  const [info, setInfo] = useState(null); const [err, setErr] = useState(null); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { (code ? api.get(`/invites/${code}`).then((r) => r.server) : api.get(`/servers/${serverId}/preview`)).then(setInfo, (e) => setErr(errMsg(e))); }, [code, serverId]);
  const send = async () => {
    setBusy(true);
    try { setInfo(await api.post(code ? `/invites/${code}/apply` : `/servers/${serverId}/apply`, { message: text.trim() })); toast(t('Application sent'), 'success'); } catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };
  const waiting = info?.application?.status === 'pending' || (info?.application?.status === 'rejected' && info.application.again > Date.now());
  return html`<${Modal} width=${440} onClose=${() => closeModal(id)}>
    ${err ? html`<div class="invite-card"><div class="ic-bad"><${Icon} name="alert-circle" size=${42} sw=${1.6} /></div><h2>${t('Can’t apply')}</h2><p>${err}</p></div>`
      : !info ? html`<div class="pk-center" style="padding:40px"><${Spinner} /></div>`
        : html`<div class="invite-card app-card-modal"><${ServerIcon} server=${info} size=${76} class="ic-icon" /><h2>${info.name}</h2>
          <div class="ic-stats"><span><i class="on"></i>${info.onlineCount} ${t('Online')}</span><span><i></i>${info.memberCount} ${t('Members')}</span></div>
          ${info.member ? html`<${Btn} variant="primary" size="lg" class="btn-block" onClick=${() => { closeModal(id); goChannel(info.id, null); }}>${t('Open Server')}<//>`
            : html`<p class="app-intro">${t('This server asks people to apply. Its team reads every application and lets you know through Orbit.')}</p>
              <${AppStatus} info=${info} />
              ${waiting ? null : html`<label class="app-q">${info.applyQuestion || t('Why do you want to join?')}</label>
                <textarea class="textarea" rows="4" maxlength="1000" value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${t('Write a few words…')}></textarea>
                <${Btn} variant="primary" size="lg" class="btn-block" loading=${busy} disabled=${!text.trim()} onClick=${send}>${t('Send application')}<//>`}`}</div>`}
  <//>`;
};

/** An application in the applications channel. */
export function ApplicationCard({ m, ch }) {
  const a = m.application || {}; const user = useSel((s) => s.users[a.userId || m.authorId]); const by = useSel((s) => (a.by ? s.users[a.by] : null));
  const [rejecting, setRejecting] = useState(false); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const can = hasPerm(ch.serverId, 'ACCESS_APPLICATIONS') || hasPerm(ch.serverId, 'ADMINISTRATOR');
  const decide = async (accept) => { setBusy(true); await act(api.post(`/servers/${ch.serverId}/applications/${a.id}/${accept ? 'accept' : 'reject'}`, accept ? {} : { reason })); setBusy(false); setRejecting(false); };
  const STATUS = { accepted: [t('Accepted'), 'check-circle'], rejected: [t('Rejected'), 'x-circle'], gone: [t('No longer available'), 'info'] }[a.status];
  return html`<div class="app-card" data-mid=${m.id}>
    <div class="app-head"><${Avatar} user=${user} size=${44} /><div class="app-who"><b>${user?.displayName || t('Someone')}</b><small>@${user?.username || '?'} · ${t('account made')} ${user?.createdAt ? relTime(user.createdAt) : '?'}</small></div>
      <small class="app-when">${t('applied')} ${relTime(a.at || m.createdAt)}</small></div>
    ${a.message ? html`<p class="app-msg">${a.message}</p>` : null}
    ${a.status === 'pending' ? (can ? (rejecting
      ? html`<div class="app-actions"><${TextInput} value=${reason} onInput=${setReason} placeholder=${t('Reason (optional, they’ll see it)')} maxlength="300" /><${Btn} size="sm" variant="danger" loading=${busy} onClick=${() => decide(false)}>${t('Reject')}<//><${Btn} size="sm" variant="ghost" onClick=${() => setRejecting(false)}>${t('Cancel')}<//></div>`
      : html`<div class="app-actions"><${Btn} size="sm" variant="success" icon="check" loading=${busy} onClick=${() => decide(true)}>${t('Accept')}<//><${Btn} size="sm" variant="danger" icon="x" onClick=${() => setRejecting(true)}>${t('Reject')}<//></div>`)
      : html`<div class="app-status">${t('Waiting for someone with Access Applications')}</div>`)
      : html`<div class=${`app-status ${a.status}`}><${Icon} name=${STATUS?.[1] || 'info'} size=${15} />${STATUS?.[0]}${by ? ` ${t('by')} ${by.displayName}` : a.status === 'accepted' && !a.by ? ` (${t('applying was switched off')})` : ''}${a.reason ? ` · ${a.reason}` : ''}</div>`}
  </div>`;
}

/** Clicking someone's server tag: the server it belongs to, to join (or apply to) without an invite. */
POPOVERS['server-preview'] = function ServerPreview({ serverId }) {
  const [info, setInfo] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const inServer = useSel((s) => !!s.servers[serverId]);
  useEffect(() => { api.get(`/servers/${serverId}/preview`).then(setInfo, (e) => setErr(errMsg(e))); }, [serverId]);
  const join = async () => {
    setBusy(true);
    try { await api.post(`/servers/${serverId}/join`); closePopover(); setTimeout(() => goChannel(serverId, null), 200); toast(`${t('Joined')} ${info.name}!`, 'success'); } catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };
  if (err) return html`<div class="pop-card srv-pop"><p class="text-muted">${err}</p></div>`;
  if (!info) return html`<div class="pop-card srv-pop"><div class="pk-center"><${Spinner} size=${22} /></div></div>`;
  const apply = info.joinMode === 'apply';
  return html`<div class="pop-card srv-pop">
    ${info.banner ? html`<div class="srv-pop-banner" style=${{ backgroundImage: `url(${info.banner})` }}></div>` : html`<div class="srv-pop-banner plain" style=${{ background: info.accent || 'var(--accent-grad)' }}></div>`}
    <div class="srv-pop-body"><${ServerIcon} server=${info} size=${56} class="srv-pop-icon" />
      <h3>${info.name}</h3>
      <div class="ic-stats"><span><i class="on"></i>${info.onlineCount} ${t('Online')}</span><span><i></i>${info.memberCount} ${t('Members')}</span></div>
      ${info.description ? html`<p class="srv-pop-desc">${info.description}</p>` : null}
      ${inServer || info.member ? html`<${Btn} class="btn-block" onClick=${() => { closePopover(); goChannel(serverId, null); }}>${t('Go to Server')}<//>`
        : apply ? html`<${AppStatus} info=${info} /><${Btn} class="btn-block" variant="primary" icon="edit" onClick=${() => { closePopover(); openModal('apply', { serverId }); }}>${info.application?.status === 'pending' ? t('See application') : t('Apply to join')}<//>`
          : html`<${Btn} class="btn-block" variant="success" loading=${busy} onClick=${join}>${t('Join Server')}<//>`}</div>
  </div>`;
};
