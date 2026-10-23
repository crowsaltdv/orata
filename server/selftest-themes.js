// Orata self-test for the theme library and Discovery:  npm test
// The library (25 profile + 25 site themes per account, enforced here), everything a site / profile theme keeps, pictures that keep working, the
// preview pictures, sending a theme (anyone; Orata staff approve or turn it away; the old Creator badge is gone) and removing, installing from Discovery, upvotes and Featured sorting, and the sweep of theme files nobody uses.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orata-themes-test-'));
const PORT = 3500 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rot13 = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));   // so this file has no swear words in it

let child = null;
function startServer(extra = {}) {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', DISCORD_BOT_TOKEN: '', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', KLIPY_API_KEY: '', MUSIC: '', ACCOUNTS_PER_BROWSER: '1000', ACCOUNTS_PER_HOUR: '1000', TRUST_PROXY: '1', THEME_SWEEP_FIRST_MS: '3600000', THEME_TEST_FETCH_ANY: '1', ...extra },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
async function ready() { for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/config'); return; } catch { await sleep(100); } } }
async function stopServer() { if (!child) return; await sleep(900); const c = child; child = null; const done = new Promise((r) => c.once('exit', r)); c.kill('SIGINT'); await Promise.race([done, sleep(3000)]); }
async function api(method, url, token, body, headers = {}) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: j };
}
/** Sends picture (or any) bytes: to /upload as a normal upload, or as a theme preview. */
async function sendBytes(method, url, token, bytes, type = 'image/png', name = 'pic.png') {
  const res = await fetch(base + '/api' + url, { method, headers: { 'content-type': type, 'x-filename': name, authorization: 'Bearer ' + token }, body: bytes });
  let j = null; try { j = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: j };
}
let ip = 10;   // each sign-up from its own address: sign-ups are limited per address
const register = async (username) => {
  const r = await api('POST', '/auth/register', null, { agree: true, username, displayName: username[0].toUpperCase() + username.slice(1), password: 'password123', dob: { year: 1995, month: 1, day: 1 } }, { 'x-forwarded-for': `198.51.100.${ip++}` });
  return { token: r.body?.token, user: r.body?.user };
};
/** A two-frame GIF (it moves), as bytes: 1 × 1 pixel, black then white. */
const animatedGif = () => {
  const frame = (px) => Buffer.from([0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, px === 0 ? 0x44 : 0x4C, 0x01, 0x00]);
  return Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]), Buffer.from([0x21, 0xFF, 0x0B]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]), frame(0), frame(1), Buffer.from([0x3B])]);
};
const png = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const upload = async (tok, bytes, type = 'image/png', name = 'pic.png') => (await sendBytes('POST', '/upload', tok, bytes, type, name)).body?.url;
const fetchOk = async (url) => (await fetch(base + url)).status === 200;
function connect(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`); const events = []; const waiters = [];
    ws.on('open', () => ws.send(JSON.stringify({ op: 'identify', d: { token } })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw); events.push(m);
      for (const w of [...waiters]) if (w.op === m.op) { waiters.splice(waiters.indexOf(w), 1); w.res(m.d); }
      if (m.op === 'ready' || m.op === 'invalid_session') resolve({ ws, wait: (op, ms = 3000) => new Promise((res, rej) => { const f = events.find((e) => e.op === op); if (f) return res(f.d); waiters.push({ op, res }); setTimeout(() => rej(new Error('timeout waiting for ' + op)), ms); }) });
    });
  });
}

/** A site look as the settings screens make it: every section, with a few things changed from the defaults. */
const siteLook = (over = {}) => ({
  theme: { mode: 'dark', accentType: 'gradient', accent: '#FF00AA', accent2: '#00ffcc', panelType: 'gradient', panelColor: '#112233', panelColor2: '#332211', panelAngle: 200, panelOpacity: 0.4, panelBlur: 25, radius: 22, gap: 6, textColor: '#eeeeee', saturation: 1.3 },
  bg: { type: 'mesh', mesh: 'ocean', image: null, photo: 'photo-2', color: '#0b0a14', gradient: { c1: '#1e1b4b', c2: '#7c3aed', angle: 90 }, blur: 4, dim: 0.35, brightness: 1.2, saturate: 0.9, posX: 30, posY: 70, zoom: 1.4, parallax: false, library: ['/uploads/mine.png'] },
  rain: { enabled: true, preset: 'storm', amount: 0.5, size: 1.1, speed: 1.5, refraction: 1.2, mist: 9, trails: 2, droplets: 80, lightning: 0.1, fps: 30 },
  glass: { style: 'liquid', intensity: 0.7, rail: true, nav: false, toolbar: true, buttons: false, composer: true, panels: true },
  fx: { particles: false, ripples: true, amount: 1.5 },
  fonts: { ui: 'Poppins', chat: 'Lora', code: 'Fira Code', size: 18, weight: 500, lineHeight: 1.6, letterSpacing: 0.02 },
  motion: { reduce: true, speed: 1.5, parallaxHover: false },
  chat: { compact: false, hour24: true, linkPreviews: false, inlineMedia: false, jumbo: false, showAvatars: false, spacing: 8, gifAutoplay: false, spoilerOnHover: true },
  access: { highContrast: true }, lang: 'fr',
  ...over,
});
const profileLook = (over = {}) => ({
  colors: { mode: 'gradient', a: '#8b5cf6', b: '#ec4899', angle: 120, tint: 0.5 }, outline: { color: '#ffffff', color2: '#ff0000', width: 3, style: 'solid' },
  shadow: { color: '#8b5cf6', blur: 40, spread: 4, x: 2, y: 6, alpha: 0.6 }, fonts: { name: 'pacifico', text: 'lora' },
  nameColor: { mode: 'gradient', a: '#fde047', b: '#22c55e', angle: 45 }, nameOutline: { mode: 'solid', a: '#14532d', b: '#14532d', angle: 90, width: 2 }, nameShadow: { color: '#000000', angle: 90, distance: 5, blur: 2 },
  effect: { id: 'aurora', color: '#34d399', color2: '#a78bfa', density: 0.7, speed: 1.2, opacity: 0.9 },
  ...over,
});

async function main() {
  startServer(); await ready();
  console.log('Orata themes test on port', PORT);

  const A = await register('alice'); const X = await register('xavier'); const S = await register('stella'); const C = await register('cora'); const D = await register('dan'); const N = await register('nora'); const E = await register('erin');
  await stopServer();   // alice is a founder (oratedev), xavier a developer, stella staff
  const j = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8'));
  j.users[A.user.id].username = 'oratedev'; j.users[A.user.id].badges = ['dev']; j.users[X.user.id].badges = ['dev']; j.users[S.user.id].badges = ['staff'];
  j.users[C.user.id].badges = ['creator', 'early'];   // the old Creator badge: taken off at start
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(j)); startServer(); await ready();

  /* ---------------------------------------------------------------- the Creator badge is gone */
  console.log('\nNo more Creator badge');
  let r = await api('GET', '/badges', N.token); ok(r.status === 200 && !r.body.some((b) => b.id === 'creator'), 'the Creator badge is gone');
  r = await api('GET', `/users/${C.user.id}`, N.token); const cb = (r.body.user || r.body).badges || [];
  ok(!cb.some((b) => b.id === 'creator') && cb.some((b) => b.id === 'early'), '… taken off everyone who had it (their other badges stay)');
  r = await api('PUT', `/users/${D.user.id}/badges`, X.token, { badges: ['creator'] }); ok(r.status === 200 && !r.body.badges.some((b) => b.id === 'creator'), '… and it can’t be given any more');
  const approve = (id) => api('POST', `/themes/discover/${id}/review`, S.token, { approve: true });

  /* ---------------------------------------------------------------- the library */
  console.log('\nThe library');
  r = await api('GET', '/themes/library', N.token); ok(r.status === 200 && r.body.limit === 25 && r.body.themes.length === 0, 'a new account has an empty library, with room for 25 of each kind');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Night Sky', data: siteLook() }); const T1 = r.body;
  ok(r.status === 200 && T1.kind === 'site' && T1.name === 'Night Sky' && !T1.preview && !T1.from && !T1.published, 'a site theme can be saved');
  const d = T1.data;
  ok(d.theme.accent === '#ff00aa' && d.theme.panelType === 'gradient' && d.theme.panelColor2 === '#332211' && d.theme.radius === 22 && d.theme.textColor === '#eeeeee', 'it keeps the theme colours (accent, panels, radius, text)');
  ok(d.bg.type === 'mesh' && d.bg.mesh === 'ocean' && d.bg.blur === 4 && d.bg.dim === 0.35 && d.bg.zoom === 1.4 && d.bg.posX === 30 && d.bg.parallax === false, 'the wallpaper and its blur, dim, zoom and position');
  ok(d.rain.preset === 'storm' && d.rain.droplets === 80 && d.rain.fps === 30 && d.glass.style === 'liquid' && d.glass.intensity === 0.7 && d.glass.nav === false && d.glass.buttons === false, 'rain on glass and liquid glass, with every switch');
  ok(d.fx.particles === false && d.fx.amount === 1.5 && d.fonts.ui === 'Poppins' && d.fonts.chat === 'Lora' && d.fonts.code === 'Fira Code' && d.fonts.size === 18 && d.fonts.letterSpacing === 0.02, 'the button effects and every font setting');
  ok(d.motion.speed === 1.5 && d.motion.parallaxHover === false && d.chat.compact === false && d.chat.showAvatars === false && d.chat.spacing === 8 && d.chat.jumbo === false, 'the animation speed and how chat looks');
  ok(!('reduce' in d.motion) && !('library' in d.bg) && !d.access && !d.lang && !('hour24' in d.chat) && !('linkPreviews' in d.chat), 'but nothing personal: not Reduce motion, saved wallpapers, accessibility, language or what chat fetches');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Messy', data: { theme: { accent: 'red', radius: 9999, mode: 'neon' }, bg: { zoom: 'big', dim: 5 }, nope: { a: 1 } } });
  ok(r.status === 200 && r.body.data.theme.accent === '#64748b' && r.body.data.theme.radius === 36 && r.body.data.theme.mode === 'dark' && r.body.data.bg.dim === 0.9 && r.body.data.bg.zoom === 1 && !r.body.data.nope, 'a theme is checked: bad values are dropped, numbers clamped, and a saved theme is always complete (the rest are Orata’s defaults)');
  await api('DELETE', `/themes/library/${r.body.id}`, N.token);
  r = await api('POST', '/themes/library', N.token, { kind: 'site', data: {} }); ok(r.status === 400, 'an empty theme can’t be saved');
  r = await api('POST', '/themes/library', N.token, { kind: 'banana', data: siteLook() }); ok(r.status === 400, 'a theme is a profile theme or a site theme');
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', name: 'Aurora Card', data: profileLook() }); const P1 = r.body;
  ok(r.status === 200 && P1.kind === 'profile', 'a profile theme can be saved');
  ok(P1.data.colors.tint === 0.5 && P1.data.outline.color2 === '#ff0000' && P1.data.shadow.blur === 40 && P1.data.fonts.name === 'pacifico' && P1.data.nameColor.b === '#22c55e' && P1.data.nameOutline.width === 2 && P1.data.nameShadow.distance === 5 && P1.data.effect.id === 'aurora' && P1.data.effect.speed === 1.2,
    'it keeps the colours, outline, shadow, fonts, name colour / outline / shadow and effect');
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', data: { effect: { id: 'not-an-effect' }, junk: 1 } }); ok(r.status === 400, 'a profile theme with nothing valid in it is refused');
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', name: '   ', data: profileLook({ effect: { id: 'snow' } }) }); const P2 = r.body;
  ok(r.status === 200 && P2.name === 'My profile theme', 'a theme without a name gets one');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: `  ${'x'.repeat(80)}\n`, data: siteLook() }); ok(r.body.name.length === 40, 'names are cut to 40 characters');
  const long = r.body.id;
  r = await api('PATCH', `/themes/library/${T1.id}`, N.token, { name: ' Midnight Rain ' }); ok(r.status === 200 && r.body.name === 'Midnight Rain', 'a theme can be renamed');
  r = await api('PATCH', `/themes/library/${T1.id}`, N.token, { name: '  ' }); ok(r.status === 400, '… but not to nothing');
  r = await api('PATCH', `/themes/library/${T1.id}`, C.token, { name: 'Mine now' }); ok(r.status === 404, 'nobody else can rename it');
  r = await api('DELETE', `/themes/library/${T1.id}`, C.token); ok(r.status === 404, '… or delete it');
  r = await api('GET', '/themes/library', C.token); ok(r.body.themes.length === 0, '… or see it: the library is private');
  r = await api('DELETE', `/themes/library/${long}`, N.token); ok(r.status === 200, 'a theme can be deleted');
  r = await api('GET', '/themes/library', N.token); ok(r.body.themes.length === 3 && r.body.themes.map((t) => t.name).includes('Midnight Rain'), 'the library lists what is left, with each theme’s data');
  r = await api('GET', '/themes/library', null); ok(r.status === 401, 'you have to be signed in');

  /* ---------------------------------------------------------------- the 25 + 25 limit */
  console.log('\nThe limit: 25 profile + 25 site themes');
  const M = await register('mona'); let made = 0;
  for (let i = 0; i < 25; i++) { r = await api('POST', '/themes/library', M.token, { kind: 'profile', name: `P${i}`, data: profileLook({ effect: { id: 'snow', density: 0.1 + i / 100 } }) }); if (r.status === 200) made++; }
  ok(made === 25, '25 profile themes fit');
  r = await api('POST', '/themes/library', M.token, { kind: 'profile', name: 'One too many', data: profileLook() }); ok(r.status === 400 && r.body.code === 'library_full' && /25 of 25/.test(r.body.error), 'the 26th is refused, and the message says why');
  made = 0; let lastSite = null;
  for (let i = 0; i < 25; i++) { r = await api('POST', '/themes/library', M.token, { kind: 'site', name: `S${i}`, data: siteLook({ theme: { ...siteLook().theme, radius: i } }) }); if (r.status === 200) { made++; lastSite = r.body; } }
  ok(made === 25, 'the profile limit doesn’t use up the site themes: 25 of those fit as well');
  r = await api('POST', '/themes/library', M.token, { kind: 'site', name: 'One too many', data: siteLook() }); ok(r.status === 400 && r.body.code === 'library_full', 'the 26th site theme is refused too');
  r = await api('GET', '/themes/library', M.token); ok(r.body.themes.length === 50, '50 in all');
  await api('DELETE', `/themes/library/${lastSite.id}`, M.token);
  r = await api('POST', '/themes/library', M.token, { kind: 'site', name: 'Room again', data: siteLook() }); ok(r.status === 200, 'deleting one makes room');

  /* ---------------------------------------------------------------- pictures */
  console.log('\nPictures in themes');
  const wall = await upload(N.token, await png(120, 80, '#336699'));
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Photo', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: wall } }) }); const T2 = r.body;
  const copy = T2.data?.bg?.image;
  ok(r.status === 200 && /^\/uploads\/th_\d+\.png$/.test(copy) && copy !== wall && T2.data.bg.type === 'image', 'a theme with your own wallpaper gets a copy of the picture that belongs to the theme', `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  ok(await fetchOk(copy) && Buffer.compare(Buffer.from(await (await fetch(base + copy)).arrayBuffer()), Buffer.from(await (await fetch(base + wall)).arrayBuffer())) === 0, '… which is the same picture');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Photo again', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: wall } }) });
  ok(r.body.data.bg.image === copy, 'saving the same wallpaper in more themes reuses the one copy');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Photo (copy)', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: copy } }) });
  ok(r.body.data.bg.image === copy, 'a wallpaper that already is a theme picture is not copied again');
  const card = await upload(N.token, await png(60, 80, '#aa3366'));
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', name: 'Picture card', data: profileLook({ colors: { mode: 'image', a: '#8b5cf6', b: '#ec4899', angle: 150, tint: 0.4, image: card, imageOpacity: 0.7 } }) }); const P3 = r.body;
  ok(r.status === 200 && /^\/uploads\/th_\d+\.png$/.test(P3.data.colors.image) && P3.data.colors.mode === 'image' && P3.data.colors.imageOpacity === 0.7 && await fetchOk(P3.data.colors.image), 'a profile theme with a card picture keeps it the same way');
  const huge = await upload(N.token, await sharp({ create: { width: 3600, height: 2000, channels: 3, background: '#445566' } }).png().toBuffer());
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Huge', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: huge } }) });
  const hugeMeta = r.status === 200 ? await sharp(Buffer.from(await (await fetch(base + r.body.data.bg.image)).arrayBuffer())).metadata() : {};
  ok(r.status === 200 && hugeMeta.width === 2560 && hugeMeta.format === 'webp', 'a very large wallpaper is kept at screen size (2560 wide, WebP)');
  const fake = await upload(N.token, Buffer.from('<script>alert(1)</script> not a picture'), 'image/png', 'evil.png');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Fake', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: fake } }) }); ok(r.status === 400 && r.body.code === 'picture_bad', 'a file that isn’t a picture is refused, whatever it is called');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Gone', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: '/uploads/9999999999999999.png' } }) }); ok(r.status === 400 && r.body.code === 'picture_missing', 'a picture that no longer exists is refused with a clear message');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Web', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: 'https://example.com/a.jpg' } }) }); ok(r.status === 200 && r.body.data.bg.image === 'https://example.com/a.jpg', 'a wallpaper from a web link stays a link');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Sneaky', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: '/uploads/../../etc/passwd' } }) }); ok(r.status === 200 && r.body.data.bg.image !== '/uploads/../../etc/passwd', 'a path that tries to leave the uploads folder never gets through');

  /* ---------------------------------------------------------------- previews */
  /* banners, GIFs and web-link wallpapers */
  console.log('\nBanners, GIFs and wallpapers from a link');
  const gifBytes = animatedGif(); const pagesOf = async (url) => (await sharp(Buffer.from(await (await fetch(base + url)).arrayBuffer()), { animated: true }).metadata()).pages;
  const bannerUp = await upload(N.token, await png(90, 30, '#3366aa'));
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', name: 'With banner', data: profileLook({ banner: { image: bannerUp, color: '#112233', color2: '#445566' } }) }); const BT = r.body;
  ok(r.status === 200 && /^\/uploads\/th_\d+\.png$/.test(BT.data.banner?.image) && BT.data.banner.image !== bannerUp && BT.data.banner.color === '#112233' && BT.data.banner.color2 === '#445566' && await fetchOk(BT.data.banner.image), 'a profile theme keeps the banner picture (as a file of its own) and the banner colours');
  ok(BT.data.colors.mode === 'gradient' && BT.data.effect.id === 'aurora', '… along with the rest of the profile style');
  const gifUp = await upload(N.token, gifBytes, 'image/gif', 'moving.gif');
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', name: 'GIF banner and card', data: profileLook({ colors: { mode: 'image', a: '#8b5cf6', b: '#ec4899', angle: 150, tint: 0.4, image: gifUp, imageOpacity: 0.7 }, banner: { image: gifUp } }) }); const GT = r.body;
  ok(r.status === 200 && /^\/uploads\/th_\d+\.gif$/.test(GT.data.banner.image) && /^\/uploads\/th_\d+\.gif$/.test(GT.data.colors.image) && GT.data.banner.image === GT.data.colors.image, 'a GIF banner and a GIF card picture are kept as GIFs (one copy for the same GIF)');
  ok(await pagesOf(GT.data.banner.image) === 2, '… and they still move (the copy has both frames)');
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', name: 'Banner only', data: { banner: { image: bannerUp } } }); ok(r.status === 200 && r.body.data.banner.image && !r.body.data.colors, 'a theme can be just a banner');
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', name: 'Nothing', data: { banner: { image: null, color: null, color2: null } } }); ok(r.status === 400, 'an empty banner is nothing to save');
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', name: 'Bad banner path', data: profileLook({ banner: { image: '/uploads/../../etc/passwd', color: '#112233' } }) }); ok(r.status === 200 && r.body.data.banner.image === null && r.body.data.banner.color === '#112233', 'a banner picture from anywhere but the uploads is dropped, its colours stay');
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', name: 'No banner', data: profileLook() }); ok(r.status === 200 && !('banner' in r.body.data), 'a theme saved without a banner has none (applying it leaves yours alone)');
  r = await api('POST', '/themes/library', N.token, { kind: 'profile', name: 'Fake banner', data: profileLook({ banner: { image: fake } }) }); ok(r.status === 400 && r.body.code === 'picture_bad', 'a banner that isn’t a picture is refused');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'GIF wallpaper', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: gifUp } }) });
  ok(r.status === 200 && /^\/uploads\/th_\d+\.gif$/.test(r.body.data.bg.image) && await pagesOf(r.body.data.bg.image) === 2, 'a GIF wallpaper is kept as a GIF that moves');
  // an uploaded font: a theme keeps its own copy, served as a font; something that only calls itself a font is refused
  const ttf = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(60, 7)]);
  const fontUrl = await upload(N.token, ttf, 'font/ttf', 'My Font.ttf');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Own Font', data: siteLook({ fonts: { ...siteLook().fonts, ui: fontUrl, chat: 'Lora' } }) });
  const fontRes = r.status === 200 && await fetch(base + r.body.data.fonts.ui);
  ok(r.status === 200 && /^\/uploads\/th_\d+\.ttf$/.test(r.body.data.fonts.ui) && r.body.data.fonts.ui !== fontUrl && r.body.data.fonts.chat === 'Lora' && fontRes.status === 200 && /^font\/ttf/.test(fontRes.headers.get('content-type') || ''), 'a theme with an uploaded font gets its own copy of the font, served as a font', JSON.stringify(r.body?.data?.fonts || r.body));
  const OWNFONT = r.body; await api('DELETE', `/themes/library/${OWNFONT.id}`, N.token);
  const fakeFont = await upload(N.token, await png(30, 30, '#123456'), 'font/woff2', 'sneaky.woff2');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Fake Font', data: siteLook({ fonts: { ...siteLook().fonts, ui: fakeFont } }) }); ok(r.status === 400 && r.body.code === 'font_bad', 'a picture renamed to .woff2 isn’t a font');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Far Font', data: siteLook({ fonts: { ...siteLook().fonts, ui: 'https://evil.example/x.woff2' } }) }); ok(r.status === 200 && r.body.data.fonts.ui !== 'https://evil.example/x.woff2', 'a font from another website isn’t taken');
  if (r.status === 200) await api('DELETE', `/themes/library/${r.body.id}`, N.token);
  const biggish = await upload(N.token, Buffer.concat([gifBytes, Buffer.alloc(16 * 1024 * 1024)]), 'image/gif', 'huge.gif');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Too big GIF', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: biggish } }) }); ok(r.status === 400 && r.body.code === 'picture_big' && /15 MB/.test(r.body.error), 'a GIF over 15 MB is refused, and the message says the limit');
  // a wallpaper that is a web link is fetched and kept (this test's own little picture server stands in for the web)
  const web = http.createServer(async (rq, rs) => {
    if (rq.url === '/a.png') { rs.writeHead(200, { 'content-type': 'image/png' }); rs.end(await png(70, 40, '#aa5500')); }
    else if (rq.url === '/m.gif') { rs.writeHead(200, { 'content-type': 'image/gif' }); rs.end(gifBytes); }
    else if (rq.url === '/page') { rs.writeHead(200, { 'content-type': 'text/html' }); rs.end('<p>not a picture</p>'); }
    else { rs.writeHead(404); rs.end(); }
  });
  await new Promise((res) => web.listen(0, '127.0.0.1', res)); const site = (path2) => `http://127.0.0.1:${web.address().port}${path2}`;
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Linked photo', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: site('/a.png') } }) }); const LT = r.body;
  ok(r.status === 200 && /^\/uploads\/th_\d+\.png$/.test(LT.data.bg.image) && await fetchOk(LT.data.bg.image), 'a wallpaper from a web link is fetched and kept as a file of the theme’s own');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Linked photo again', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: site('/a.png') } }) }); ok(r.body.data.bg.image === LT.data.bg.image, '… once, however many themes use the link');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Linked GIF', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: site('/m.gif') } }) }); ok(/\.gif$/.test(r.body.data.bg.image) && await pagesOf(r.body.data.bg.image) === 2, 'a GIF from a web link keeps moving');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Dead link', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: site('/gone.png') } }) }); ok(r.status === 200 && r.body.data.bg.image === site('/gone.png'), 'a link that can’t be fetched stays a link (the theme still saves)');
  r = await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Page link', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: site('/page') } }) }); ok(r.status === 200 && r.body.data.bg.image === site('/page'), '… and so does one that isn’t a picture');
  web.close();

  console.log('\nPreview pictures');
  const prev = await png(640, 360, '#223344');
  r = await sendBytes('PUT', `/themes/library/${T2.id}/preview`, N.token, prev); const pv = r.body?.preview;
  const pm = r.status === 200 && pv ? await sharp(Buffer.from(await (await fetch(base + pv)).arrayBuffer())).metadata() : {};
  ok(r.status === 200 && /^\/uploads\/th_\d+\.webp$/.test(pv) && pm.format === 'webp' && pm.width === 640, 'a preview is stored like an upload (as WebP) and the theme points at it');
  r = await sendBytes('PUT', `/themes/library/${T2.id}/preview`, N.token, await png(1600, 900, '#223344'));
  ok(r.status === 200 && (await sharp(Buffer.from(await (await fetch(base + r.body.preview)).arrayBuffer())).metadata()).width === 720, 'a bigger one is cut down to 720 wide');
  r = await sendBytes('PUT', `/themes/library/${T2.id}/preview`, N.token, Buffer.from('definitely not a picture')); ok(r.status === 400, 'something that isn’t a picture is refused');
  r = await sendBytes('PUT', `/themes/library/${T2.id}/preview`, N.token, await png(40, 30, '#223344')); ok(r.status === 400, '… and so is a speck');
  r = await sendBytes('PUT', `/themes/library/${T2.id}/preview`, C.token, prev); ok(r.status === 404, 'only the owner can set a theme’s preview');
  r = await api('GET', '/themes/library', N.token); ok(r.body.themes.find((t) => t.id === T2.id).preview.endsWith('.webp'), 'the library hands it out with the theme');

  /* ---------------------------------------------------------------- publishing */
  console.log('\nPublishing on Discovery');
  r = await api('POST', '/themes/library', C.token, { kind: 'site', name: 'Sunset Glass', data: siteLook() }); const CT1 = r.body;
  r = await api('POST', '/themes/discover', C.token, { id: CT1.id }); ok(r.status === 400 && r.body.code === 'no_preview', 'a theme needs its preview first');
  await sendBytes('PUT', `/themes/library/${CT1.id}/preview`, C.token, prev);
  r = await api('POST', '/themes/discover', C.token, { id: CT1.id, name: rot13('shpx') }); ok(r.status === 400, 'the name has to be clean');
  r = await api('POST', '/themes/discover', C.token, { id: '1234' }); ok(r.status === 404, 'only a theme in your own library can be published');
  r = await api('POST', '/themes/discover', C.token, { id: CT1.id, name: 'Sunset Glass' }); const PUB1 = r.body;
  ok(r.status === 200 && PUB1.status === 'pending' && PUB1.kind === 'site' && PUB1.name === 'Sunset Glass' && PUB1.preview?.endsWith('.webp') && PUB1.author.id === C.user.id && PUB1.mine && !('data' in PUB1), 'anyone can send one of their themes to Discovery: it waits for Orata staff');
  r = await api('GET', '/themes/discover?kind=site', N.token); ok(r.status === 200 && !r.body.themes.some((t) => t.id === PUB1.id), 'a theme waiting for staff isn’t on Discovery');
  r = await api('POST', `/themes/discover/${PUB1.id}/install`, N.token); ok(r.status === 404, '… so nobody can install it');
  r = await api('PUT', `/themes/discover/${PUB1.id}/vote`, N.token, { vote: true }); ok(r.status === 404, '… or upvote it');
  r = await api('GET', '/themes/library', C.token); ok(r.body.themes[0].published === PUB1.id && r.body.themes[0].pending === true, 'its author’s library says it is waiting');
  r = await api('GET', '/themes/discover?status=pending', N.token); ok(r.status === 403, 'only Orata staff see what is waiting');
  r = await api('GET', '/themes/discover?status=pending', S.token); ok(r.status === 200 && r.body.themes.some((t) => t.id === PUB1.id && t.status === 'pending'), 'Orata staff do');
  r = await api('POST', `/themes/discover/${PUB1.id}/review`, C.token, { approve: true }); ok(r.status === 403, 'its author can’t approve it');
  const wc = await connect(C.token);
  r = await approve(PUB1.id); ok(r.status === 200 && r.body.status === 'approved', 'a staff member approves it');
  ok(/is on Discovery now/.test((await wc.wait('message_create').catch(() => null))?.message?.content || ''), '… and Orbit tells its author'); wc.ws.close();
  r = await approve(PUB1.id); ok(r.status === 400 && r.body.code === 'already_reviewed', '(once)');
  r = await api('GET', '/themes/library', C.token); ok(r.body.themes[0].published === PUB1.id && r.body.themes[0].pending === false, 'the library shows which of your themes are on Discovery');
  r = await api('POST', '/themes/discover', C.token, { id: CT1.id }); ok(r.status === 400 && r.body.code === 'already_published', 'a theme goes up only once');
  r = await api('POST', '/themes/library', D.token, { kind: 'profile', name: 'Zebra', data: profileLook() }); const DT1 = r.body; await sendBytes('PUT', `/themes/library/${DT1.id}/preview`, D.token, prev);
  r = await api('POST', '/themes/discover', D.token, { id: DT1.id }); const PUB2 = r.body; ok(r.status === 200 && PUB2.kind === 'profile', 'a profile theme can be sent');
  await approve(PUB2.id);
  for (const [n, kind] of [['Apple', 'site'], ['mango', 'site'], ['Banana', 'site'], ['cherry', 'site']]) {
    const t = (await api('POST', '/themes/library', C.token, { kind, name: n, data: siteLook({ theme: { ...siteLook().theme, radius: n.length } }) })).body;
    await sendBytes('PUT', `/themes/library/${t.id}/preview`, C.token, prev); await approve((await api('POST', '/themes/discover', C.token, { id: t.id })).body.id);
  }
  r = await api('POST', '/themes/discover', N.token, { id: T2.id }); const NP = r.body; ok(r.status === 200 && NP.status === 'pending', 'someone else sends one too');
  const wn = await connect(N.token);
  r = await api('POST', `/themes/discover/${NP.id}/review`, S.token, { approve: false, reason: 'Too close to another theme' }); ok(r.status === 200, 'staff can turn a theme away');
  ok(/wasn’t approved/.test((await wn.wait('message_create').catch(() => null))?.message?.content || ''), '… Orbit tells its author why'); wn.ws.close();
  r = await api('GET', '/themes/library', N.token); ok(r.body.themes.find((t) => t.id === T2.id).published === null, '… it stays in their library, off Discovery');
  r = await approve(NP.id); ok(r.status === 404, '… and leaves the waiting list');
  r = await api('GET', '/staff/log', S.token); ok(['approve_theme', 'reject_theme'].every((a) => r.body?.log?.some((e) => e.action === a && e.by === S.user.id)), 'approvals and turn-aways go in the staff log');

  /* ---------------------------------------------------------------- Discovery */
  console.log('\nBrowsing Discovery');
  r = await api('GET', '/themes/discover?kind=site&sort=alpha', N.token);
  ok(r.status === 200 && r.body.total === 5 && r.body.themes.map((t) => t.name).join() === 'Apple,Banana,cherry,mango,Sunset Glass', 'the site themes sort alphabetically, whatever the capital letters');
  r = await api('GET', '/themes/discover?kind=profile&sort=alpha', N.token); ok(r.body.total === 1 && r.body.themes[0].name === 'Zebra', 'profile themes are a tab of their own');
  r = await api('GET', '/themes/discover?kind=site&sort=alpha', N.token); const first = r.body.themes[0];
  ok(first.preview && first.author.displayName === 'Cora' && first.installs === 0 && first.installed === false && first.mine === false && !('data' in first), 'each card has its preview, name and author (and nothing it doesn’t need)');
  const orderOf = async (seed) => (await api('GET', `/themes/discover?kind=site&sort=random&seed=${seed}`, N.token)).body.themes.map((t) => t.id).join();
  const alphaOrder = (await api('GET', '/themes/discover?kind=site&sort=alpha', N.token)).body.themes.map((t) => t.id).join();
  ok(await orderOf(7) === await orderOf(7), 'a random order stays the same for the same seed (so scrolling doesn’t reshuffle)');
  const orders = new Set(); for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) orders.add(await orderOf(seed));
  ok(orders.size > 1 && [...orders].every((o) => o.split(',').sort().join() === alphaOrder.split(',').sort().join()), '… and a different seed shuffles it, always with the same themes');
  r = await api('GET', '/themes/discover?kind=site&sort=alpha&limit=2&offset=2', N.token); ok(r.body.themes.map((t) => t.name).join() === 'cherry,mango' && r.body.total === 5, 'it pages');
  r = await api('GET', '/themes/discover?kind=site', C.token); ok(r.body.themes.every((t) => t.mine), 'the creator sees their own themes marked as theirs');

  /* ---------------------------------------------------------------- upvotes and Featured */
  console.log('\nUpvotes and Featured');
  const named = Object.fromEntries((await api('GET', '/themes/discover?kind=site&sort=alpha', N.token)).body.themes.map((x) => [x.name, x]));
  const vote = (tok, tid, v = true) => api('PUT', `/themes/discover/${tid}/vote`, tok, { vote: v });
  r = await vote(N.token, named.cherry.id); ok(r.status === 200 && r.body.votes === 1 && r.body.voted === true, 'a theme can be upvoted');
  r = await vote(N.token, named.cherry.id); ok(r.body.votes === 1, '… once per person');
  r = await vote(E.token, named.cherry.id); ok(r.body.votes === 2, '… and by anyone else');
  r = await vote(E.token, named.mango.id); ok(r.body.votes === 1, 'each theme has its own count');
  r = await vote(C.token, named.cherry.id); ok(r.status === 400 && r.body.code === 'own_theme', 'but not your own theme');
  r = await api('PUT', `/themes/discover/${named.cherry.id}/vote`, N.token, { vote: 'yes' }); ok(r.status === 400, 'an upvote is a clear yes or no');
  r = await vote(N.token, '1234'); ok(r.status === 404, 'a theme that isn’t there can’t be upvoted');
  r = await api('PUT', `/themes/discover/${named.cherry.id}/vote`, null, { vote: true }); ok(r.status === 401, 'you have to be signed in to upvote');
  const avatar = await upload(C.token, await png(40, 40, '#ff00aa')); await api('PATCH', '/me', C.token, { avatar });
  r = await api('GET', '/themes/discover?kind=site', N.token); const featured = r.body.themes;
  ok(featured[0].id === named.cherry.id && featured[1].id === named.mango.id && featured[0].votes === 2 && featured[0].voted === true && featured[1].voted === false, 'by default the most upvoted themes come first (Featured), and each says if you upvoted it');
  ok(featured.slice(2).every((x) => x.votes === 0), '… then the ones nobody has upvoted');
  ok(featured.slice(2).map((x) => x.id).join() === [...featured.slice(2)].sort((x, y) => (BigInt(y.id) > BigInt(x.id) ? 1 : -1)).map((x) => x.id).join(), '(newest first among the ones nobody upvoted)');
  r = await api('GET', '/themes/discover?kind=site&sort=featured', N.token); ok(r.body.themes.map((x) => x.id).join() === featured.map((x) => x.id).join(), '“featured” is the same order, asked for by name');
  ok(featured[0].author.avatar === avatar && featured[0].author.displayName === 'Cora' && featured[0].author.id === C.user.id && featured[0].author.badges.some((b) => b.id === 'early'), 'each theme carries its poster’s name, picture and badges (what clicking their name shows as their profile)');
  r = await api('GET', '/themes/discover?kind=site&sort=alpha', N.token); ok(r.body.themes[0].name === 'Apple', 'the other sorts are not affected by upvotes');
  r = await vote(N.token, named.cherry.id, false); ok(r.body.votes === 1 && r.body.voted === false, 'an upvote can be taken back');
  r = await api('GET', '/themes/discover?kind=site', N.token); ok(r.body.themes[0].id === named.cherry.id && r.body.themes[1].id === named.mango.id, 'equal votes: the newer theme first');
  await vote(E.token, named.cherry.id, false); await vote(E.token, named.mango.id, false);

  /* ---------------------------------------------------------------- installing */
  console.log('\nInstalling');
  r = await api('POST', `/themes/discover/${PUB1.id}/install`, N.token); const IN1 = r.body.theme;
  ok(r.status === 200 && !r.body.already && IN1.kind === 'site' && IN1.name === 'Sunset Glass' && IN1.from === PUB1.id && IN1.preview === PUB1.preview && IN1.data.theme.accent === '#ff00aa', 'installing copies the theme, with its preview, into your library');
  r = await api('POST', `/themes/discover/${PUB1.id}/install`, N.token); ok(r.status === 200 && r.body.already === true, 'installing it again does nothing');
  r = await api('GET', '/themes/library', N.token); ok(r.body.themes.filter((t) => t.from === PUB1.id).length === 1, '… and doesn’t add a second copy');
  r = await api('GET', '/themes/discover?kind=site&sort=alpha', N.token); ok(r.body.themes.find((t) => t.id === PUB1.id).installed === true && r.body.themes.find((t) => t.id === PUB1.id).installs === 1, 'Discovery says it is installed, and counts the install');
  r = await api('POST', '/themes/discover', N.token, { id: IN1.id }); ok(r.status === 400 && r.body.code === 'not_yours', 'an installed theme isn’t yours to send');
  r = await api('POST', `/themes/discover`, C.token, { id: IN1.id }); ok(r.status === 404, '… and nobody else can publish what is in your library');
  r = await api('POST', `/themes/discover/${PUB2.id}/install`, C.token); const CIN = r.body.theme;
  r = await api('POST', '/themes/discover', C.token, { id: CIN.id }); ok(r.status === 400 && r.body.code === 'not_yours', 'even a creator can only publish their own work, not a theme they installed');
  r = await api('POST', '/themes/discover/12345/install', N.token); ok(r.status === 404, 'a theme that isn’t there can’t be installed');
  // a full library says so
  r = await api('POST', `/themes/discover/${PUB2.id}/install`, M.token); ok(r.status === 400 && r.body.code === 'library_full' && /25 of 25/.test(r.body.error), 'with a full library, installing says it is full (25 of 25)');
  r = await api('GET', '/themes/library', M.token); ok(r.body.themes.filter((t) => t.kind === 'profile').length === 25 && r.body.themes.length === 50, '… and adds nothing');
  const siteRoom = (await api('GET', '/themes/library', M.token)).body.themes.find((t) => t.kind === 'site');
  await api('DELETE', `/themes/library/${siteRoom.id}`, M.token);
  r = await api('POST', `/themes/discover/${PUB1.id}/install`, M.token); ok(r.status === 200, 'the limits are per kind: a free site slot takes a site theme although the profile ones are full');

  /* ---------------------------------------------------------------- downloads */
  console.log('\nDownloads');
  r = await api('GET', '/themes/discover?kind=site&sort=downloads', N.token); const byDownloads = r.body.themes;
  ok(byDownloads[0].id === PUB1.id && byDownloads[0].installs === 2 && byDownloads.every((x, i) => i === 0 || byDownloads[i - 1].installs >= x.installs), 'themes sort by downloads: the most installed first, and each card carries its count');
  r = await api('GET', '/themes/discover?kind=site&sort=downloads&limit=1&offset=1', N.token); ok(r.body.themes[0].id === byDownloads[1].id, '(the download order pages like the others)');

  /* ---------------------------------------------------------------- unpublishing */
  console.log('\nUnpublishing');
  r = await api('DELETE', `/themes/discover/${PUB1.id}`, N.token); ok(r.status === 403, 'only the author (or staff) can unpublish');
  const pubFile = PUB1.preview;
  r = await api('DELETE', `/themes/discover/${PUB1.id}`, C.token); ok(r.status === 200, 'the author can unpublish');
  r = await api('GET', '/themes/discover?kind=site&sort=alpha', N.token); ok(!r.body.themes.some((t) => t.id === PUB1.id) && r.body.total === 4, 'it leaves Discovery');
  r = await api('GET', '/themes/library', C.token); ok(r.body.themes.find((t) => t.id === CT1.id).published === null, '… and their library shows it as not published');
  r = await api('GET', '/themes/library', N.token); ok(r.body.themes.some((t) => t.id === IN1.id) && await fetchOk(pubFile), 'people who installed it keep their copy, preview and all');
  r = await api('POST', `/themes/discover/${PUB1.id}/install`, E.token); ok(r.status === 404, 'but nobody new can install it');
  const stray = (await api('GET', '/themes/discover?kind=site&sort=alpha', N.token)).body.themes[0];
  r = await api('DELETE', `/themes/discover/${stray.id}`, S.token); ok(r.status === 200, 'staff can take any theme down');
  r = await api('DELETE', `/themes/discover/${stray.id}`, S.token); ok(r.status === 404, 'once');
  r = await api('POST', '/themes/discover', C.token, { id: CT1.id }); ok(r.status === 200 && r.body.status === 'pending', 'an unpublished theme can be sent again (and waits for staff again)');
  r = await api('GET', '/staff/log', S.token); ok(r.body?.log?.some((e) => e.action === 'unpublish_theme' && e.by === S.user.id && e.target === C.user.id), 'a staff takedown goes in the staff log');

  /* ---------------------------------------------------------------- staff and developers post too */
  console.log('\nWho may post');
  const staffTheme = (await api('POST', '/themes/library', S.token, { kind: 'site', name: 'Staff Look', data: siteLook() })).body; await sendBytes('PUT', `/themes/library/${staffTheme.id}/preview`, S.token, prev);
  r = await api('POST', '/themes/discover', S.token, { id: staffTheme.id }); const staffPub = r.body; ok(r.status === 200 && staffPub.author.id === S.user.id && staffPub.status === 'approved', 'Orata staff’s own themes go up at once (they are the ones who approve)');
  const devTheme = (await api('POST', '/themes/library', X.token, { kind: 'site', name: 'Dev Look', data: siteLook() })).body; await sendBytes('PUT', `/themes/library/${devTheme.id}/preview`, X.token, prev);
  r = await api('POST', '/themes/discover', X.token, { id: devTheme.id }); const devPub = r.body; ok(r.status === 200 && devPub.status === 'approved', 'so do a developer’s');
  r = await api('POST', '/themes/discover', N.token, { id: (await api('POST', '/themes/library', N.token, { kind: 'site', name: 'Nope', data: siteLook() })).body.id }); ok(r.status === 400 && r.body.code === 'no_preview', 'everyone else’s go through the same checks (here: no preview yet)');
  await api('DELETE', `/themes/discover/${staffPub.id}`, S.token); await api('DELETE', `/themes/discover/${devPub.id}`, X.token);

  /* ---------------------------------------------------------------- syncing between devices */
  console.log('\nSyncing');
  const w1 = await connect(N.token); const w2 = await connect(N.token);
  const heard = w2.wait('themes_update');
  await api('POST', '/themes/library', N.token, { kind: 'profile', name: 'Synced', data: profileLook() }, { 'x-conn': 'nope' });
  ok(!!(await heard.catch(() => null)), 'saving a theme tells your other open devices to reload the library');
  w1.ws.close(); w2.ws.close();

  /* ---------------------------------------------------------------- accounts that go */
  console.log('\nAccounts that go');
  r = await api('DELETE', '/me', D.token, { password: 'password123' }); ok(r.status === 200, 'an account can be deleted');
  r = await api('GET', '/themes/discover?kind=profile', N.token); ok(r.body.total === 0, 'its published themes go with it');
  r = await api('POST', `/themes/discover/${PUB2.id}/install`, N.token); ok(r.status === 404, '… so nobody can install them any more');

  /* ---------------------------------------------------------------- the sweep of theme files nobody uses */
  console.log('\nTidying up theme files');
  const lonely = (await api('POST', '/themes/library', E.token, { kind: 'site', name: 'Lonely', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: await upload(E.token, await png(50, 50, '#ab12cd')) } }) })).body;
  const kept = (await api('POST', '/themes/library', E.token, { kind: 'site', name: 'Kept', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: await upload(E.token, await png(51, 50, '#12abcd')) } }) })).body;
  const worn = (await api('POST', '/themes/library', E.token, { kind: 'site', name: 'Worn', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: await upload(E.token, await png(52, 50, '#cdab12')) } }) })).body;
  await api('PATCH', '/me/settings', E.token, { bg: { type: 'image', image: worn.data.bg.image } });   // wearing it now: the theme can go, the picture stays
  await sendBytes('PUT', `/themes/library/${lonely.id}/preview`, E.token, prev);
  const lonelyPreview = (await api('GET', '/themes/library', E.token)).body.themes.find((t) => t.id === lonely.id).preview;
  await api('DELETE', `/themes/library/${lonely.id}`, E.token); await api('DELETE', `/themes/library/${worn.id}`, E.token);
  ok(await fetchOk(lonely.data.bg.image) && await fetchOk(lonelyPreview), 'a deleted theme’s files are not removed at once');
  const t2Preview = (await api('GET', '/themes/library', N.token)).body.themes.find((t) => t.id === T2.id).preview;
  await stopServer(); startServer({ THEME_FILE_GRACE_MS: '0', THEME_SWEEP_FIRST_MS: '400' }); await ready(); await sleep(1500);
  ok(!(await fetchOk(lonely.data.bg.image)) && !(await fetchOk(lonelyPreview)), 'the sweep removes the picture and preview nothing uses any more');
  ok(await fetchOk(kept.data.bg.image) && await fetchOk(worn.data.bg.image) && await fetchOk(T2.data.bg.image) && await fetchOk(PUB1.preview) && await fetchOk(t2Preview) && await fetchOk(BT.data.banner.image) && await fetchOk(GT.data.banner.image), '… and keeps every one that a theme (a banner or card picture too), a posted theme or your current wallpaper still uses');
  r = await api('GET', '/themes/library', N.token); ok(r.body.themes.some((t) => t.id === IN1.id), 'everything is still there after a restart');
  r = await api('POST', '/themes/library', E.token, { kind: 'site', name: 'Again', data: siteLook({ bg: { ...siteLook().bg, type: 'image', image: kept.data.bg.image } }) }); ok(r.status === 200, 'saving after a sweep works');

  await stopServer();
  try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* temp folder */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
