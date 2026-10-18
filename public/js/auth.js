// Orate — sign in / sign up screen.
import { html, useState, useEffect, useRef, cx, debounce, ls } from '/js/lib.js';
import { state, set, useSel, toast } from '/js/store.js';
import { api } from '/js/api.js';
import { login, register } from '/js/events.js';
import { Icon, Logo } from '/js/icons.js';
import { Btn, Field, TextInput, Spinner } from '/js/ui.js';
import { t } from '/js/i18n.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function strength(pw) {
  let s = 0;
  if (pw.length >= 8) s++; if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^\w\s]|_/.test(pw)) s++; else if (/\d/.test(pw)) s += 0.5;
  return Math.min(4, Math.floor(s));
}
const SCORE = ['Too weak', 'Weak', 'Okay', 'Good', 'Strong'];

function PasswordInput({ value, onInput, placeholder, autocomplete, onEnter, id }) {
  const [show, setShow] = useState(false);
  return html`<${TextInput} id=${id} type=${show ? 'text' : 'password'} value=${value} onInput=${onInput} placeholder=${placeholder} autocomplete=${autocomplete} icon="lock"
    onKeyDown=${(e) => e.key === 'Enter' && onEnter?.()}
    right=${html`<button type="button" class="pw-eye" tabindex="-1" onClick=${() => setShow(!show)} aria-label=${show ? 'Hide password' : 'Show password'}><${Icon} name=${show ? 'eye-off' : 'eye'} size=${18} /></button>`} />`;
}

function LoginForm({ go }) {
  const [id, setId] = useState(ls('lastLogin', '')); const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [shake, setShake] = useState(0);
  const submit = async () => {
    if (!id.trim() || !pw) { setErr('Enter your username or email and your password.'); setShake((s) => s + 1); return; }
    setBusy(true); setErr(null);
    try { ls('lastLogin', null, id.trim()); await login(id.trim(), pw); } catch (e) { setBusy(false); setErr(e.status === 401 ? 'Invalid username/email or password.' : e.message); setShake((s) => s + 1); }
  };
  return html`<div class="auth-form" key=${shake} style=${err ? 'animation: shake .4s' : ''}>
    <${Field} label=${t('Email or username')}><${TextInput} value=${id} onInput=${setId} placeholder="you@example.com" autocomplete="username" autofocus icon="user" onKeyDown=${(e) => e.key === 'Enter' && document.getElementById('login-pw')?.focus()} /><//>
    <${Field} label=${t('Password')}><${PasswordInput} id="login-pw" value=${pw} onInput=${setPw} autocomplete="current-password" placeholder="••••••••" onEnter=${submit} /><//>
    ${err ? html`<div class="auth-error slide-down"><${Icon} name="alert-circle" size=${16} />${err}</div>` : null}
    <button type="button" class="link-btn" onClick=${() => toast('Self-hosted Orate has no email service yet. Ask the server admin to run: npm run reset-password <username>', 'info', 7000)}>${t('Forgot your password?')}</button>
    <${Btn} variant="primary" size="lg" class="btn-block" loading=${busy} onClick=${submit}>${t('Log In')}<//>
    <div class="auth-switch">${t('Need an account?')} <button type="button" class="link-btn" onClick=${() => go('register')}>${t('Register')}</button></div>
  </div>`;
}

