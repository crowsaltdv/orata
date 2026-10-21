// Orata — email verification: one-time links sent at sign-up (and when the address changes).
//
// How it behaves is decided by .env:
//   SMTP_HOST set                  -> verification is ON: every new account gets a link by email; an in-app banner asks until it is clicked.
//   REQUIRE_EMAIL_VERIFICATION=true -> verification is REQUIRED: unverified accounts only see a "verify your email" screen
//                                      (with no SMTP server the link is printed to the server console — dev mode).
//   neither                        -> verification is off and nobody is nagged.
// Accounts that existed before verification was introduced count as verified.
import crypto from 'node:crypto';
import { db, save, sha, ENV, closeConns, emitTo, selfUser } from './core.js';
import { mailConfig, sendMail, truthy } from './mail.js';

const TTL_MS = (Number(ENV.EMAIL_TOKEN_TTL_HOURS) || 24) * 3600_000;
const RESEND_COOLDOWN_MS = 60_000;
const lastSent = new Map();

export function verificationMode() {
  const smtp = !!mailConfig(); const required = truthy(ENV.REQUIRE_EMAIL_VERIFICATION);
  return { enabled: smtp || required, required, smtp };
}
/** True when this user may not use the app until they verify (only in REQUIRED mode). */
export const isGated = (user) => !!user && !user.bot && user.emailVerified === false && verificationMode().required;

/** Orata's public address (links in emails, Orata people's pictures on Discord). PUBLIC_URL is the safe choice; without it we fall back to
 *  the address the request came to. Hosts like Render handle https in front of Orata and say so in X-Forwarded-Proto, even without TRUST_PROXY. */
export function baseUrl(req) {
  const fixed = String(ENV.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (fixed) return fixed;
  const proto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim() === 'https' ? 'https' : req.protocol;
  return `${proto}://${req.get('host')}`;
}

export const maskEmail = (e) => String(e || '').replace(/^(.{1,2}).*(@.*)$/, (_, a, b) => a + '•••' + b);

function mailFor(user, link) {
  const hours = Math.round(TTL_MS / 3600_000);
  const name = user.displayName || user.username;
  const text = `Hi ${name},\n\nWelcome to Orata! Confirm your email address by opening this link:\n\n${link}\n\nThe link works for ${hours} hours and can only be used once.\nIf you didn't create an Orata account, you can safely ignore this email.\n`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1b1830">
<h2 style="margin:0 0 12px">Confirm your email</h2>
<p>Hi ${esc(name)}, welcome to Orata! Tap the button to confirm this address.</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#64748b;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Verify my email</a></p>
<p style="font-size:13px;color:#555">Or paste this link into your browser:<br><a href="${esc(link)}" style="color:#475569;word-break:break-all">${esc(link)}</a></p>
<p style="font-size:13px;color:#555">The link works for ${hours} hours and can only be used once. If you didn't create an Orata account, you can ignore this email.</p></div>`;
  return { to: user.email, subject: 'Confirm your email for Orata', text, html };
}

/** Creates a fresh one-time token for the user's current email address and sends the link. Never throws; resolves `{ sent, mode?, error? }`. */
export async function issueVerification(user, req) {
  try {
    db.emailTokens ||= {};
    const now = Date.now();
    for (const [k, t] of Object.entries(db.emailTokens)) if (t.exp < now || t.uid === user.id) delete db.emailTokens[k];   // expired, or older links of this user
    const token = crypto.randomBytes(32).toString('base64url');
    db.emailTokens[sha(token)] = { uid: user.id, email: user.email, exp: now + TTL_MS };
    save(); lastSent.set(user.id, now);
    const res = await sendMail(mailFor(user, `${baseUrl(req)}/verify?token=${token}`));
    return { sent: true, mode: res.mode };
  } catch (e) {
    console.error(`[orata] could not send the verification email to ${user.email}: ${e.message}`);
    return { sent: false, error: e.message };
  }
}

export const resendWait = (user) => Math.max(0, RESEND_COOLDOWN_MS - (Date.now() - (lastSent.get(user.id) || 0)));

/** Marks the address verified for a valid, unused token. Returns the user, or null. */
export function consumeVerification(token) {
  const key = sha(String(token || '')); const rec = db.emailTokens?.[key];
  if (!rec || rec.exp < Date.now()) { if (rec) { delete db.emailTokens[key]; save(); } return null; }
  const user = db.users[rec.uid];
  if (!user || user.deleted || user.email !== rec.email) { delete db.emailTokens[key]; save(); return null; }   // address changed since the link was sent
  user.emailVerified = true; user.emailVerifiedAt = Date.now();
  for (const [k, t] of Object.entries(db.emailTokens)) if (t.uid === user.id) delete db.emailTokens[k];
  save();
  emitTo([user.id], 'self_update', { user: selfUser(user) });   // open tabs drop their banner
  closeConns(user.id, 4010, 'verified', { onlyGated: true });   // tabs sitting on the "verify your email" screen reconnect with the full app
  return user;
}
