// Orate — outgoing email.
//
// A small SMTP client with no dependencies (so `npm install` stays express + ws): implicit TLS (port 465) or STARTTLS (port 587),
// AUTH PLAIN / LOGIN, UTF-8 subjects, text + HTML bodies. Works with Gmail (app password), Outlook, Mailgun, SendGrid, Resend,
// Brevo, Amazon SES, Postmark … anything that speaks SMTP.
//
// With SMTP_HOST unset nothing is sent: the message is printed to the server console instead, which is what you want while
// developing ("dev mode" — the verification link shows up in your terminal).
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';
import { ENV } from './core.js';

export const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();           // header values must never contain line breaks
const EMAIL = /[^\s<>"',;]+@[^\s<>"',;]+/;
const addrOf = (s) => { const m = /<([^<>\s]+)>/.exec(s) || EMAIL.exec(s); return clean(m ? m[1] ?? m[0] : s); };
/** Splits "Orate <a@b.c>" / "Orate a@b.c" / "a@b.c" into { name, addr }. */
const parseFrom = (s) => { const addr = addrOf(s); const name = clean(String(s).replace(addr, '').replace(/[<>"]/g, '')); return { name, addr }; };
const isLoopback = (h) => /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(h);

/** SMTP settings from .env, or null when no SMTP server is configured. */
export function mailConfig() {
  const host = clean(ENV.SMTP_HOST);
  if (!host) return null;
  const secure = truthy(ENV.SMTP_SECURE);
  const user = clean(ENV.SMTP_USER); const pass = String(ENV.SMTP_PASS ?? '');
  const fromRaw = clean(ENV.MAIL_FROM) || (user.includes('@') ? `Orate <${user}>` : `Orate <no-reply@${host}>`);
  const sender = parseFrom(fromRaw);
  return {
    host, secure, port: Number(ENV.SMTP_PORT) || (secure ? 465 : 587), user, pass,
    from: sender.addr, fromHeader: sender.name ? `${sender.name} <${sender.addr}>` : sender.addr,
    rejectUnauthorized: !/^(0|false|no|off)$/i.test(String(ENV.SMTP_TLS_VERIFY ?? 'true')),
    timeout: Number(ENV.SMTP_TIMEOUT_MS) || 20_000,
  };
}

/* ------------------------------------------------------------------ message */
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const b64Lines = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

export function buildMessage(cfg, { to, subject, text, html }) {
  const boundary = 'orate_' + crypto.randomBytes(12).toString('hex');
  const domain = cfg.from.split('@')[1] || 'localhost';
  const head = [
    `From: ${clean(cfg.fromHeader).replace(/^(.*?)\s*<(.+)>$/, (_, n, a) => (n ? `${encWord(n.replace(/^"|"$/g, ''))} <${a}>` : `<${a}>`))}`,
    `To: <${addrOf(to)}>`,
    `Subject: ${encWord(clean(subject))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(14).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Lines(body)}\r\n`;
  return `${head}\r\n\r\n${part('text/plain', text)}${html ? part('text/html', html) : ''}--${boundary}--\r\n`;
}

/* ------------------------------------------------------------------ SMTP session */
function smtpSession(cfg, { to, data, authOnly = false }) {
  return new Promise((resolve, reject) => {
    let sock = null; let buf = ''; let cur = []; const replies = []; let waiter = null; let finished = false; let tlsOn = cfg.secure;
    const timer = setTimeout(() => fail(new Error(`SMTP timed out talking to ${cfg.host}:${cfg.port}`)), cfg.timeout);
    const fail = (e) => { if (finished) return; finished = true; clearTimeout(timer); try { sock?.destroy(); } catch { /* ignore */ } reject(e); };
    const succeed = () => { if (finished) return; finished = true; clearTimeout(timer); try { sock?.end(); } catch { /* ignore */ } resolve(); };

    const pump = () => {
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); cur.push(line);
        if (/^\d{3}( |$)/.test(line)) { replies.push({ code: Number(line.slice(0, 3)), lines: cur }); cur = []; }
      }
      if (waiter && replies.length) { const w = waiter; waiter = null; w(replies.shift()); }
    };
    const onData = (c) => { buf += c.toString('utf8'); pump(); };
    const attach = (s) => { sock = s; s.on('data', onData); s.on('error', fail); s.on('close', () => { if (!finished) fail(new Error('SMTP connection closed unexpectedly')); }); };
    const reply = () => new Promise((res) => { waiter = res; pump(); });
    const cmd = async (line, ok) => {
      sock.write(line + '\r\n'); const r = await reply();
      if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code} ${r.lines.join(' ').slice(0, 200)}`);
      return r;
    };
    const ready = (s, ev) => new Promise((res, rej) => { s.once(ev, res); s.once('error', rej); });

    (async () => {
      const first = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: isLoopback(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.rejectUnauthorized }) : net.connect({ host: cfg.host, port: cfg.port });
      attach(first); await ready(first, cfg.secure ? 'secureConnect' : 'connect');
      let r = await reply(); if (r.code !== 220) throw new Error(`SMTP greeting ${r.code} ${r.lines.join(' ').slice(0, 120)}`);
      const helo = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'orate';
      r = await cmd(`EHLO ${helo}`, [250]); let caps = r.lines.join('\n').toUpperCase();
      if (!cfg.secure && /\bSTARTTLS\b/.test(caps)) {
        await cmd('STARTTLS', [220]);
        first.removeListener('data', onData); first.removeAllListeners('error'); first.removeAllListeners('close'); buf = '';
        const up = tls.connect({ socket: first, servername: isLoopback(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.rejectUnauthorized });
        attach(up); await ready(up, 'secureConnect'); tlsOn = true;
        r = await cmd(`EHLO ${helo}`, [250]); caps = r.lines.join('\n').toUpperCase();
      }
      if (cfg.user) {
        if (!tlsOn && !isLoopback(cfg.host)) throw new Error('refusing to send SMTP credentials without TLS — use port 587 (STARTTLS) or SMTP_SECURE=true with port 465');
        if (/AUTH[ =][^\n]*\bPLAIN\b/.test(caps)) await cmd('AUTH PLAIN ' + Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64'), [235]);
        else if (/AUTH[ =][^\n]*\bLOGIN\b/.test(caps)) { await cmd('AUTH LOGIN', [334]); await cmd(Buffer.from(cfg.user).toString('base64'), [334]); await cmd(Buffer.from(cfg.pass).toString('base64'), [235]); }
        else throw new Error('the SMTP server offers no AUTH PLAIN / LOGIN');
      }
      if (authOnly) { try { sock.write('QUIT\r\n'); } catch { /* ignore */ } return; }
      await cmd(`MAIL FROM:<${cfg.from}>`, [250]);
      await cmd(`RCPT TO:<${addrOf(to)}>`, [250, 251]);
      await cmd('DATA', [354]);
      sock.write(data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..').replace(/\r\n$/, '') + '\r\n.\r\n');
      r = await reply(); if (r.code !== 250) throw new Error(`SMTP ${r.code} ${r.lines.join(' ').slice(0, 200)}`);
      try { sock.write('QUIT\r\n'); } catch { /* ignore */ }
    })().then(succeed, fail);
  });
}

/* ------------------------------------------------------------------ public */
/** Connects, upgrades to TLS and logs in — without sending anything. Resolves when the server accepted our settings, rejects with the reason. */
export async function checkSmtp() {
  const cfg = mailConfig(); if (!cfg) throw new Error('SMTP_HOST is not set in .env');
  await smtpSession(cfg, { to: cfg.from, data: '', authOnly: true });
  return cfg;
}

/** Sends an email through SMTP, or prints it to the console when no SMTP server is configured. Resolves with `{ mode }`. */
export async function sendMail({ to, subject, text, html }) {
  const cfg = mailConfig();
  if (!cfg) {
    const bar = '─'.repeat(64);
    console.log(`\n  ${bar}\n  ✉  Email for ${to}  (SMTP is not configured, so it is printed here instead)\n  Subject: ${subject}\n\n${String(text).split('\n').map((l) => '  ' + l).join('\n')}\n  ${bar}\n`);
    return { mode: 'console' };
  }
  await smtpSession(cfg, { to, data: buildMessage(cfg, { to, subject, text, html }) });
  return { mode: 'smtp' };
}
