// Orata email self-test (runs after the main self-test):  npm test
// Boots two scratch servers — A: SMTP configured (a fake SMTP server in this file), B: REQUIRE_EMAIL_VERIFICATION with no SMTP
// (dev mode: codes and links are printed to the console) — and walks the whole flow:
//   * sign-up needs the 6-digit code from the email (no account exists before that),
//   * wrong codes, lock-out, resend cooldown, mail failures surfaced to the person signing up,
//   * changing the address later sends a verification link, and in "required" mode unverified accounts are locked out.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(40); } return fn(); };

/* ---------------------------------------------------------------- a tiny fake SMTP server */
function fakeSmtp() {
  const mails = []; const logins = [];
  const server = net.createServer((sock) => {
    let buf = ''; let mode = 'cmd'; let from = ''; const to = [];
    const w = (s) => sock.write(s + '\r\n');
    w('220 fake.test ESMTP ready');
    sock.on('data', (c) => {
      buf += c.toString();
      for (;;) {
        if (mode === 'data') {
          const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return;
          mails.push({ from, to: [...to], raw: buf.slice(0, i) }); buf = buf.slice(i + 5); mode = 'cmd'; w('250 queued'); continue;
        }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write('250-fake.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (/^AUTH PLAIN /i.test(line)) { const [, u, p] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0'); logins.push({ u, p }); w('235 authenticated'); }
        else if (/^MAIL FROM:/i.test(line)) { from = /<([^>]*)>/.exec(line)?.[1] || ''; to.length = 0; w('250 ok'); }
        else if (/^RCPT TO:/i.test(line)) { const a = /<([^>]*)>/.exec(line)?.[1] || ''; if (/^reject@/i.test(a)) w('550 5.1.1 no such mailbox'); else { to.push(a); w('250 ok'); } }
        else if (/^DATA/i.test(line)) { mode = 'data'; w('354 end with <CRLF>.<CRLF>'); }
        else if (/^QUIT/i.test(line)) { w('221 bye'); sock.end(); }
        else w('250 ok');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, mails, logins, port: server.address().port })));
}
const decodeMail = (m) => {
  const part = /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(m.raw);
  const text = part ? Buffer.from(part[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : '';
  const subject = /Subject: (.*)/.exec(m.raw)?.[1] || '';
  return { text, subject, code: /^(\d{6}) is your Orata verification code/.exec(subject)?.[1], token: /\/verify\?token=([\w-]+)/.exec(text)?.[1], link: /(https?:\/\/\S+\/verify\?token=[\w-]+)/.exec(text)?.[1], headers: m.raw.split('\r\n\r\n')[0] };
};
const mailsTo = (smtp, addr) => smtp.mails.filter((m) => m.to[0] === addr);

/* ---------------------------------------------------------------- scratch servers */
function startServer(port, extraEnv) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orate-mail-test-'));
  const env = { ...process.env, PORT: String(port), ORATE_DATA: data, HOST: '127.0.0.1', DISCORD_BOT_TOKEN: '', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', PUBLIC_URL: '', DATABASE_URL: '', ...extraEnv };
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const srv = { child, out: '', base: `http://127.0.0.1:${port}`, port };
  child.stdout.on('data', (d) => { srv.out += d.toString(); });
  srv.api = async (method, url, token, body) => {
    const res = await fetch(srv.base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await res.json(); } catch { /* none */ }
    return { status: res.status, body: j };
  };
  srv.connect = (token) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`); const events = []; let closed = null;
    ws.on('open', () => ws.send(JSON.stringify({ op: 'identify', d: { token } })));
    ws.on('message', (raw) => { const m = JSON.parse(raw); events.push(m); if (m.op === 'ready') resolve({ ws, events, ready: m.d, closedCode: () => closed }); });
    ws.on('close', (code) => { closed = code; });
  });
  srv.ready = async () => { for (let i = 0; i < 60; i++) { try { await fetch(srv.base + '/api/config'); return; } catch { await sleep(100); } } };
  srv.stop = () => { child.kill(); try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* ignore */ } };
  return srv;
}
const PW = 'hunter2hunter2';
const regBody = (name, email) => ({ agree: true, email: email || `${name}@example.com`, username: name, displayName: name, password: PW, dob: { year: 1995, month: 5, day: 5 } });

async function main() {
  const smtp = await fakeSmtp();
  const A = startServer(3800 + Math.floor(Math.random() * 40), { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'smtpuser', SMTP_PASS: 'smtppass', MAIL_FROM: 'Orata <noreply@orate.test>', PUBLIC_URL: 'http://orate.test/' });
  const B = startServer(3850 + Math.floor(Math.random() * 40), { REQUIRE_EMAIL_VERIFICATION: 'true' });
  await Promise.all([A.ready(), B.ready()]);
  console.log('Email verification self-test (SMTP server on', A.port, '· dev-mode server on', B.port + ')');

  try {
    console.log('\nSign-up needs the emailed code (SMTP)');
    let r = await A.api('GET', '/config');
    ok(r.body.emailVerification?.enabled === true && r.body.emailVerification?.smtp === true, '/api/config advertises verification');
    r = await A.api('POST', '/auth/register', null, regBody('alice'));
    ok(r.status === 200 && r.body.verify === true && !!r.body.ticket && !r.body.token && r.body.email.includes('•'), 'the form returns a ticket instead of an account (email masked)');
    const ticketA = r.body.ticket;
    r = await A.api('POST', '/auth/login', null, { login: 'alice', password: PW });
    ok(r.status === 401, 'no account exists before the code is entered');
    const m1 = await until(() => mailsTo(smtp, 'alice@example.com')[0]); const d1 = m1 && decodeMail(m1);
    ok(!!m1 && /^\d{6}$/.test(d1.code || ''), 'a 6-digit code is emailed to the address (it is in the subject)');
    ok(d1?.text.includes(`${d1.code.slice(0, 3)} ${d1.code.slice(3)}`) && !d1.link, 'the body shows the code (no link)');
    ok(m1?.from === 'noreply@orate.test' && /From: Orata <noreply@orate\.test>/.test(d1?.headers || ''), 'sent from MAIL_FROM');
    ok(smtp.logins[0]?.u === 'smtpuser' && smtp.logins[0]?.p === 'smtppass', 'authenticated with SMTP_USER / SMTP_PASS');
    r = await A.api('POST', '/auth/register/confirm', null, { ticket: ticketA, code: d1.code === '000000' ? '111111' : '000000' });
    ok(r.status === 400 && r.body.code === 'code' && /4 tries left/.test(r.body.error), 'a wrong code is rejected and counted');
    r = await A.api('POST', '/auth/register/confirm', null, { ticket: ticketA, code: 'abc' });
    ok(r.status === 400 && r.body.code === 'code', 'a malformed code is rejected');
    r = await A.api('POST', '/auth/register/confirm', null, { ticket: 'not-a-ticket', code: d1.code });
    ok(r.status === 400 && r.body.code === 'code_expired', 'the code is useless without its ticket');
    r = await A.api('POST', '/auth/register/confirm', null, { ticket: ticketA, code: d1.code.slice(0, 3) + ' ' + d1.code.slice(3) });
    ok(r.status === 200 && !!r.body.token && r.body.user.username === 'alice' && r.body.user.emailVerified === true, 'the right code (spaces allowed) creates a verified account');
    const alice = r.body.token;
    r = await A.api('GET', '/ready', alice);
    ok(r.status === 200 && !r.body.gated && r.body.servers.length > 0, 'the new account gets the full app');
    r = await A.api('POST', '/auth/register/confirm', null, { ticket: ticketA, code: d1.code });
    ok(r.status === 400, 'a ticket can only be used once');
    r = await A.api('POST', '/auth/register', null, regBody('alice2', 'alice@example.com'));
    ok(r.status === 400 && r.body.code === 'email', 'an address that already has an account is refused');

    console.log('\nCooldown, lock-out and mail failures');
    r = await A.api('POST', '/auth/register', null, regBody('bob')); const ticketB = r.body.ticket;
    const mb1 = await until(() => mailsTo(smtp, 'bob@example.com')[0]); const db1 = mb1 && decodeMail(mb1);
    r = await A.api('POST', '/auth/register', null, regBody('bob'));
    ok(r.status === 429 && r.body.code === 'rate_limited', 'asking again for the same address right away is rate limited');
    r = await A.api('POST', '/auth/register/resend', null, { ticket: ticketB });
    ok(r.status === 429 && r.body.code === 'rate_limited', 'resend has a cooldown too');
    let last; for (let i = 0; i < 5; i++) last = await A.api('POST', '/auth/register/confirm', null, { ticket: ticketB, code: db1.code === '123456' ? '654321' : '123456' });
    ok(last.status === 400 && last.body.code === 'code_locked', 'five wrong codes lock the sign-up');
    r = await A.api('POST', '/auth/register/confirm', null, { ticket: ticketB, code: db1.code });
    ok(r.status === 400, 'even the right code no longer works after a lock-out');
    r = await A.api('POST', '/auth/register', null, regBody('bob'));
    ok(r.status === 200 && r.body.verify, 'starting over works');
    const mb2 = await until(() => mailsTo(smtp, 'bob@example.com')[1]); const db2 = mb2 && decodeMail(mb2);
    ok(!!db2 && /^\d{6}$/.test(db2.code), 'a new code is emailed');
    r = await A.api('POST', '/auth/register/confirm', null, { ticket: r.body.ticket, code: db2.code });
    ok(r.status === 200 && !!r.body.token, 'and it creates the account');
    const bob = r.body.token;
    r = await A.api('POST', '/auth/register', null, regBody('rejected', 'reject@example.com'));
    ok(r.status === 502 && r.body.code === 'mail_failed', 'if the mail server refuses the address the person is told (not silently ignored)');
    r = await A.api('POST', '/auth/login', null, { login: 'rejected', password: PW });
    ok(r.status === 401, '…and no account was created');

    console.log('\nChanging the address later (link)');
    r = await A.api('PATCH', '/me', bob, { email: 'bob2@example.com', password: PW });
    ok(r.status === 200 && r.body.emailVerified === false, 'changing the email makes the account unverified again');
    const l1 = await until(() => mailsTo(smtp, 'bob2@example.com')[0]); const dl1 = l1 && decodeMail(l1);
    ok(!!dl1?.token && dl1.link.startsWith('http://orate.test/verify?token=') && dl1.subject === 'Confirm your email for Orata', 'a verification link (built from PUBLIC_URL) goes to the new address');
    r = await A.api('GET', '/ready', bob);
    ok(r.status === 200 && !r.body.gated, 'optional mode: the account keeps working meanwhile');
    r = await A.api('PATCH', '/me', bob, { email: 'bob3@example.com', password: PW });
    const l2 = await until(() => mailsTo(smtp, 'bob3@example.com')[0]); const dl2 = l2 && decodeMail(l2);
    r = await A.api('POST', '/auth/verify-email', null, { token: dl1.token });
    ok(r.status === 400 && r.body.code === 'invalid_token', 'the link for the previous address no longer works');
    r = await A.api('POST', '/auth/verify-email', null, { token: 'nope' });
    ok(r.status === 400, 'a wrong token is rejected');
    r = await A.api('POST', '/auth/verify-email', null, { token: dl2.token });
    ok(r.status === 200 && r.body.ok, 'the newest link verifies the address');
    r = await A.api('GET', '/me', bob);
    ok(r.body.emailVerified === true, '/me reports emailVerified: true again');
    r = await A.api('POST', '/auth/verify-email', null, { token: dl2.token });
    ok(r.status === 400, 'a link can only be used once');
    r = await A.api('POST', '/auth/resend-verification', bob);
    ok(r.status === 400 && r.body.code === 'already_verified', 'verified accounts cannot ask for another link');

    console.log('\nDev mode (no SMTP: codes and links are printed to the console) with required verification');
    r = await B.api('GET', '/config');
    ok(r.body.emailVerification?.enabled && r.body.emailVerification?.required && !r.body.emailVerification?.smtp, '/api/config advertises dev mode');
    r = await B.api('POST', '/auth/register', null, regBody('carol'));
    ok(r.status === 200 && r.body.verify === true && r.body.mode === 'console', 'sign-up asks for a code (delivered via the console)');
    const ticketC = r.body.ticket;
    const codeOut = await until(() => /Subject: (\d{6}) is your Orata verification code/.exec(B.out));
    ok(!!codeOut && /SMTP is not configured/.test(B.out) && /carol@example\.com/.test(B.out), 'the code is printed in the server console');
    r = await B.api('POST', '/auth/register/confirm', null, { ticket: ticketC, code: codeOut[1] });
    ok(r.status === 200 && r.body.user.emailVerified === true, 'the printed code creates the account');
    const carol = r.body.token;
    const live = await B.connect(carol);
    ok(!live.ready.gated && live.ready.servers.length === 1, 'the new account gets the full app');
    r = await B.api('PATCH', '/me', carol, { email: 'carol2@example.com', password: PW });
    ok(r.status === 200 && r.body.emailVerified === false, 'changing the address in required mode makes the account unverified');
    await until(() => live.closedCode() === 4011, 3000);
    ok(live.closedCode() === 4011, 'its open socket is dropped so the client reconnects onto the verify screen');
    r = await B.api('GET', '/ready', carol);
    ok(r.status === 200 && r.body.gated === true && r.body.servers.length === 0 && r.body.dms.length === 0, 'unverified accounts get an empty app');
    r = await B.api('POST', '/channels/1/messages', carol, { content: 'hi' });
    ok(r.status === 403 && r.body.code === 'email_unverified', 'everything else is refused with email_unverified');
    r = await B.api('GET', '/me', carol);
    ok(r.status === 200 && r.body.emailVerified === false, '…except /me, so the app can show the verify screen');
    const gws = await B.connect(carol);
    ok(gws.ready.gated === true && gws.ready.servers.length === 0, 'the gateway sends gated users an empty world');
    gws.ws.send(JSON.stringify({ op: 'voice_join', d: { channelId: '1' } })); await sleep(250);
    ok(!gws.events.some((e) => e.op === 'voice_joined' || e.op === 'error'), 'a gated socket cannot do anything');
    const linkOut = await until(() => { const all = [...B.out.matchAll(/\/verify\?token=([\w-]+)/g)]; return all.at(-1); });
    r = await B.api('POST', '/auth/verify-email', null, { token: linkOut[1] });
    ok(r.status === 200, 'the console link verifies the new address');
    await until(() => gws.closedCode() === 4010, 3000);
    ok(gws.closedCode() === 4010, 'the gated socket is closed so the client reconnects with the full app');
    const full = await B.connect(carol);
    ok(!full.ready.gated && full.ready.servers.length === 1 && full.ready.user.emailVerified === true, 'after verifying, the gateway delivers the real app');
    r = await B.api('GET', '/ready', carol);
    const ch = r.body.servers[0].channels.find((c) => c.type === 'text');
    r = await B.api('POST', `/channels/${ch.id}/messages`, carol, { content: 'hello' });
    ok(r.status === 200, 'verified users can send messages');
    full.ws.close(); gws.ws.close(); live.ws.close();
  } finally {
    A.stop(); B.stop(); smtp.server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
