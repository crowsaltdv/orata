// Orata — HTTP + WebSocket server.   Run with:  npm start
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { ROOT, UPLOAD_DIR, ENV, ensureBot, db, pg, restoreUpload, storageSummary, BUILD } from './core.js';
import { discordOn } from './discord.js';
import { createApi, turnConfigured } from './api.js';
import { attachGateway } from './gateway.js';
import './bot.js';
import { mailConfig } from './mail.js';
import { verificationMode } from './verify.js';
import { musicStatus } from './music.js';

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
      "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com",   // 'self': the about:blank cloak opens Orata in a frame
      "worker-src 'self' blob:",
      "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    ].join('; '),
  });
  next();
});

app.use('/api', createApi());

// Uploaded files: only well-known media renders inline; everything else downloads. CSP sandbox keeps stray HTML inert.
const INLINE = /\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm|mov|m4v|mp3|ogg|oga|wav|m4a|flac|opus|pdf|txt|woff2?|ttf|otf)$/i;   // (fonts: as fonts, for uploaded ones in Settings → Fonts and themes)
// with Postgres the disk is only a cache: fetch a file back from the database if a restart wiped it
app.use('/uploads', (req, res, next) => {
  if (!pg) return next();
  let name; try { name = decodeURIComponent(req.path.replace(/^\//, '')); } catch { return next(); }
  restoreUpload(name).then(() => next(), (e) => { console.error('[orata] could not load an upload from the database:', e.message); next(); });
});
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false, dotfiles: 'deny', maxAge: '30d', immutable: true,
  setHeaders(res, file) {
    res.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    if (!INLINE.test(file)) res.set({ 'Content-Disposition': 'attachment', 'Content-Type': 'application/octet-stream' });
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

// Lite mode's lighter pictures (public/js/lite.js): an uploaded image 96, 256 or 480 pixels wide as WebP (a GIF's first frame), made once and kept
const THUMB_W = new Set([96, 256, 480]); const THUMBS = path.join(os.tmpdir(), 'orata-thumbs');
app.get('/thumbs/:w/:name', async (req, res) => {
  const w = Number(req.params.w); const name = String(req.params.name);
  if (!THUMB_W.has(w) || !/^[A-Za-z0-9_.-]{1,120}\.(png|jpe?g|gif|webp|avif)$/i.test(name)) return res.status(404).end();
  const out = path.join(THUMBS, `${w}-${name}.a.webp`);   // .a: animated GIFs keep their frames (older copies were stills)
  try {
    if (!fs.existsSync(out)) {
      if (pg) await restoreUpload(name);   // with Postgres the disk is only a cache
      const src = path.join(UPLOAD_DIR, name); if (!fs.existsSync(src)) return res.status(404).end();
      fs.mkdirSync(THUMBS, { recursive: true });
      const make = (animated) => sharp(src, { animated, limitInputPixels: 50_000_000 }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 55 }).toFile(out);
      await make(true).catch(() => make(false));   // a GIF with too many frames to redo stays a still
    }
    res.set({ 'Cache-Control': 'public, max-age=2592000, immutable', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cross-Origin-Resource-Policy': 'cross-origin' }).type('image/webp').sendFile(out);
  } catch { res.status(404).end(); }
});

app.use(express.static(path.join(ROOT, 'public'), {
  index: false, extensions: ['html'],   // /terms, /privacy and /guidelines are plain pages (public/*.html)
  setHeaders(res, file) {
    if (/\.(html|js|css)$/.test(file)) res.set('Cache-Control', 'no-cache');
    else if (/\.(png|jpg|webp|svg|json|woff2?)$/.test(file)) res.set('Cache-Control', 'public, max-age=86400');
  },
}));
// the page, with every module it loads at start (found once from boot.js's imports) as <link rel="modulepreload">: the browser fetches them
// all at once instead of one level of imports at a time
const INDEX_HTML = (() => {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return; seen.add(f); let src = '';
    try { src = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'); } catch { return; }
    for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?from\s+)?['"](\/(?:js|vendor)\/[^'"]+)['"]/gm)) walk(m[1]);
  };
  walk('/js/boot.js');
  return fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replace('</head>', `  <meta name="orata-build" content="${BUILD}" />\n${[...seen].map((f) => `  <link rel="modulepreload" href="${f}" />`).join('\n')}\n</head>`);
})();
// SPA fallback (client-side routes: /channels/…, /invite/…, /login …)
app.get('*', (req, res, next) => {
  if (/^\/(api|uploads|gateway|thumbs)\b/.test(req.path)) return next();
  res.set('Cache-Control', 'no-cache').type('html').send(INDEX_HTML);
});

const useTls = ENV.HTTPS_KEY && ENV.HTTPS_CERT;
const server = useTls ? https.createServer({ key: fs.readFileSync(ENV.HTTPS_KEY), cert: fs.readFileSync(ENV.HTTPS_CERT) }, app) : http.createServer(app);
attachGateway(server);
ensureBot();

const PORT = Number(ENV.PORT || 3000);
const HOST = ENV.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\n  ▲ Orata is running\n`);
  const proto = useTls ? 'https' : 'http';
  console.log(`    Local:   ${proto}://localhost:${PORT}`);
  for (const ip of lan) console.log(`    Network: ${proto}://${ip}:${PORT}`);
  if (!useTls && lan.length) console.log('    (voice/video/notifications on other devices need HTTPS — see README)');
  console.log(`\n    ${Object.values(db.users).filter((u) => !u.bot).length} user(s) · GIFs ${ENV.KLIPY_API_KEY ? 'enabled' : 'disabled (set KLIPY_API_KEY in .env)'}`);
  console.log(`    Storage: ${storageSummary()}`);
  console.log(`    Discord bridge: ${discordOn ? 'on — /link in a channel (Orbit) links it with a Discord channel' : 'off (set DISCORD_BOT_TOKEN in .env, see README → "Discord bridge")'}`);
  console.log(`    Voice relay (TURN): ${turnConfigured() ? 'on — calls connect even across strict networks' : 'OFF — people on school or work Wi-Fi may not hear each other; add CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN (free) or TURN_URLS to .env, see README → "TURN relay"'}`);
  musicStatus().then((s) => console.log(`    Music: ${s}\n`));   // starts the music helper now, so a missing Python or library shows up in this log
  const vm = verificationMode(); const mc = mailConfig();
  console.log(`    Email verification: ${vm.enabled ? (mc ? `ON — sign-up needs a code emailed via ${mc.host}:${mc.port}` : 'ON (dev mode) — no SMTP_HOST, so sign-up codes are printed in this console') : 'OFF — add SMTP_HOST to .env to require an emailed code at sign-up (see README)'}\n`);
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT in .env.` : e); process.exit(1); });
