// Orate — HTTP + WebSocket server.   Run with:  npm start
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ROOT, UPLOAD_DIR, ENV, ensureBot, db, pg, restoreUpload, storageSummary } from './core.js';
import { createApi } from './api.js';
import { attachGateway } from './gateway.js';
import './bot.js';
import { mailConfig } from './mail.js';
import { verificationMode } from './verify.js';

const app = express();
app.disable('x-powered-by');
if (ENV.TRUST_PROXY) app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src * data: blob:",
      "media-src * data: blob:",
      "connect-src 'self' ws: wss: blob: data:",
      "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
      "worker-src 'self' blob:",
      "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    ].join('; '),
  });
  next();
});

app.use('/api', createApi());

// Uploaded files: only well-known media renders inline; everything else downloads. CSP sandbox keeps stray HTML inert.
const INLINE = /\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm|mov|m4v|mp3|ogg|oga|wav|m4a|flac|opus|pdf|txt)$/i;
// with Postgres the disk is only a cache: fetch a file back from the database if a restart wiped it
app.use('/uploads', (req, res, next) => {
  if (!pg) return next();
  let name; try { name = decodeURIComponent(req.path.replace(/^\//, '')); } catch { return next(); }
  restoreUpload(name).then(() => next(), (e) => { console.error('[orate] could not load an upload from the database:', e.message); next(); });
});
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false, dotfiles: 'deny', maxAge: '30d', immutable: true,
  setHeaders(res, file) {
    res.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    if (!INLINE.test(file)) res.set({ 'Content-Disposition': 'attachment', 'Content-Type': 'application/octet-stream' });
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

app.use(express.static(path.join(ROOT, 'public'), {
  index: false,
  setHeaders(res, file) {
    if (/\.(html|js|css)$/.test(file)) res.set('Cache-Control', 'no-cache');
    else if (/\.(png|jpg|webp|svg|json|woff2?)$/.test(file)) res.set('Cache-Control', 'public, max-age=86400');
  },
}));
// SPA fallback (client-side routes: /channels/…, /invite/…, /login …)
app.get('*', (req, res, next) => {
  if (/^\/(api|uploads|gateway)\b/.test(req.path)) return next();
  res.set('Cache-Control', 'no-cache').sendFile(path.join(ROOT, 'public', 'index.html'));
});

const useTls = ENV.HTTPS_KEY && ENV.HTTPS_CERT;
const server = useTls ? https.createServer({ key: fs.readFileSync(ENV.HTTPS_KEY), cert: fs.readFileSync(ENV.HTTPS_CERT) }, app) : http.createServer(app);
attachGateway(server);
ensureBot();

const PORT = Number(ENV.PORT || 3000);
const HOST = ENV.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\n  ▲ Orate is running\n`);
  const proto = useTls ? 'https' : 'http';
  console.log(`    Local:   ${proto}://localhost:${PORT}`);
  for (const ip of lan) console.log(`    Network: ${proto}://${ip}:${PORT}`);
  if (!useTls && lan.length) console.log('    (voice/video/notifications on other devices need HTTPS — see README)');
  console.log(`\n    ${Object.values(db.users).filter((u) => !u.bot).length} user(s) · GIFs ${ENV.KLIPY_API_KEY ? 'enabled' : 'disabled (set KLIPY_API_KEY in .env)'}`);
  console.log(`    Storage: ${storageSummary()}`);
  const vm = verificationMode(); const mc = mailConfig();
  console.log(`    Email verification: ${vm.enabled ? (mc ? `ON — sign-up needs a code emailed via ${mc.host}:${mc.port}` : 'ON (dev mode) — no SMTP_HOST, so sign-up codes are printed in this console') : 'OFF — add SMTP_HOST to .env to require an emailed code at sign-up (see README)'}\n`);
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT in .env.` : e); process.exit(1); });
