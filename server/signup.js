// Orata — sign-up with an emailed code.
//
// When email verification is on (SMTP_HOST set, or REQUIRE_EMAIL_VERIFICATION=true) nobody gets an account just by filling in the
// form: the server emails a 6-digit code and only creates the account once that code is typed in. Until then the half-finished
// sign-up lives in memory only (never in db.json), for 10 minutes.
import crypto from 'node:crypto';
import { sha, ApiError, bad } from './core.js';
import { sendMail } from './mail.js';

const CODE_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_TRIES = 5;
const MAX_RESENDS = 5;
const MAX_PENDING = 3000;

const pending = new Map();        // ticket -> { fields, codeHash, exp, tries, resends, sentAt }
const ticketByEmail = new Map();  // email  -> ticket (one open sign-up per address)

const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const hashCode = (ticket, code) => sha(`${ticket}:${code}`);
const drop = (ticket) => { const p = pending.get(ticket); if (p) { pending.delete(ticket); if (ticketByEmail.get(p.fields.email) === ticket) ticketByEmail.delete(p.fields.email); } };
const sweep = () => { const now = Date.now(); for (const [t, p] of pending) if (p.exp < now) drop(t); };
setInterval(sweep, 60_000).unref();

function codeMail(fields, code) {
  const minutes = Math.round(CODE_TTL_MS / 60_000);
  const name = fields.displayName || fields.username;
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const text = `Hi ${name},\n\nYour Orata verification code is:\n\n    ${spaced}\n\nType it into the sign-up page to finish creating your account. It expires in ${minutes} minutes.\nIf you didn't try to sign up for Orata, you can ignore this email — no account will be created.\n`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1b1830">
<h2 style="margin:0 0 12px">Your verification code</h2>
<p>Hi ${esc(name)}, type this code into Orata to finish creating your account:</p>
<p style="margin:22px 0;text-align:center"><span style="display:inline-block;font-family:Consolas,Menlo,monospace;font-size:34px;letter-spacing:8px;font-weight:700;background:#eef1f5;color:#1e293b;padding:14px 22px;border-radius:12px">${esc(code)}</span></p>
<p style="font-size:13px;color:#555">It expires in ${minutes} minutes. If you didn't try to sign up for Orata, you can ignore this email — no account will be created.</p></div>`;
  return { to: fields.email, subject: `${code} is your Orata verification code`, text, html };
}

async function deliver(fields, code) {
  try { return await sendMail(codeMail(fields, code)); } catch (e) {
    console.error(`[orata] could not send the sign-up code to ${fields.email}: ${e.message}`);
    throw new ApiError(502, 'We couldn’t send the verification email. If you run this server, check the SMTP settings in .env and the console for the reason.', 'mail_failed');
  }
}
const info = (out) => ({ mode: out.mode, expiresIn: CODE_TTL_MS / 1000, resendIn: RESEND_COOLDOWN_MS / 1000 });

/** Emails a code and remembers the half-finished sign-up. Resolves { ticket, mode, expiresIn, resendIn }. */
export async function beginSignup(fields) {
  sweep();
  const old = ticketByEmail.get(fields.email); const oldRec = old && pending.get(old);
  if (oldRec && Date.now() - oldRec.sentAt < RESEND_COOLDOWN_MS) throw new ApiError(429, 'A code was just sent to that address. Check your inbox (and spam), or wait a minute to try again.', 'rate_limited');
  if (pending.size >= MAX_PENDING) throw new ApiError(503, 'Too many sign-ups in progress. Try again in a few minutes.', 'busy');
  const ticket = crypto.randomBytes(24).toString('base64url'); const code = newCode();
  const out = await deliver(fields, code);   // if the mail fails the person is told right away
  if (old) drop(old);
  pending.set(ticket, { fields, codeHash: hashCode(ticket, code), exp: Date.now() + CODE_TTL_MS, tries: 0, resends: 0, sentAt: Date.now() });
  ticketByEmail.set(fields.email, ticket);
  return { ticket, ...info(out) };
}

/** Checks the typed code. Returns the stored sign-up fields (and forgets the sign-up) or throws. */
export function confirmSignup(ticket, code) {
  const key = String(ticket || ''); const p = pending.get(key);
  if (!p || p.exp < Date.now()) { drop(key); throw bad('That code has expired. Go back and request a new one.', 'code_expired'); }
  const typed = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(typed)) throw bad('Enter the 6-digit code from the email.', 'code');
  const a = Buffer.from(hashCode(key, typed), 'hex'); const b = Buffer.from(p.codeHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    p.tries++;
    if (p.tries >= MAX_TRIES) { drop(key); throw bad('Too many wrong codes. Start the sign-up again.', 'code_locked'); }
    throw bad(`That code isn’t right. ${MAX_TRIES - p.tries} ${MAX_TRIES - p.tries === 1 ? 'try' : 'tries'} left.`, 'code');
  }
  drop(key);
  return p.fields;
}

/** Sends a fresh code for an open sign-up (once a minute, five times at most). */
export async function resendSignup(ticket) {
  const key = String(ticket || ''); const p = pending.get(key);
  if (!p || p.exp < Date.now()) { drop(key); throw bad('This sign-up expired. Go back and start again.', 'code_expired'); }
  const wait = RESEND_COOLDOWN_MS - (Date.now() - p.sentAt);
  if (wait > 0) throw new ApiError(429, `Please wait ${Math.ceil(wait / 1000)} seconds before asking for another code.`, 'rate_limited');
  if (p.resends >= MAX_RESENDS) throw new ApiError(429, 'Too many codes requested. Start the sign-up again.', 'rate_limited');
  const code = newCode();
  const out = await deliver(p.fields, code);
  p.codeHash = hashCode(key, code); p.exp = Date.now() + CODE_TTL_MS; p.tries = 0; p.resends++; p.sentAt = Date.now();
  return info(out);
}

/** Test helper: how many sign-ups are waiting for a code. */
export const pendingCount = () => pending.size;