function RegisterForm({ go }) {
  const now = new Date().getFullYear();
  const [f, setF] = useState({ email: '', displayName: '', username: '', password: '', month: '', day: '', year: '' });
  const [errs, setErrs] = useState({}); const [busy, setBusy] = useState(false); const [avail, setAvail] = useState(null);
  const [agree, setAgree] = useState(true);
  const up = (k) => (v) => { setF((p) => ({ ...p, [k]: v })); setErrs((p) => ({ ...p, [k]: undefined, general: undefined })); };
  const check = useRef(debounce(async (username) => {
    if (!/^[a-z0-9_.]{2,32}$/.test(username)) { setAvail(username ? false : null); return; }
    try { const r = await api.post('/auth/check', { username }); setAvail(r.username); } catch { setAvail(null); }
  }, 350)).current;
  const onUsername = (v) => { const u = v.toLowerCase().replace(/\s/g, ''); up('username')(u); setAvail(null); check(u); };
  const score = strength(f.password);
  const submit = async () => {
    const e = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) e.email = 'Enter a valid email';
    if (!f.username) e.username = 'Choose a username'; else if (!/^[a-z0-9_.]{2,32}$/.test(f.username)) e.username = '2–32 letters, numbers, _ or .'; else if (avail === false) e.username = 'Already taken';
    if (f.password.length < 8) e.password = 'At least 8 characters';
    if (!f.month || !f.day || !f.year) e.dob = 'Enter your birthday';
    if (Object.keys(e).length) { setErrs(e); return; }
    setBusy(true);
    try { await register({ email: f.email, username: f.username, displayName: f.displayName.trim() || f.username, password: f.password, dob: { year: +f.year, month: +f.month, day: +f.day } }); } catch (er) {
      setBusy(false);
      if (['email', 'username', 'password', 'dob'].includes(er.code)) setErrs({ [er.code]: er.message }); else setErrs({ general: er.message });
    }
  };
  return html`<div class="auth-form">
    <${Field} label=${t('Email')} error=${errs.email}><${TextInput} type="email" value=${f.email} onInput=${up('email')} autocomplete="email" icon="at" autofocus placeholder="you@example.com" /><//>
    <div class="two-col">
      <${Field} label=${t('Display name')}><${TextInput} value=${f.displayName} onInput=${up('displayName')} maxlength="32" placeholder="How friends see you" icon="user" /><//>
      <${Field} label=${t('Username')} error=${errs.username}>
        <${TextInput} value=${f.username} onInput=${onUsername} maxlength="32" autocomplete="username" placeholder="unique_name" icon="hash"
          right=${f.username ? html`<span class=${cx('avail', avail === true && 'ok', avail === false && 'no')}>${avail === null ? html`<${Spinner} size=${14} />` : html`<${Icon} name=${avail ? 'check' : 'x'} size=${16} sw=${3} />`}</span>` : null} />
      <//>
    </div>
    <${Field} label=${t('Password')} error=${errs.password}>
      <${PasswordInput} value=${f.password} onInput=${up('password')} autocomplete="new-password" placeholder="At least 8 characters" />
      ${f.password ? html`<div class="strength s${score}"><div class="bars"><i></i><i></i><i></i><i></i></div><span>${SCORE[score]}</span></div>` : null}
    <//>
    <${Field} label=${t('Date of birth')} error=${errs.dob}>
      <div class="dob">
        <select class="select" value=${f.month} onChange=${(e) => up('month')(e.target.value)}><option value="">Month</option>${MONTHS.map((m, i) => html`<option value=${i + 1}>${m}</option>`)}</select>
        <select class="select" value=${f.day} onChange=${(e) => up('day')(e.target.value)}><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => html`<option value=${i + 1}>${i + 1}</option>`)}</select>
        <select class="select" value=${f.year} onChange=${(e) => up('year')(e.target.value)}><option value="">Year</option>${Array.from({ length: 110 }, (_, i) => html`<option value=${now - 13 - i}>${now - 13 - i}</option>`)}</select>
      </div>
    <//>
    ${errs.general ? html`<div class="auth-error slide-down"><${Icon} name="alert-circle" size=${16} />${errs.general}</div>` : null}
    <label class="check-row"><input type="checkbox" checked=${agree} onChange=${(e) => setAgree(e.target.checked)} /><span class="box"><${Icon} name="check" size=${13} sw=${3.5} /></span><span>${t('I agree to be kind to others and follow the community guidelines.')}</span></label>
    <${Btn} variant="primary" size="lg" class="btn-block" loading=${busy} disabled=${!agree} onClick=${submit}>${t('Create Account')}<//>
    <div class="auth-switch">${t('Already have an account?')} <button type="button" class="link-btn" onClick=${() => go('login')}>${t('Log In')}</button></div>
  </div>`;
}

export function AuthScreen() {
  const view = useSel((s) => (s.route.view === 'register' ? 'register' : 'login'));
  const [dir, setDir] = useState(1);
  const go = (v) => { setDir(v === 'register' ? 1 : -1); history.replaceState({}, '', '/' + v); set({ route: { ...state.route, view: v } }); };
  useEffect(() => { if (state.route.view !== 'login' && state.route.view !== 'register') go('login'); }, []);
  const invite = state.route.param || ls('pendingInvite', null);
  return html`<div class="auth-screen">
    <div class="auth-orb o1"></div><div class="auth-orb o2"></div><div class="auth-orb o3"></div>
    <div class="auth-hero">
      <div class="auth-mark"><${Logo} size=${150} /></div>
      <h1>Orate</h1>
      <p>${t('Say it your way.')}</p>
    </div>
    <div class=${cx('auth-card panel', view)}>
      <div class="auth-card-in" key=${view} data-dir=${dir}>
        <header>
          <${Logo} size=${46} class="auth-logo" />
          <h2>${view === 'login' ? t('Welcome back!') : t('Create an account')}</h2>
          <p>${view === 'login' ? t("We're so excited to see you again!") : t('Join the conversation — it takes less than a minute.')}</p>
          ${invite ? html`<div class="invite-note"><${Icon} name="link" size=${15} /> You’ve been invited to join a server. ${view === 'login' ? 'Log in' : 'Sign up'} to accept.</div>` : null}
        </header>
        ${view === 'login' ? html`<${LoginForm} go=${go} />` : html`<${RegisterForm} go=${go} />`}
      </div>
    </div>
  </div>`;
}

export function Splash({ text }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const id = setTimeout(() => setSlow(true), 7000); return () => clearTimeout(id); }, []);
  return html`<div class="splash"><div class="splash-mark"><${Logo} size=${96} /></div><div class="splash-text">${slow ? 'Still connecting… is the Orate server running?' : text || 'Connecting…'}</div></div>`;
}
void toast;
