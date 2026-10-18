// Orate — email verification UI: the /verify?token=… page, the "verify your email" screen (REQUIRE_EMAIL_VERIFICATION)
// and the optional reminder banner.
import { html, useState, useEffect, cx } from '/js/lib.js';
import { state, set, useSel, go, toast, openModal } from '/js/store.js';
import { api, gateway } from '/js/api.js';
import { logout } from '/js/events.js';
import { Icon, Logo } from '/js/icons.js';
import { Btn, Spinner } from '/js/ui.js';
import { t } from '/js/i18n.js';

const maskEmail = (e) => String(e || '').replace(/^(.{1,2}).*(@.*)$/, (_, a, b) => a + '•••' + b);

/** Asks the server for a fresh link; handles the cooldown. Resolves true when an email went out. */
export async function resendVerification() {
  try {
    const r = await api.post('/auth/resend-verification');
    toast(r.mode === 'console' ? 'No email server is set up, so the link was printed in the server console.' : `Verification email sent to ${r.email}`, 'success', 5000);
    return true;
  } catch (e) { toast(e.message, e.code === 'already_verified' ? 'info' : 'error', 5000); return false; }
}

function AuthShell({ children }) {
  return html`<div class="auth-screen">
    <div class="auth-orb o1"></div><div class="auth-orb o2"></div><div class="auth-orb o3"></div>
    <div class="auth-hero"><div class="auth-mark"><${Logo} size=${150} /></div><h1>Orate</h1></div>
    <div class="auth-card panel"><div class="auth-card-in verify-card">${children}</div></div>
  </div>`;
}

/** A 60-second cooldown for the resend button. */
function useCooldown(initial = 60) {
  const [left, setLeft] = useState(initial);
  useEffect(() => { if (left <= 0) return undefined; const id = setTimeout(() => setLeft(left - 1), 1000); return () => clearTimeout(id); }, [left]);
  return [left, () => setLeft(60)];
}

/* ------------------------------------------------------------------ /verify?token=… */
export function VerifyScreen() {
  const token = new URLSearchParams(location.search).get('token');
  const signedIn = useSel((s) => !!s.token);
  const [st, setSt] = useState(token ? 'working' : 'bad'); const [info, setInfo] = useState(null); const [err, setErr] = useState(token ? '' : 'This link is missing its token. Open the link from your email again.');
  useEffect(() => {
    if (!token) return;
    api.post('/auth/verify-email', { token }).then((r) => { setInfo(r); setSt('ok'); }).catch((e) => { setErr(e.message); setSt('bad'); });
  }, []);
  const cont = () => {
    if (signedIn) go('/channels/@me', { replace: true });
    else { history.replaceState({}, '', '/login'); set({ route: { view: 'login', serverId: '@me', channelId: null } }); }
  };
  return html`<${AuthShell}>
    ${st === 'working' ? html`<header><div class="verify-ic"><${Spinner} size=${34} /></div><h2>${t('Verifying your email…')}</h2></header>`
      : st === 'ok' ? html`<header><div class="verify-ic ok"><${Icon} name="check" size=${34} sw=${3} /></div><h2>${t('Email verified!')}</h2><p>${info?.email ? html`${info.email} ${t('is confirmed.')}` : t('Your email address is confirmed.')}</p></header>
        <${Btn} variant="primary" size="lg" class="btn-block" onClick=${cont}>${signedIn ? t('Continue to Orate') : t('Log in')}<//>`
        : html`<header><div class="verify-ic bad"><${Icon} name="alert-circle" size=${34} /></div><h2>${t('This link didn’t work')}</h2><p>${err}</p></header>
          ${signedIn ? html`<${Btn} variant="primary" size="lg" class="btn-block" onClick=${async () => { await resendVerification(); }}>${t('Send me a new link')}<//>` : null}
          <${Btn} variant=${signedIn ? 'ghost' : 'primary'} size="lg" class="btn-block" onClick=${cont}>${signedIn ? t('Back to Orate') : t('Log in')}<//>`}
  <//>`;
}

/* ------------------------------------------------------------------ required: nothing else is usable until verified */
export function VerifyGate() {
  const me = useSel((s) => s.me); const smtp = useSel((s) => s.emailVerif.smtp);
  const [left, restart] = useCooldown(60); const [busy, setBusy] = useState(false); const [checking, setChecking] = useState(false);
  const resend = async () => { setBusy(true); if (await resendVerification()) restart(); setBusy(false); };
  const check = async () => {
    setChecking(true);
    try {
      const m = await api.get('/me');
      if (m.emailVerified) { gateway.disconnect(); gateway.connect(); } else toast('Not verified yet — open the link in your email first.', 'info', 4000);
    } catch (e) { toast(e.message, 'error'); }
    setChecking(false);
  };
  return html`<${AuthShell}>
    <header><div class="verify-ic"><${Icon} name="at" size=${34} /></div><h2>${t('Verify your email')}</h2>
      <p>${t('We sent a link to')} <b>${maskEmail(me?.email)}</b>. ${t('Open it to start using Orate.')}</p></header>
    ${smtp ? null : html`<div class="note-chip"><${Icon} name="info" size=${14} /> ${t('No email server is configured, so the link was printed in the server console (or run npm run verify-email <username>).')}</div>`}
    <div class="auth-form">
      <${Btn} variant="primary" size="lg" class="btn-block" loading=${checking} onClick=${check}>${t('I’ve verified — continue')}<//>
      <${Btn} size="lg" class="btn-block" loading=${busy} disabled=${left > 0} onClick=${resend}>${left > 0 ? `${t('Resend email')} (${left}s)` : t('Resend email')}<//>
      <div class="verify-links"><button type="button" class="link-btn" onClick=${() => openModal('account-edit', { field: 'email' })}>${t('Wrong address? Change it')}</button><button type="button" class="link-btn" onClick=${() => logout()}>${t('Log out')}</button></div>
    </div>
  <//>`;
}

/* ------------------------------------------------------------------ optional: a gentle reminder */
export function VerifyBanner() {
  const show = useSel((s) => s.me?.emailVerified === false && s.emailVerif.enabled && !s.gated && !s.verifyDismissed);
  const email = useSel((s) => s.me?.email);
  const [busy, setBusy] = useState(false);
  if (!show) return null;
  return html`<div class="verify-banner pop-in" role="status">
    <${Icon} name="at" size=${16} /><span>${t('Please verify your email')} · <b>${maskEmail(email)}</b></span>
    <button type="button" class="vb-btn" disabled=${busy} onClick=${async () => { setBusy(true); await resendVerification(); setBusy(false); }}>${t('Resend link')}</button>
    <button type="button" class="vb-x" aria-label="Dismiss" onClick=${() => set({ verifyDismissed: true })}><${Icon} name="x" size=${14} /></button>
  </div>`;
}
void cx;
