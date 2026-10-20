// Orate — server invite cards: an invite link in a message turns into a card with the server, who is online and a Join button.
import { html, useState, useEffect, cx } from '/js/lib.js';
import { state, useSel, goChannel, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { ServerIcon, Btn, Spinner } from '/js/ui.js';
import { api } from '/js/api.js';
import { t } from '/js/i18n.js';

/** The invite code in `https://<this site>/invite/<code>`, or null. Only links to this Orate count — a code means nothing elsewhere. */
export function inviteCodeOf(url) {
  try {
    const u = new URL(url);
    if (u.origin !== location.origin) return null;
    return u.pathname.match(/^\/invite\/([A-Za-z0-9-]{3,32})\/?$/)?.[1] || null;   // (custom links have dashes)
  } catch { return null; }
}

const cache = new Map();   // code → { promise, res: { d } | { e } }
const lookup = (code) => {
  let hit = cache.get(code);
  if (!hit) { hit = { promise: api.get(`/invites/${code}`).then((d) => ({ d }), (e) => ({ e })) }; hit.promise.then((r) => { hit.res = r; }); cache.set(code, hit); }
  return hit;
};

export function InviteCard({ code, mine }) {
  const [res, setRes] = useState(() => cache.get(code)?.res || null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; setRes(cache.get(code)?.res || null); lookup(code).promise.then((r) => live && setRes(r)); return () => { live = false; }; }, [code]);
  const server = res?.d?.server;
  const inServer = useSel((s) => !!(server && s.servers[server.id]));
  const header = mine ? t('You sent an invite to join a server') : t('You’ve been invited to join a server');
  if (!res) return html`<div class="invite-embed loading"><div class="ie-head">${header}</div><div class="ie-row"><${Spinner} size=${22} /></div></div>`;
  if (res.e) return html`<div class="invite-embed bad"><div class="ie-head">${mine ? t('You sent an invite, but it didn’t work') : t('You received an invite, but it didn’t work')}</div>
    <div class="ie-row"><span class="ie-bad"><${Icon} name="link" size=${22} /></span><div class="ie-info"><b class="ie-name">${res.e.status === 404 ? t('Invite invalid') : t('Invite unavailable')}</b><div class="ie-sub">${res.e.status === 404 ? t('This invite is invalid or has expired.') : res.e.message}</div></div></div></div>`;
  const join = async () => {
    setBusy(true);
    try { const s = await api.post(`/invites/${code}/join`); cache.delete(code); goChannel(s.id, null); toast(`${t('Joined')} ${s.name}!`, 'success', 2500); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  const est = server.createdAt ? new Date(server.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : null;
  return html`<div class=${cx('invite-embed', inServer && 'joined')}>
    <div class="ie-head">${header}</div>
    <div class="ie-row">
      <${ServerIcon} server=${server} size=${54} class="ie-icon" />
      <div class="ie-info"><b class="ie-name" title=${server.name}>${server.name}</b>
        <div class="ie-stats"><span><i class="on"></i>${server.onlineCount.toLocaleString()} ${t('Online')}</span><span><i></i>${server.memberCount.toLocaleString()} ${server.memberCount === 1 ? t('Member') : t('Members')}</span>${est ? html`<span class="ie-est">${t('Est.')} ${est}</span>` : null}</div></div>
      ${inServer ? html`<${Btn} class="ie-btn" onClick=${() => goChannel(server.id, null)}>${t('Go to Server')}<//>` : html`<${Btn} class="ie-btn" variant="success" loading=${busy} onClick=${join}>${t('Join')}<//>`}
    </div>
  </div>`;
}
void state;
