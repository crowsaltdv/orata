// Orata — REST API.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import {
  db, save, newId, cmpId, sha, ENV, DATA_DIR, UPLOAD_DIR, ROOT, ApiError, bad, forbidden, notFound, byUsername, byEmail,
  conns, emitTo, can, need, permsOf, permsIn, canIn, needIn, listedFor, isSynced, overwritesOf, sanitizeOverwrites, topRolePos, canView, audienceOf, serverAudience, channelsOfServer, publicUser, selfUser,
  serverView, channelView, messageView, relatedUserIds, broadcastPresence, readStateFor, systemMessage, randomCode, RESERVED,
  ensureBot, createServer, addMember, PERMS, DEFAULT_PERMS, effectiveStatus, voice, lastMessageId, memberView, noteDevice, deviceHashesOf, requestHashes, randomAvatarBg, CUSTOM_EMOJI, findEmoji, customEmojisIn, postView, isOwner, audit,
} from './core.js';
import { automodRule } from './automod.js';
import { nameProblem } from './names.js';
import { mountApplications, publicServerInfo } from './applications.js';
import { mountStaff, accountBlock, noteNewAccount } from './staff.js';
import { formatDuration } from '../public/js/orbit-commands.js';
import { postMessage, sanitizeMedia, sanitizeAttachments, clampInt, messageEdited, messagesDeleted, memberJoined, memberLeft, messageReacted } from './messages.js';
import { startDiscord, discordOn, noteSite } from './discord.js';
import { sanitizeProfileStyle } from '../public/js/profile-data.js';
import { hasProfanity, censor, cleanBlockedWords } from './profanity.js';   // the same checker the browser uses
import { verificationMode, isGated, issueVerification, consumeVerification, resendWait, maskEmail, baseUrl } from './verify.js';
import { beginSignup, confirmSignup, resendSignup } from './signup.js';
import { closeConns, storeUpload, restoreUpload } from './core.js';
import { createSession, findSession, touchSession, endSession, endUserSessions, listSessions } from './sessions.js';
import { mountMusic, musicReady, musicProblem } from './music.js';
import { isStage, isVoiceLike, revalidateStage } from './stage.js';
import { mountBadges } from './badges.js';
import { mountThemes, dropUserThemes } from './themes.js';
import { mountOrbit, addOrbit, reactionRole } from './orbit.js';

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------ utilities */
const buckets = new Map();
function limit(name, max, windowMs, keyFn = (req) => req.ip) {
  return (req, res, next) => {
    const key = name + ':' + keyFn(req); const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    if (++b.n > max) return next(new ApiError(429, 'You are being rate limited. Slow down a little.', 'rate_limited'));
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
async function hashPassword(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: await scrypt(pw, salt) }; }
async function checkPassword(user, pw) {
  if (!user.hash || typeof pw !== 'string') return false;
  const a = Buffer.from(await scrypt(pw, user.salt), 'hex'); const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const HEX = /^#[0-9a-fA-F]{6}$/;
function str(v, min, max, name) {
  if (typeof v !== 'string') throw bad(`${name} is required`);
  const s = v.trim();
  if (s.length < min) throw bad(`${name} must be at least ${min} character${min > 1 ? 's' : ''}`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters`);
  return s;
}
const uploadRef = (v) => (v === null || v === '' ? null : (/^\/uploads\/[A-Za-z0-9_.-]+$/.test(String(v)) ? String(v) : undefined));

const newSession = (user, req) => { noteDevice(user, req); return createSession(user.id, req.headers['user-agent']); };   // sessions keep no IP; the account keeps a few hashes for ban checks (see core.js)

function getChannel(req, id) {
  const ch = db.channels[id];
  if (!ch || !canView(req.user.id, ch)) throw notFound('Unknown channel');
  if (req.method !== 'GET' && ch.serverId && !db.servers[ch.serverId]?.members[req.user.id]) throw forbidden('Ghost mode is read only');   // staff ghosting (core.js ghosts)
  return ch;
}
function getServer(req, id) {
  const s = db.servers[id];
  if (!s || !s.members[req.user.id]) throw notFound('Unknown server');
  return s;
}
const usersFor = (ids) => [...new Set(ids)].map((id) => publicUser(db.users[id])).filter(Boolean);

function pushServerUpdate(server) {
  for (const uid of serverAudience(server)) emitTo([uid], 'server_update', { server: serverView(server, uid) });
}

/* ------------------------------------------------------------ ICE (STUN/TURN) */
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
/**
 * WebRTC ICE servers for the browser. Configure in .env:
 *   STUN_URLS=stun:stun.example.com:3478            (default: Google's public STUN)
 *   TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
 *   TURN_USERNAME / TURN_CREDENTIAL                  static credentials, or
 *   TURN_SECRET=<coturn static-auth-secret>          time-limited credentials (TURN REST API, recommended)
 *   TURN_TTL=86400                                   lifetime of generated credentials, seconds
 *   ICE_TRANSPORT_POLICY=relay                       force all media through TURN (testing / privacy)
 * Or let a hosted relay hand out credentials (free tiers exist; see README → TURN):
 *   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN        Cloudflare Realtime TURN
 *   METERED_APP (your app name) + METERED_API_KEY             Metered / Open Relay
 */
const hostedTurnConfigured = () => !!((ENV.CLOUDFLARE_TURN_KEY_ID && ENV.CLOUDFLARE_TURN_API_TOKEN) || (ENV.METERED_APP && ENV.METERED_API_KEY));
/** Is any relay set up (own TURN server or a hosted one)? Without one, two people on strict networks (school, work) can't hear each other. */
export const turnConfigured = () => csv(ENV.TURN_URLS || ENV.TURN_URL).length > 0 || hostedTurnConfigured();
const hostedCache = { at: 0, ttl: 0, servers: null, pending: null };
/** ICE servers from the hosted relay, fetched with the server's own key and cached; browsers only ever see short-lived credentials. */
async function hostedTurn() {
  if (!hostedTurnConfigured()) return null;
  const fresh = hostedCache.servers && Date.now() - hostedCache.at < hostedCache.ttl * 500;
  if (fresh) return hostedCache.servers;
  hostedCache.pending ||= (async () => {
    try {
      let servers; let ttl;
      if (ENV.CLOUDFLARE_TURN_KEY_ID && ENV.CLOUDFLARE_TURN_API_TOKEN) {
        ttl = 86400;
        const base = String(ENV.CLOUDFLARE_TURN_API_BASE || 'https://rtc.live.cloudflare.com').replace(/\/+$/, '');
        const res = await fetch(`${base}/v1/turn/keys/${encodeURIComponent(ENV.CLOUDFLARE_TURN_KEY_ID)}/credentials/generate-ice-servers`, { method: 'POST', headers: { authorization: `Bearer ${ENV.CLOUDFLARE_TURN_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl }), signal: AbortSignal.timeout(6000) });
        if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}`);
        servers = (await res.json()).iceServers;
      } else {
        ttl = 3600;
        const base = String(ENV.METERED_API_BASE || `https://${encodeURIComponent(ENV.METERED_APP)}.metered.live`).replace(/\/+$/, '');
        const res = await fetch(`${base}/api/v1/turn/credentials?apiKey=${encodeURIComponent(ENV.METERED_API_KEY)}`, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) throw new Error(`Metered answered ${res.status}`);
        servers = await res.json();
      }
      servers = (Array.isArray(servers) ? servers : []).filter((s) => s && s.urls && (Array.isArray(s.urls) ? s.urls.length : true)).slice(0, 8);
      if (!servers.some((s) => s.username)) throw new Error('the relay returned no TURN credentials');
      Object.assign(hostedCache, { at: Date.now(), ttl, servers });
    } catch (e) {
      console.warn('[ice] hosted TURN unavailable:', e.message);
      if (!hostedCache.servers) hostedCache.at = Date.now() - 50_000;   // retry in about 10 s instead of on every call
    } finally { hostedCache.pending = null; }
    return hostedCache.servers;
  })();
  return hostedCache.pending;
}
export async function buildIceConfig(userId) {
  const stun = csv(ENV.STUN_URLS); const turn = csv(ENV.TURN_URLS || ENV.TURN_URL);
  const iceServers = [{ urls: stun.length ? stun : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (turn.length) {
    if (ENV.TURN_SECRET) {
      const ttl = Math.max(300, Number(ENV.TURN_TTL || 86400));
      const username = `${Math.floor(Date.now() / 1000) + ttl}:${userId}`;
      const credential = crypto.createHmac('sha1', ENV.TURN_SECRET).update(username).digest('base64');
      iceServers.push({ urls: turn, username, credential });
    } else if (ENV.TURN_USERNAME) {
      iceServers.push({ urls: turn, username: ENV.TURN_USERNAME, credential: ENV.TURN_CREDENTIAL || '' });
    } else iceServers.push({ urls: turn });
  }
  const hosted = await hostedTurn();   // Cloudflare / Metered, when configured
  if (hosted) iceServers.push(...hosted);
  const relay = turn.length > 0 || !!hosted;
  return { iceServers, iceTransportPolicy: ENV.ICE_TRANSPORT_POLICY === 'relay' && relay ? 'relay' : 'all', turn: relay, ttl: hosted ? Math.min(3600, Math.round(hostedCache.ttl / 2)) : ENV.TURN_SECRET ? Math.max(300, Number(ENV.TURN_TTL || 86400)) : 3600 };
}

/* ------------------------------------------------------------ ready */
export function buildReady(user) {
  if (isGated(user)) return { user: selfUser(user), servers: [], dms: [], users: [], relationships: [], readStates: {}, voiceStates: [], botId: db.botId, gated: true };   // must verify their email first
  const servers = Object.values(db.servers).filter((s) => s.members[user.id]);
  const dms = Object.values(db.channels).filter((c) => !c.serverId && c.recipients?.includes(user.id) && !user.closedDms?.[c.id]);
  const userIds = new Set([user.id, ...relatedUserIds(user.id)]);
  for (const d of dms) for (const id of d.recipients) userIds.add(id);
  for (const id of Object.keys(user.rel || {})) userIds.add(id);
  const readStates = {};
  const chans = [...dms, ...servers.flatMap((s) => channelsOfServer(s.id).filter((c) => canView(user.id, c) && !['category', 'voice', 'stage', 'forum', 'post'].includes(c.type)))];
  for (const ch of chans) readStates[ch.id] = readStateFor(user, ch);
  const voiceStates = [];
  for (const [channelId, room] of voice) { const ch = db.channels[channelId]; if (ch && canView(user.id, ch)) for (const st of room.values()) voiceStates.push(st); }
  return {
    user: selfUser(user),
    servers: servers.map((s) => serverView(s, user.id)),
    dms: dms.map((c) => channelView(c)),
    users: usersFor([...userIds]),
    relationships: Object.entries(user.rel || {}).map(([id, type]) => ({ id, type })),
    readStates, voiceStates, botId: db.botId,
  };
}

/* ------------------------------------------------------------ router */
export function createApi() {
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));

  r.get('/config', h(async (req, res) => res.json({
    name: 'Orata', gifs: !!ENV.KLIPY_API_KEY, discord: discordOn, turn: turnConfigured(), maxUpload: Number(ENV.MAX_UPLOAD_MB || 25) * 1024 * 1024, version: '1.0.0',
    users: Object.keys(db.users).length, botId: db.botId,
    emailVerification: verificationMode(),   // { enabled, required, smtp }
    music: await musicReady(), musicWhy: musicProblem(),   // musicWhy: what the server still needs (Python, ytmusicapi), shown on the Music page
  })));

  /* --------------------------- auth --------------------------- */
  r.post('/auth/check', limit('check', 60, 60_000), h(async (req, res) => {
    const { username, email } = req.body || {};
    res.json({
      username: username ? !byUsername.has(String(username).toLowerCase()) && !RESERVED.has(String(username).toLowerCase()) && !nameProblem(username) : undefined,
      email: email ? !byEmail.has(String(email).toLowerCase()) : undefined,
    });
  }));

  r.post('/auth/register', limit('register', 8, 60_000), h(async (req, res) => {
    const b = req.body || {};
    // an email is optional: without one you sign in with your username (and nothing needs verifying)
    const emailRaw = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    let email = null;
    if (emailRaw) {
      if (emailRaw.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRaw)) throw bad('Enter a valid email address', 'email');
      if (byEmail.has(emailRaw)) throw bad('That email is already registered', 'email');
      email = emailRaw;
    }
    const username = str(b.username, 2, 32, 'Username').toLowerCase();
    if (!/^[a-z0-9_.]+$/.test(username) || /\.\./.test(username)) throw bad('Usernames can only use letters, numbers, underscores and single periods', 'username');
    if (byUsername.has(username) || RESERVED.has(username)) throw bad('That username is taken', 'username');
    const displayName = str(b.displayName || b.username, 1, 32, 'Display name');
    for (const [field, v] of [['username', username], ['displayName', displayName]]) { const np = nameProblem(v); if (np) throw bad(np, field); }
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < 8) throw bad('Password must be at least 8 characters', 'password');
    if (password.length > 128) throw bad('Password is too long', 'password');
    const dob = b.dob && typeof b.dob === 'object' ? { year: clampInt(b.dob.year, 1900, 2100, 0), month: clampInt(b.dob.month, 1, 12, 0), day: clampInt(b.dob.day, 1, 31, 0) } : null;
    if (!dob || !dob.year || !dob.month || !dob.day) throw bad('Enter your date of birth', 'dob');
    const born = new Date(dob.year, dob.month - 1, dob.day); const now = new Date();
    let age = now.getFullYear() - born.getFullYear();
    if (now < new Date(now.getFullYear(), born.getMonth(), born.getDate())) age--;
    if (age < 13) throw bad('You must be at least 13 years old to use Orata', 'dob');
    if (b.agree !== true) throw bad('Agree to the Terms of Service, Privacy Policy and Community Guidelines to sign up', 'agree');
    checkAccountLimits(req);

    ensureBot();
    const { salt, hash } = await hashPassword(password);
    const fields = { email, username, displayName, salt, hash, dob, agreedAt: Date.now() };
    if (email && verificationMode().enabled) {
      // nobody who gives an email gets an account until they type the code we email them (the half-finished sign-up is only kept in memory)
      const out = await beginSignup(fields);
      return res.json({ verify: true, ticket: out.ticket, email: maskEmail(email), mode: out.mode, expiresIn: out.expiresIn, resendIn: out.resendIn });
    }
    res.json(await createAccount(fields, req));
  }));

  // step 2 of a verified sign-up: the code from the email creates the account
  r.post('/auth/register/confirm', limit('regconfirm', 20, 60_000), h(async (req, res) => {
    const { ticket, code } = req.body || {};
    const fields = confirmSignup(ticket, code);
    if (byEmail.has(fields.email)) throw bad('That email was registered while you were verifying. Log in instead.', 'email');
    if (byUsername.has(fields.username)) throw bad('That username was taken while you were verifying. Pick another one.', 'username');
    res.json(await createAccount(fields, req));
  }));
  r.post('/auth/register/resend', limit('regresend', 10, 60_000), h(async (req, res) => {
    const out = await resendSignup((req.body || {}).ticket);
    res.json({ ok: true, mode: out.mode, expiresIn: out.expiresIn, resendIn: out.resendIn });
  }));

  /**
   * One browser may have at most ACCOUNTS_PER_BROWSER accounts at a time (default 3) and make at most ACCOUNTS_PER_HOUR an hour (default 3).
   * "Its" accounts are the ones it has been used with (the browser id kept for bans, see noteDevice); a deleted account frees its place but still counts for the hour.
   */
  function checkAccountLimits(req) {
    const mine = new Set(requestHashes(req)); if (!mine.size) return;
    const perBrowser = Number(ENV.ACCOUNTS_PER_BROWSER) || 3; const perHour = Number(ENV.ACCOUNTS_PER_HOUR) || 3;
    const seen = Object.values(db.users).filter((u) => !u.bot && [...deviceHashesOf(u)].some((x) => mine.has(x)));
    const recent = seen.map((u) => u.createdAt).filter((t) => t > Date.now() - 3600_000).sort((a, b) => a - b);
    if (recent.length >= perHour) {
      const mins = Math.max(1, Math.ceil((recent[recent.length - perHour] + 3600_000 - Date.now()) / 60_000));
      throw new ApiError(429, `You can only create ${perHour} accounts an hour. Wait ${mins} minute${mins === 1 ? '' : 's'} to create more.`, 'account_wait');
    }
    if (seen.filter((u) => !u.deleted).length >= perBrowser) throw new ApiError(403, `This browser already has ${perBrowser} Orata accounts, the most it can have at one time.`, 'account_limit');
  }

  /** Creates the user, joins the community server, sets up the welcome DM and returns { token, user }. */
  async function createAccount({ email, username, displayName, salt, hash, dob, agreedAt }, req) {
    checkAccountLimits(req);   // again: a verified sign-up only creates the account when the emailed code is typed
    ensureBot();
    const id = newId();
    const hues = ['#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#3b82f6', '#ef4444', '#eab308'];
    const user = {
      id, username, displayName, email, salt, hash, dob, avatar: null, avatarBg: randomAvatarBg(), banner: null, bannerColor: hues[Number(id) % hues.length],
      accentColor: null, bio: '', pronouns: '', status: 'online', customStatus: null, createdAt: Date.now(), rel: {}, reads: {}, settings: {}, closedDms: {},
      emailVerified: true,   // new accounts are verified: either verification is off, or they typed the emailed code
      agreedAt,   // when they ticked "I agree" to the Terms, Privacy Policy and Community Guidelines (/terms, /privacy, /guidelines)
    };
    db.users[id] = user; byUsername.set(username, id); if (email) byEmail.set(email, id);
    noteDevice(user, req);   // the browser this account starts on: the ban check below needs it
    noteNewAccount(user);   // four or more accounts on one browser: a flag for Orata staff

    // First user owns the shared community server; everybody after joins it — unless they are banned there from this browser.
    let community = db.defaultServerId && db.servers[db.defaultServerId]; let inCommunity = true;
    if (!community) {
      community = createServer(user, { name: 'Orata Community', template: 'community' });
      community.description = 'The default hangout for everyone on this Orata instance.';
      db.defaultServerId = community.id;
    } else if (isBannedFrom(community, user, req)) {
      inCommunity = false;
    } else {
      addMember(community, user);
      linkedTimeout(community, id, deviceHashesOf(user, requestHashes(req)));   // someone timed out there stays timed out on a new account
    }
    // welcome DM from Orbit
    const bot = ensureBot();
    const dmId = newId();
    db.channels[dmId] = { id: dmId, serverId: null, type: 'dm', recipients: [bot.id, id], createdAt: Date.now() };
    db.messages[dmId] = [];
    bot.rel ||= {}; bot.rel[id] = 'friend'; user.rel[bot.id] = 'friend';
    save();
    const token = await newSession(user, req);
    // announce join to community members
    const sys = community.systemChannelId;
    if (sys && inCommunity && community.ownerId !== id) {
      for (const uid of serverAudience(community)) if (uid !== id) emitTo([uid], 'member_add', { serverId: community.id, member: memberView(id, community.members[id]), user: publicUser(user) });
      systemMessage(sys, 'join', id);
    }
    if (inCommunity && community.ownerId !== id) memberJoined(community, id);
    setTimeout(() => {
      const dm = db.channels[dmId]; if (!dm) return;
      postMessage(dm, bot.id, { content: `**Welcome to Orata, ${displayName}!** 🎉\nI’m Orbit, your built-in helper. Say \`help\` any time to see what you can do.${inCommunity ? `\nA community server called **${community.name}** is already waiting for you on the left.` : ''}` });
    }, 1500);
    return { token, user: selfUser(user) };
  }

  r.post('/auth/login', limit('login', 12, 60_000), h(async (req, res) => {
    const { login, password } = req.body || {};
    const key = String(login || '').trim().toLowerCase();
    const id = byUsername.get(key) || byEmail.get(key);
    const user = id && db.users[id];
    if (!user || user.bot || !(await checkPassword(user, password))) throw new ApiError(401, 'Invalid login or password', 'invalid_login');
    const blocked = accountBlock(user); if (blocked) throw new ApiError(403, blocked, 'account_blocked');   // terminated, or locked for now, by Orata staff
    res.json({ token: await newSession(user, req), user: selfUser(user) });
  }));

  // The emailed link opens /verify?token=… in the app, which POSTs the token here (a POST, so mail scanners that pre-fetch links can't burn it).
  r.post('/auth/verify-email', limit('verify', 30, 60_000), h(async (req, res) => {
    const user = consumeVerification((req.body || {}).token);
    if (!user) throw bad('This verification link is invalid or has expired. Sign in and ask for a new one.', 'invalid_token');
    res.json({ ok: true, username: user.username, email: maskEmail(user.email) });
  }));

  /* ---- image proxy + disk cache (wallpapers; works pre-login, CORS-safe for WebGL, survives hotlink blocks) ---- */
  const IMG_CACHE = path.join(DATA_DIR, 'imgcache');
  fs.mkdirSync(IMG_CACHE, { recursive: true });
  r.get('/img', limit('img', 90, 60_000), h(async (req, res) => {
    const url = String(req.query.url || '');
    if (!/^https?:\/\//i.test(url) || url.length > 2000) throw bad('Invalid URL');
    const key = sha(url); const file = path.join(IMG_CACHE, key); const metaFile = file + '.json';
    const serve = (type) => res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=604800', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Security-Policy': "sandbox; default-src 'none'" }).sendFile(file);
    if (fs.existsSync(file) && fs.existsSync(metaFile)) { try { return serve(JSON.parse(fs.readFileSync(metaFile, 'utf8')).type); } catch { /* refetch */ } }
    const { resp } = await safeFetch(url, { image: true }).catch((e) => { throw new ApiError(502, e.message || 'Could not fetch that image', 'img_upstream'); });
    const type = (resp.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!resp.ok || !/^image\/(png|jpe?g|webp|gif|avif|bmp)$/.test(type)) throw new ApiError(415, 'That link is not a supported image', 'img_type');
    const len = Number(resp.headers.get('content-length') || 0);
    if (len > 25 * 1024 * 1024) throw new ApiError(413, 'Image is too large', 'img_big');
    const chunks = []; let total = 0;
    for await (const c of resp.body) { total += c.length; if (total > 25 * 1024 * 1024) throw new ApiError(413, 'Image is too large', 'img_big'); chunks.push(c); }
    fs.writeFileSync(file, Buffer.concat(chunks)); fs.writeFileSync(metaFile, JSON.stringify({ type, url }));
    serve(type);
  }));

  // Everything below requires a session.
  r.use(h(async (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const found = await findSession(m?.[1]);
    const user = found && db.users[found.rec.userId];
    if (!user || user.deleted || accountBlock(user)) throw new ApiError(401, 'Not signed in', 'unauthorized');
    req.user = user; req.session = found.rec; req.sessionId = found.hash;
    touchSession(found.hash, found.rec);
    noteDevice(user, req);   // the browser this account uses (hashed; only ever compared, to find ban evaders and alts)
    next();
  }));

  // REQUIRE_EMAIL_VERIFICATION: until the address is verified only these calls work
  const GATE_OK = new Set(['POST /auth/logout', 'POST /auth/resend-verification', 'GET /ready', 'GET /me', 'PATCH /me', 'DELETE /me']);
  r.use((req, res, next) => (isGated(req.user) && !GATE_OK.has(`${req.method} ${req.path}`) ? next(new ApiError(403, 'Verify your email to continue', 'email_unverified')) : next()));

  r.post('/auth/resend-verification', limit('resend', 8, 3600_000, (req) => req.user.id), h(async (req, res) => {
    const u = req.user;
    if (!u.email) throw bad('Add an email address first');
    if (!verificationMode().enabled) throw bad('Email verification is not enabled on this server');
    if (u.emailVerified !== false) throw bad('Your email is already verified', 'already_verified');
    const wait = resendWait(u);
    if (wait > 0) throw new ApiError(429, `Please wait ${Math.ceil(wait / 1000)} seconds before asking for another email.`, 'rate_limited');
    const out = await issueVerification(u, req);
    if (!out.sent) throw new ApiError(502, 'The email could not be sent. Ask the server admin to check the SMTP settings.', 'mail_failed');
    res.json({ sent: true, mode: out.mode, email: maskEmail(u.email) });
  }));

  mountMusic(r, { h, limit });
  mountBadges(r, { h });
  mountThemes(r, { h, limit, fetchImage: safeFetch });
  mountOrbit(r, { h, limit, getServer, getChannel, pushServerUpdate, guardText, automod, kickMember, banMember, timeoutMember });
  startDiscord({ guardText });

  r.post('/auth/logout', h(async (req, res) => { await endSession(req.sessionId); res.json({ ok: true }); }));
  r.get('/ready', (req, res) => { noteDevice(req.user, req); res.json(buildReady(req.user)); });   // (also remembers the browser, for the alt checks)

  /* --------------------------- me --------------------------- */
  r.get('/me', (req, res) => res.json(selfUser(req.user)));

  /* --------------------------- ICE servers (STUN / TURN for voice & video) --------------------------- */
  r.get('/ice', h(async (req, res) => res.json(await buildIceConfig(req.user.id))));

  r.patch('/me', h(async (req, res) => {
    const u = req.user; const b = req.body || {}; let emailChanged = false;
    if (b.displayName !== undefined) {
      const name = str(b.displayName, 1, 32, 'Display name');
      if (name !== u.displayName) { const np = nameProblem(name, u); if (np) throw bad(np, 'displayName'); }
      u.displayName = name;
    }
    if (b.bio !== undefined) u.bio = String(b.bio).slice(0, 400);
    if (b.pronouns !== undefined) u.pronouns = String(b.pronouns).slice(0, 40);
    if (b.avatarBg === 'random') u.avatarBg = randomAvatarBg();
    if (b.tagServer !== undefined) {   // the server tag worn next to your name: one server you're in that has a tag (null = none)
      if (b.tagServer === null || b.tagServer === '') delete u.tagServer;
      else { const t = db.servers[String(b.tagServer)]; if (!t?.members[u.id] || !t.tag) throw bad('That server has no tag you can wear'); u.tagServer = t.id; }
    }   // "shuffle" in Profile settings
    if (b.profile !== undefined) {   // colours, outline, fonts, effect and frames of the profile card (see public/js/profile-data.js)
      if (b.profile !== null && (typeof b.profile !== 'object' || JSON.stringify(b.profile).length > 4000)) throw bad('That profile style is invalid');
      u.profile = sanitizeProfileStyle(b.profile) || undefined;
    }
    for (const k of ['avatar', 'banner']) if (b[k] !== undefined) { const v = uploadRef(b[k]); if (v === undefined) throw bad(`Invalid ${k}`); u[k] = v; }
    for (const k of ['bannerColor', 'accentColor']) if (b[k] !== undefined) { if (b[k] !== null && !HEX.test(b[k])) throw bad(`Invalid ${k}`); u[k] = b[k]; }
    if (b.status !== undefined) { if (!['online', 'idle', 'dnd', 'invisible'].includes(b.status)) throw bad('Invalid status'); u.status = b.status; }
    if (b.customStatus !== undefined) {
      if (b.customStatus === null || (!b.customStatus.text && !b.customStatus.emoji)) u.customStatus = null;
      else u.customStatus = { emoji: String(b.customStatus.emoji || '').slice(0, 16) || null, text: String(b.customStatus.text || '').slice(0, 128), expiresAt: b.customStatus.expiresAt ? Number(b.customStatus.expiresAt) : null };
    }
    if (b.username !== undefined && b.username.toLowerCase() !== u.username) {
      if (!(await checkPassword(u, b.password))) throw bad('Current password is incorrect', 'password');
      const name = str(b.username, 2, 32, 'Username').toLowerCase();
      if (!/^[a-z0-9_.]+$/.test(name) || /\.\./.test(name)) throw bad('Usernames can only use letters, numbers, underscores and single periods', 'username');
      if (byUsername.has(name) || RESERVED.has(name)) throw bad('That username is taken', 'username');
      const np = nameProblem(name, u); if (np) throw bad(np, 'username');
      byUsername.delete(u.username); byUsername.set(name, u.id); u.username = name;
    }
    if (b.email !== undefined && String(b.email ?? '').trim().toLowerCase() !== (u.email || '')) {
      if (!(await checkPassword(u, b.password))) throw bad('Current password is incorrect', 'password');
      const email = String(b.email ?? '').trim().toLowerCase();
      if (!email) { if (u.email) byEmail.delete(u.email); u.email = null; u.emailVerified = true; }   // removing the address: nothing left to verify
      else {
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad('Enter a valid email address', 'email');
        if (byEmail.has(email)) throw bad('That email is already registered', 'email');
        if (u.email) byEmail.delete(u.email);
        byEmail.set(email, u.id); u.email = email;
        if (verificationMode().enabled) { u.emailVerified = false; emailChanged = true; }   // the new address must be confirmed too
      }
    }
    save();
    emitTo(relatedUserIds(u.id), 'user_update', { user: publicUser(u) });
    emitTo([u.id], 'self_update', { user: selfUser(u) });
    if (b.status !== undefined || b.customStatus !== undefined) broadcastPresence(u.id);
    res.json(selfUser(u));
    if (emailChanged) { issueVerification(u, req); if (isGated(u)) setTimeout(() => closeConns(u.id, 4011, 'email changed'), 50); }   // gated tabs reconnect onto the verify screen
  }));

  r.patch('/me/settings', h(async (req, res) => {
    const u = req.user; const patch = req.body || {};
    const next = { ...(u.settings || {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    if (JSON.stringify(next).length > 120_000) throw bad('Settings are too large');
    u.settings = next; save();
    const origin = [...(conns.get(u.id) || [])].find((c) => c.id === req.headers['x-conn']);
    emitTo([u.id], 'settings_update', { settings: next }, origin);
    res.json(next);
  }));

  r.post('/me/password', limit('pw', 6, 60_000), h(async (req, res) => {
    const { current, password } = req.body || {};
    if (!(await checkPassword(req.user, current))) throw bad('Current password is incorrect', 'password');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw bad('New password must be 8–128 characters', 'new_password');
    Object.assign(req.user, await hashPassword(password));
    await endUserSessions(req.user.id, req.sessionId);   // every other device has to sign in again with the new password
    save(); res.json({ ok: true });
  }));

  r.get('/me/sessions', h(async (req, res) => {
    res.json((await listSessions(req.user.id)).map((s) => ({ id: s.hash.slice(0, 16), ua: s.ua, createdAt: s.createdAt, lastUsed: s.lastUsed, current: s.hash === req.sessionId })).sort((a, b) => b.lastUsed - a.lastUsed));
  }));
  r.delete('/me/sessions/:id', h(async (req, res) => {
    for (const s of await listSessions(req.user.id)) if (s.hash.startsWith(req.params.id) && s.hash !== req.sessionId) await endSession(s.hash);
    res.json({ ok: true });
  }));

  r.delete('/me', limit('delacct', 4, 60_000), h(async (req, res) => {
    const u = req.user;
    if (!(await checkPassword(u, (req.body || {}).password))) throw bad('Password is incorrect', 'password');
    for (const s of Object.values(db.servers)) if (s.ownerId === u.id) deleteServer(s);
    for (const s of Object.values(db.servers)) if (s.members[u.id]) { delete s.members[u.id]; emitTo(serverAudience(s), 'member_remove', { serverId: s.id, userId: u.id }); memberLeft(s, u.id); }
    for (const id of Object.keys(u.rel || {})) { const o = db.users[id]; if (o?.rel) { delete o.rel[u.id]; emitTo([id], 'relationship_update', { id: u.id, type: null }); } }
    await endUserSessions(u.id);
    byUsername.delete(u.username); byEmail.delete(u.email);
    dropUserThemes(u.id);
    Object.assign(u, { deleted: true, username: 'deleted_' + u.id.slice(-8), displayName: 'Deleted User', email: null, hash: null, salt: null, avatar: null, banner: null, bio: '', customStatus: null, rel: {}, settings: {}, themes: [] });
    emitTo(relatedUserIds(u.id), 'user_update', { user: publicUser(u) });
    for (const set of [...(conns.get(u.id) || [])]) set.ws.close(4001, 'deleted');
    save(); res.json({ ok: true });
  }));

  /* --------------------------- users --------------------------- */
  r.get('/users/:id', h(async (req, res) => {
    const u = db.users[req.params.id]; if (!u) throw notFound('Unknown user');
    const mutualServers = Object.values(db.servers).filter((s) => s.members[u.id] && s.members[req.user.id]).map((s) => ({ id: s.id, name: s.name, icon: s.icon, nick: s.members[u.id].nick || null }));
    const mutualFriends = Object.entries(u.rel || {}).filter(([id, t]) => t === 'friend' && req.user.rel?.[id] === 'friend' && id !== req.user.id).map(([id]) => id);
    res.json({ user: publicUser(u), mutualServers, mutualFriends: usersFor(mutualFriends), relationship: req.user.rel?.[u.id] || null });
  }));
  r.get('/users', h(async (req, res) => {
    const q = String(req.query.q || '').toLowerCase().trim(); if (!q) return res.json([]);
    const out = Object.values(db.users).filter((u) => !u.deleted && !u.bot && u.id !== req.user.id && (u.username.includes(q) || u.displayName.toLowerCase().includes(q))).slice(0, 20);
    res.json(out.map(publicUser));
  }));

  /* --------------------------- relationships --------------------------- */
  const setRel = (a, b, ta, tb) => {
    for (const [x, y, t] of [[a, b, ta], [b, a, tb]]) {
      const ux = db.users[x]; ux.rel ||= {};
      if (t) ux.rel[y] = t; else delete ux.rel[y];
      emitTo([x], 'relationship_update', { id: y, type: t || null, user: publicUser(db.users[y]) });
    }
    save();
  };
  r.post('/relationships', limit('friend', 20, 60_000), h(async (req, res) => {
    const name = String((req.body || {}).username || '').trim().toLowerCase().replace(/^@/, '');
    const id = byUsername.get(name); const other = id && db.users[id];
    if (!other || other.deleted) throw notFound('No user with that username');
    if (other.id === req.user.id) throw bad("You can't add yourself");
    if (other.bot) throw bad("Bots can't be friends — just DM them!");
    const mine = req.user.rel?.[other.id]; const theirs = other.rel?.[req.user.id];
    if (theirs === 'blocked') throw forbidden('That user is not accepting friend requests');
    if (mine === 'blocked') throw bad('Unblock this user first');
    if (mine === 'friend') throw bad('You are already friends');
    if (mine === 'outgoing') throw bad('Friend request already sent');
    if (mine === 'incoming') setRel(req.user.id, other.id, 'friend', 'friend');
    else setRel(req.user.id, other.id, 'outgoing', 'incoming');
    res.json({ ok: true, type: req.user.rel[other.id] });
  }));
  r.put('/relationships/:id', h(async (req, res) => {
    const other = db.users[req.params.id]; if (!other) throw notFound('Unknown user');
    if (req.user.rel?.[other.id] !== 'incoming') throw bad('No incoming request from that user');
    setRel(req.user.id, other.id, 'friend', 'friend'); res.json({ ok: true });
  }));
  r.put('/relationships/:id/block', h(async (req, res) => {
    const other = db.users[req.params.id]; if (!other || other.id === req.user.id) throw notFound('Unknown user');
    const theirs = other.rel?.[req.user.id] === 'blocked' ? 'blocked' : null;
    setRel(req.user.id, other.id, 'blocked', theirs); res.json({ ok: true });
  }));
  r.delete('/relationships/:id', h(async (req, res) => {
    const other = db.users[req.params.id]; if (!other) throw notFound('Unknown user');
    const mine = req.user.rel?.[other.id]; if (!mine) throw notFound('No relationship');
    const theirs = other.rel?.[req.user.id];
    setRel(req.user.id, other.id, null, mine === 'blocked' ? theirs : null);
    res.json({ ok: true });
  }));

  /* --------------------------- servers --------------------------- */
  r.post('/servers', limit('mkserver', 10, 60_000), h(async (req, res) => {
    const b = req.body || {};
    if (Object.values(db.servers).filter((s) => s.ownerId === req.user.id).length >= 20) throw bad('You can own at most 20 servers');
    const icon = b.icon ? uploadRef(b.icon) : null; if (icon === undefined) throw bad('Invalid icon');
    const server = createServer(req.user, { name: str(b.name, 2, 100, 'Server name'), icon, template: b.template });
    const orbit = b.orbit ? addOrbit(server) : null;   // "Add Orbit" ticked when the server was made
    emitTo([req.user.id], 'server_create', { server: serverView(server, req.user.id), users: [publicUser(req.user), ...(orbit ? [publicUser(orbit)] : [])] });
    res.json(serverView(server, req.user.id));
  }));

  const findInvite = (code) => db.invites[code] || db.invites[String(code).toLowerCase()];   // a custom link works however it is typed
  r.get('/invites/:code', h(async (req, res) => {
    const inv = findInvite(req.params.code); if (!inv || (inv.expiresAt && inv.expiresAt < Date.now()) || (inv.maxUses && inv.uses >= inv.maxUses && !db.servers[inv.serverId]?.members[req.user.id])) throw notFound('This invite is invalid or has expired');
    const s = db.servers[inv.serverId]; if (!s) throw notFound('This invite is invalid or has expired');
    res.json({ code: inv.code, server: publicServerInfo(s, req.user.id), inviter: publicUser(db.users[inv.inviterId]), joined: !!s.members[req.user.id] });
  }));
  /** The server's swearing protection (Server Settings → Safety, off by default): returns `text` unchanged, censored, or throws, depending on the mode. The owner and administrators are not filtered. */
  function guardText(ch, userId, text) {
    const s = ch?.serverId ? db.servers[ch.serverId] : null; const mode = s?.safety?.profanity;
    if (!s || !text || !mode || mode === 'off') return text;
    if (s.ownerId === userId || can(s, userId, 'ADMINISTRATOR')) return text;
    const words = s.safety.words || [];
    if (!hasProfanity(text, words)) return text;
    if (mode === 'block') throw new ApiError(400, 'That contains language this server doesn’t allow', 'profanity');
    return censor(text, words);
  }
  /** AutoMod (Server Settings → Safety): refuses a message that breaks one of the server's rules, writes it in the audit log, and can time the sender out. */
  function automod(ch, userId, text, opts) {
    const s = ch?.serverId ? db.servers[ch.serverId] : null; const rule = automodRule(s, userId, text, opts); if (!rule) return;
    audit(s, null, 'automod_block', { target: userId, rule, channel: ch.name, excerpt: String(text).slice(0, 120) });
    const m = s.members[userId]; const mins = s.automod.timeout || 0;
    if (mins && m) {
      m.timeoutUntil = Math.max(m.timeoutUntil || 0, Date.now() + mins * 60_000);
      audit(s, null, 'member_timeout', { target: userId, minutes: mins, reason: `AutoMod: ${rule}` }); pushServerUpdate(s); revalidateVoice(s);
    }
    save();
    throw new ApiError(400, `AutoMod blocked your message: this server doesn’t allow ${rule}.${mins ? ` You are timed out for ${mins} minute${mins === 1 ? '' : 's'}.` : ''}`, 'automod');
  }
  /** A role members may give themselves (onboarding) or get from a reaction: never @everyone, and it may not grant anything beyond the default permissions. */
  const pickableRole = (s, rid) => { const r = s.roles.find((x) => x.id === rid); return !!r && r.id !== s.id && r.permissions.every((p) => DEFAULT_PERMS.includes(p)); };
  /** Banned by account, or by browser: a new account from the same browser as someone banned here is turned away too. */
  function isBannedFrom(s, user, req) {
    if (s.bans?.includes(user.id)) return true;
    const banned = s.bannedDevices; if (!banned || !Object.keys(banned).length) return false;
    for (const h of deviceHashesOf(user, requestHashes(req))) if (banned[h] && banned[h] !== user.id) return true;
    return false;
  }
  /** Other accounts that share a browser with `uid` (never the server owner or a co-owner, the moderator acting, or any browser those use). */
  function altAccounts(s, uid, actorId, req) {
    const safe = new Set([...[s.ownerId, ...(s.coOwners || [])].flatMap((id) => [...deviceHashesOf(db.users[id])]), ...deviceHashesOf(db.users[actorId], requestHashes(req))]);
    const mine = deviceHashesOf(db.users[uid]); for (const h of safe) mine.delete(h);
    if (!mine.size) return { alts: [], mine, safe };
    const alts = Object.values(db.users).filter((u) => u.id !== uid && !isOwner(s, u.id) && u.id !== actorId && !u.bot && !u.deleted && [...deviceHashesOf(u)].some((h) => mine.has(h))).map((u) => u.id);
    return { alts, mine, safe };
  }
  r.post('/invites/:code/join', limit('join', 20, 60_000), h(async (req, res) => {
    const code = String(req.params.code).split('/').pop();
    const inv = findInvite(code); if (!inv || (inv.expiresAt && inv.expiresAt < Date.now()) || (inv.maxUses && inv.uses >= inv.maxUses)) throw notFound('This invite is invalid or has expired');
    const s = db.servers[inv.serverId]; if (!s) throw notFound('This invite is invalid or has expired');
    noteDevice(req.user, req);
    if (isBannedFrom(s, req.user, req)) throw forbidden('You are banned from this server');
    if (!s.members[req.user.id] && s.joinMode === 'apply') throw new ApiError(403, 'This server asks people to apply first', 'apply_required');
    if (!s.members[req.user.id]) { joinServer(s, req.user, req); inv.uses++; save(); }
    res.json(serverView(s, req.user.id));
  }));
  /** `user` becomes a member of `s` (an invite, a server tag, or an accepted application — then there is no request of theirs). */
  function joinServer(s, user, req) {
    addMember(s, user);
    linkedTimeout(s, user.id, deviceHashesOf(user, req ? requestHashes(req) : []));   // someone who is timed out here can't dodge it with another account
    save();
    emitTo(serverAudience(s).filter((id) => id !== user.id), 'member_add', { serverId: s.id, member: memberView(user.id, s.members[user.id]), user: publicUser(user) });
    emitTo([user.id], 'server_create', { server: serverView(s, user.id), users: usersFor(Object.keys(s.members)) });
    if (s.systemChannelId) systemMessage(s.systemChannelId, 'join', user.id);
    memberJoined(s, user.id);   // Orbit's welcome message, role for newcomers, member count (server/orbit-plus.js)
  }
  const apps = mountApplications(r, { h, getServer, findInvite, isBannedFrom: (s, user, req) => isBannedFrom(s, user, req || { headers: {} }), joinServer, pushChannelEvent });

  r.patch('/servers/:id', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_SERVER');
    const b = req.body || {};
    if (b.name !== undefined) s.name = str(b.name, 2, 100, 'Server name');
    if (b.description !== undefined) s.description = String(b.description).slice(0, 300);
    if (b.applyQuestion !== undefined) s.applyQuestion = String(b.applyQuestion || '').trim().slice(0, 300);
    if (b.joinMode !== undefined && (b.joinMode === 'apply' ? 'apply' : 'invite') !== (s.joinMode || 'invite')) {   // anyone with an invite, or apply first
      if (b.joinMode === 'apply') { apps.ensureChannel(s, req.user.id); s.joinMode = 'apply'; } else { s.joinMode = 'invite'; apps.acceptAll(s, req.user.id); }   // switching it off lets everyone waiting in
      audit(s, req.user.id, 'join_mode', { mode: s.joinMode });
    }
    for (const k of ['icon', 'banner']) if (b[k] !== undefined) { const v = uploadRef(b[k]); if (v === undefined) throw bad(`Invalid ${k}`); s[k] = v; }
    if (b.accent !== undefined) { if (b.accent !== null && !HEX.test(b.accent)) throw bad('Invalid accent'); s.accent = b.accent; }
    if (b.systemChannelId !== undefined) s.systemChannelId = db.channels[b.systemChannelId]?.serverId === s.id ? b.systemChannelId : null;
    if (b.profanity !== undefined) { if (!['off', 'censor', 'block'].includes(b.profanity)) throw bad('Invalid swearing protection mode'); (s.safety ||= {}).profanity = b.profanity; }
    if (b.blockedWords !== undefined) (s.safety ||= {}).words = cleanBlockedWords(b.blockedWords);
    if (b.automod !== undefined) {   // AutoMod rules (server/automod.js)
      const a = b.automod || {};
      s.automod = { links: !!a.links, invites: a.invites === 'others' ? 'others' : !!a.invites, mentions: clampInt(a.mentions, 0, 50, 0), spam: !!a.spam,
        walls: [500, 1000, 2000].includes(Number(a.walls)) ? Number(a.walls) : 0, timeout: clampInt(a.timeout, 0, 1440, 0) };   // invites: 'others' = only Orata invites allowed
    }
    if (b.onboarding !== undefined) {   // the rules newcomers accept and the roles they can pick (POST /servers/:id/onboarding)
      const o = b.onboarding || {}; const seen = new Set();
      const roles = (Array.isArray(o.roles) ? o.roles : []).slice(0, 20).map((x) => ({ roleId: String(x?.roleId || ''), emoji: String(x?.emoji || '').trim().slice(0, 16) || null, desc: String(x?.desc || '').trim().slice(0, 100) }))
        .filter((x) => pickableRole(s, x.roleId) && !seen.has(x.roleId) && seen.add(x.roleId));
      s.onboarding = { enabled: !!o.enabled, rules: String(o.rules || '').slice(0, 4000), roles };
    }
    audit(s, req.user.id, 'server_update', { fields: Object.keys(b).filter((k) => b[k] !== undefined).slice(0, 12) });
    save(); pushServerUpdate(s); res.json(serverView(s, req.user.id));
  }));
  function deleteServer(s) {
    const aud = serverAudience(s);
    for (const c of channelsOfServer(s.id)) { delete db.channels[c.id]; delete db.messages[c.id]; voice.delete(c.id); }
    for (const [code, inv] of Object.entries(db.invites)) if (inv.serverId === s.id) delete db.invites[code];
    delete db.servers[s.id];
    if (db.users[s.orbitId]) db.users[s.orbitId].deleted = true;   // its own Orbit goes with it
    if (db.defaultServerId === s.id) db.defaultServerId = null;
    emitTo(aud, 'server_delete', { serverId: s.id });
    save();
  }
  r.delete('/servers/:id', h(async (req, res) => {
    const s = getServer(req, req.params.id);
    if (s.ownerId !== req.user.id) throw forbidden('Only the owner can delete a server');
    deleteServer(s); res.json({ ok: true });
  }));
  r.post('/servers/:id/leave', h(async (req, res) => {
    const s = getServer(req, req.params.id);
    if (s.ownerId === req.user.id) throw bad('Transfer ownership or delete the server instead of leaving it');
    delete s.members[req.user.id]; save();
    emitTo([req.user.id], 'server_delete', { serverId: s.id });
    emitTo(serverAudience(s), 'member_remove', { serverId: s.id, userId: req.user.id });
    memberLeft(s, req.user.id);
    res.json({ ok: true });
  }));
  r.post('/servers/:id/transfer', h(async (req, res) => {
    const s = getServer(req, req.params.id);
    if (s.ownerId !== req.user.id) throw forbidden('Only the owner can transfer a server');
    const to = String((req.body || {}).userId); if (!s.members[to] || db.users[to]?.bot) throw bad('Pick a member');
    s.ownerId = to; audit(s, req.user.id, 'server_transfer', { target: to }); save(); pushServerUpdate(s); res.json({ ok: true });
  }));

  /* ---- channels in a server ---- */
  // text and forum channel names: lower case, dashes for spaces, letters, numbers, _ and -, emoji and the │ · ・ people decorate names with
  const EMOJI = '\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}\\u200d\\ufe0f';
  const NAME_JUNK = new RegExp(`[^\\p{L}\\p{N}_\\-│·・${EMOJI}]`, 'gu');
  const channelName = (raw, type, fallback) => (type === 'text' || type === 'forum' ? raw.toLowerCase().replace(/\s+/g, '-').replace(NAME_JUNK, '').slice(0, 100) || fallback : raw);
  /** The emoji a channel shows in place of # (one emoji and nothing else), or null. */
  const channelEmoji = (v) => { const e = String(v || '').trim(); return e.length <= 16 && new RegExp(`^[${EMOJI}]+$`, 'u').test(e) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e) ? e : null; };
  r.post('/servers/:id/channels', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_CHANNELS');
    const b = req.body || {};
    const type = ['text', 'voice', 'stage', 'category', 'forum'].includes(b.type) ? b.type : 'text';
    let name = str(b.name, 1, 100, 'Channel name');
    name = channelName(name, type, 'new-channel'); const emoji = type === 'category' ? null : channelEmoji(b.emoji);
    const siblings = channelsOfServer(s.id);
    if (siblings.length >= 200) throw bad('Too many channels');
    const parentId = b.parentId && db.channels[b.parentId]?.serverId === s.id && db.channels[b.parentId].type === 'category' ? b.parentId : null;
    const position = Math.max(0, ...siblings.filter((c) => (c.parentId || null) === parentId).map((c) => c.position || 0)) + 1;
    const id = newId();
    const ch = { id, serverId: s.id, type, name, ...(emoji ? { emoji } : {}), ...(type === 'forum' ? { tags: sanitizeTags(b.tags), requireTag: !!b.requireTag } : {}), parentId: type === 'category' ? null : parentId, position: type === 'category' ? Math.max(0, ...siblings.filter((c) => c.type === 'category').map((c) => c.position)) + 1 : position, topic: String(b.topic || '').slice(0, 1024) };
    let ows = sanitizeOverwrites(s, b.overwrites);
    if (b.private && !ows.length) ows = sanitizeOverwrites(s, [{ type: 'role', id: s.id, deny: ['VIEW_CHANNEL'] }, ...(Array.isArray(b.allowedRoles) ? b.allowedRoles : []).map((rid) => ({ type: 'role', id: rid, allow: ['VIEW_CHANNEL'] }))]);   // the "Private Channel" shortcut
    if (ows.length) { ch.overwrites = ows; if (ch.parentId) ch.synced = false; }   // a channel with its own rules no longer follows its category
    db.channels[id] = ch;
    if (!canView(req.user.id, ch)) ch.overwrites.push({ type: 'member', id: req.user.id, allow: ['VIEW_CHANNEL'], deny: [] });   // never lock yourself out of what you just made
    db.messages[id] = []; audit(s, req.user.id, 'channel_create', { target: id, name: ch.name, type }); save();
    pushChannelEvent('channel_create', ch);
    res.json(channelView(ch, req.user.id));
  }));
  function pushChannelEvent(op, ch) {
    const s = db.servers[ch.serverId];
    for (const uid of serverAudience(s)) {
      if (op === 'channel_delete' || !listedFor(uid, ch)) emitTo([uid], 'channel_delete', { serverId: s.id, channelId: ch.id });
      else emitTo([uid], op, { channel: channelView(ch, uid) });
    }
  }
  /** People who are in a voice channel they may no longer see or join are moved out of it. */
  function revalidateVoice(s) {
    for (const c of channelsOfServer(s.id)) {
      const room = voice.get(c.id); if (!room) continue;
      for (const uid of [...room.keys()]) {
        if (isVoiceLike(c) && canIn(uid, c, 'CONNECT')) continue;
        for (const cn of conns.get(uid) || []) if (cn.voice === c.id) cn.leaveVoice?.('removed');
      }
      if (isStage(c)) revalidateStage(c);   // whoever lost the right to speak steps down
    }
  }
  const normOverwrites = (list) => JSON.stringify([...list].map((o) => ({ type: o.type, id: o.id, allow: [...o.allow].sort(), deny: [...o.deny].sort() })).sort((a, b) => ((a.type + a.id) < (b.type + b.id) ? -1 : 1)));
  /** You may not hand out permissions you lack, nor change the rules of roles / members at or above your own top role. */
  function guardOverwrites(s, ch, actor, before, next) {
    const mine = permsIn(s, actor.id, ch); const myTop = topRolePos(s, actor.id);
    const key = (o) => `${o.type}:${o.id}`;
    const prev = new Map(before.map((o) => [key(o), o])); const now = new Map(next.map((o) => [key(o), o]));
    for (const k of new Set([...prev.keys(), ...now.keys()])) {
      const a = prev.get(k); const o = now.get(k);
      if (a && o && normOverwrites([a]) === normOverwrites([o])) continue;
      const type = k.slice(0, k.indexOf(':')); const id = k.slice(k.indexOf(':') + 1);
      if (type === 'role') { const role = s.roles.find((x) => x.id === id); if (role && role.id !== s.id && role.position >= myTop) throw forbidden('That role is above yours'); }
      else if (id !== actor.id && (s.ownerId === id || topRolePos(s, id) >= myTop)) throw forbidden('That member is above you');
      for (const p of o?.allow || []) if (!(a?.allow || []).includes(p) && !mine.has(p)) throw forbidden('You can only allow permissions you have yourself');
    }
  }
  /** `{ overwrites }` replaces the list (which unsyncs a synced channel unless nothing changed); `{ synced: true }` re-adopts the category's; `{ synced: false }` detaches with a copy. */
  function applyOverwrites(s, ch, b, actor) {
    if (b.synced === true) {
      if (ch.type === 'category' || !ch.parentId) throw bad('Only a channel inside a category can be synced');
      ch.synced = true; delete ch.overwrites; return;
    }
    const before = overwritesOf(ch);
    const next = b.overwrites !== undefined ? sanitizeOverwrites(s, b.overwrites) : before.map((o) => ({ ...o, allow: [...o.allow], deny: [...o.deny] }));
    if (s.ownerId !== actor.id && !can(s, actor.id, 'ADMINISTRATOR')) guardOverwrites(s, ch, actor, before, next);
    if (isSynced(ch) && b.synced !== false && normOverwrites(next) === normOverwrites(before)) return;
    if (ch.type !== 'category' && ch.parentId) ch.synced = false;
    ch.overwrites = next;
  }
  r.put('/servers/:id/channel-order', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_CHANNELS');
    const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
    for (const it of items) {
      const ch = db.channels[it.id]; if (!ch || ch.serverId !== s.id) continue;
      ch.position = clampInt(it.position, 0, 100000, ch.position);
      if (ch.type === 'category') continue;
      const parentId = it.parentId && db.channels[it.parentId]?.type === 'category' && db.channels[it.parentId].serverId === s.id ? it.parentId : null;
      if ((ch.parentId || null) === parentId) continue;
      ch.parentId = parentId; audit(s, req.user.id, 'channel_update', { target: ch.id, name: ch.name, fields: ['parentId'] });
      revalidateVoice(s);   // a channel that follows its category's permissions may now be hidden from people sitting in it
    }
    save(); pushServerUpdate(s); res.json({ ok: true });
  }));
  r.patch('/channels/:id', h(async (req, res) => {
    const ch = getChannel(req, req.params.id); const b = req.body || {};
    if (ch.type === 'post') {
      const mod = canIn(req.user.id, ch, 'MANAGE_MESSAGES') || canIn(req.user.id, ch, 'MANAGE_CHANNELS'); const mine = ch.ownerId === req.user.id;
      const forum = db.channels[ch.forumId];
      if (b.name !== undefined || b.tagIds !== undefined || b.locked !== undefined) { if (!mine && !mod) throw forbidden(); }
      if (b.pinned !== undefined && !mod) throw forbidden();
      if (b.name !== undefined) ch.name = guardText(ch, req.user.id, str(b.name, 1, 100, 'Title'));
      if (b.tagIds !== undefined) ch.tagIds = (Array.isArray(b.tagIds) ? b.tagIds : []).map(String).filter((tid) => forum?.tags?.some((t) => t.id === tid)).slice(0, 5);
      if (b.locked !== undefined) ch.locked = !!b.locked;
      if (b.pinned !== undefined) ch.pinned = !!b.pinned;
      save(); emitTo(audienceOf(ch), 'post_update', { post: postView(ch) });
      return res.json(channelView(ch, req.user.id));
    }
    if (ch.serverId) {
      const s = db.servers[ch.serverId]; const mine = permsIn(s, req.user.id, ch);
      const touchesPerms = b.overwrites !== undefined || b.synced !== undefined;
      const touchesProps = ['name', 'topic', 'nsfw', 'slowmode', 'parentId', 'tags', 'requireTag', 'emoji'].some((k) => b[k] !== undefined);
      if ((touchesProps || !touchesPerms) && !mine.has('MANAGE_CHANNELS')) throw forbidden();
      if (touchesPerms && !mine.has('MANAGE_ROLES')) throw forbidden();
      if (b.name !== undefined && s.joinMode === 'apply' && s.applicationsChannelId === ch.id && channelName(str(b.name, 1, 100, 'Channel name'), ch.type, ch.name) !== ch.name) throw forbidden('The applications channel can’t be renamed while “Apply to join” is on.');
      if (b.name !== undefined) ch.name = channelName(str(b.name, 1, 100, 'Channel name'), ch.type, ch.name);
      if (b.emoji !== undefined && ch.type !== 'category') { const e = channelEmoji(b.emoji); if (e) ch.emoji = e; else delete ch.emoji; }
      if (b.topic !== undefined) ch.topic = String(b.topic).slice(0, 1024);
      if (b.nsfw !== undefined) ch.nsfw = !!b.nsfw;
      if (ch.type === 'forum') { if (b.tags !== undefined) ch.tags = sanitizeTags(b.tags); if (b.requireTag !== undefined) ch.requireTag = !!b.requireTag; }
      if (b.slowmode !== undefined) ch.slowmode = clampInt(b.slowmode, 0, 21600, 0);
      if (b.parentId !== undefined && ch.type !== 'category') ch.parentId = b.parentId && db.channels[b.parentId]?.type === 'category' && db.channels[b.parentId].serverId === s.id ? b.parentId : null;
      if (touchesPerms) applyOverwrites(s, ch, b, req.user);
      audit(s, req.user.id, 'channel_update', { target: ch.id, name: ch.name, fields: Object.keys(b).filter((k) => b[k] !== undefined).slice(0, 12) });
      save();
      if (touchesPerms || b.parentId !== undefined) { pushServerUpdate(s); revalidateVoice(s); } else pushChannelEvent('channel_update', ch);   // who can see what may have changed for everybody
    } else {
      if (ch.type !== 'group') throw bad('Only group chats can be edited');
      if (b.name !== undefined) ch.name = String(b.name).trim().slice(0, 100) || null;
      if (b.icon !== undefined) { const v = uploadRef(b.icon); if (v === undefined) throw bad('Invalid icon'); ch.icon = v || undefined; }
      save(); emitTo(ch.recipients, 'dm_update', { channel: channelView(ch) });
    }
    res.json(channelView(ch, req.user.id));
  }));
  r.delete('/channels/:id', h(async (req, res) => {
    const ch = getChannel(req, req.params.id);
    if (ch.type === 'post') {
      if (ch.ownerId !== req.user.id && !canIn(req.user.id, ch, 'MANAGE_MESSAGES') && !canIn(req.user.id, ch, 'MANAGE_CHANNELS')) throw forbidden();
      const aud = audienceOf(ch); delete db.channels[ch.id]; delete db.messages[ch.id]; save();
      emitTo(aud, 'post_delete', { serverId: ch.serverId, forumId: ch.forumId, postId: ch.id });
      return res.json({ ok: true });
    }
    if (ch.serverId) {
      const s = db.servers[ch.serverId]; needIn(req.user.id, ch, 'MANAGE_CHANNELS');
      if (s.joinMode === 'apply' && s.applicationsChannelId === ch.id) throw forbidden('The applications channel can’t be deleted while “Apply to join” is on. Turn it off in Server Settings → Invites first.');
      if (channelsOfServer(s.id).filter((c) => c.type === 'text').length <= 1 && ch.type === 'text') throw bad('A server needs at least one text channel');
      if (ch.type === 'category') for (const c of channelsOfServer(s.id)) if (c.parentId === ch.id) c.parentId = null;
      if (ch.type === 'forum') for (const p of channelsOfServer(s.id)) if (p.type === 'post' && p.forumId === ch.id) { delete db.channels[p.id]; delete db.messages[p.id]; }
      delete db.channels[ch.id]; delete db.messages[ch.id]; voice.delete(ch.id);
      audit(s, req.user.id, 'channel_delete', { target: ch.id, name: ch.name });
      if (s.systemChannelId === ch.id) s.systemChannelId = channelsOfServer(s.id).find((c) => c.type === 'text')?.id || null;
      save(); pushChannelEvent('channel_delete', ch); pushServerUpdate(s);
    } else if (ch.type === 'group') {
      leaveGroup(ch, req.user.id);
    } else { // 1:1 DM → just close it for this user
      req.user.closedDms ||= {}; req.user.closedDms[ch.id] = true; save();
      emitTo([req.user.id], 'dm_close', { channelId: ch.id });
    }
    res.json({ ok: true });
  }));

  /* ---- forum channels: a list of posts, each post a small channel of its own ---- */
  const sanitizeTags = (list) => {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).slice(0, 20).map((t) => ({ id: String(t?.id || newId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || newId(), name: String(t?.name || '').trim().slice(0, 20), emoji: String(t?.emoji || '').trim().slice(0, 8) || null }))
      .filter((t) => t.name && !seen.has(t.id) && seen.add(t.id));
  };
  r.get('/channels/:id', h(async (req, res) => { res.json(channelView(getChannel(req, req.params.id), req.user.id)); }));   // deep links to a post
  r.get('/channels/:id/posts', h(async (req, res) => {
    const forum = getChannel(req, req.params.id); if (forum.type !== 'forum') throw bad('That is not a forum');
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100); const tag = String(req.query.tag || '');
    let posts = Object.values(db.channels).filter((c) => c.type === 'post' && c.forumId === forum.id);
    if (tag) posts = posts.filter((p) => (p.tagIds || []).includes(tag));
    if (q) posts = posts.filter((p) => p.name.toLowerCase().includes(q) || String((db.messages[p.id] || [])[0]?.content || '').toLowerCase().includes(q));
    const byNew = req.query.sort === 'new';
    posts.sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((byNew ? b.createdAt - a.createdAt : (b.lastActivity || b.createdAt) - (a.lastActivity || a.createdAt))));
    const offset = clampInt(req.query.offset, 0, 100000, 0); const limitN = clampInt(req.query.limit, 1, 50, 25);
    const slice = posts.slice(offset, offset + limitN);
    res.json({ posts: slice.map(postView), users: usersFor(slice.map((p) => p.ownerId)), total: posts.length, hasMore: offset + limitN < posts.length });
  }));
  r.post('/channels/:id/posts', limit('newpost', 8, 60_000, (req) => req.user.id), h(async (req, res) => {
    const forum = getChannel(req, req.params.id); if (forum.type !== 'forum') throw bad('That is not a forum');
    needIn(req.user.id, forum, 'SEND_MESSAGES');
    const b = req.body || {}; const s = db.servers[forum.serverId];
    const title = guardText(forum, req.user.id, str(b.title, 1, 100, 'Title'));
    automod(forum, req.user.id, `${b.title || ''}\n${b.content || ''}`, { host: req.get('host') });
    const content = guardText(forum, req.user.id, typeof b.content === 'string' ? b.content : '');
    if (content.length > 4000) throw bad('The post is too long (4000 characters max)');
    await Promise.all((Array.isArray(b.attachments) ? b.attachments.slice(0, 10) : []).map((a) => restoreUpload(path.basename(String(a?.url || '')))));
    let attachments = sanitizeAttachments(b.attachments, fs, path, UPLOAD_DIR);
    if (attachments.length && !canIn(req.user.id, forum, 'ATTACH_FILES')) attachments = [];
    if (!content.trim() && !attachments.length) throw bad('Write something in your post');
    const tagIds = (Array.isArray(b.tags) ? b.tags : []).map(String).filter((tid) => forum.tags?.some((t) => t.id === tid)).slice(0, 5);
    if (forum.requireTag && !tagIds.length) throw bad('Pick at least one tag for your post', 'tags');
    const id = newId(); const now = Date.now();
    const post = db.channels[id] = { id, serverId: s.id, type: 'post', forumId: forum.id, name: title, ownerId: req.user.id, createdAt: now, lastActivity: now, tagIds, locked: false, pinned: false };
    db.messages[id] = []; save();
    emitTo(audienceOf(forum), 'post_create', { post: postView(post), users: [publicUser(req.user)] });
    const msg = postMessage(post, req.user.id, { content, attachments });
    res.json({ post: channelView(post, req.user.id), message: messageView(msg) });
  }));

  /* ---- DMs ---- */
  r.post('/dms', limit('dm', 30, 60_000), h(async (req, res) => {
    const b = req.body || {};
    const ids = [...new Set((b.recipientIds || (b.recipientId ? [b.recipientId] : [])).map(String))].filter((id) => id !== req.user.id);
    if (!ids.length) throw bad('Pick at least one person');
    if (ids.length > 9) throw bad('Group chats are limited to 10 people');
    for (const id of ids) {
      const o = db.users[id]; if (!o || o.deleted) throw notFound('Unknown user');
      if (o.rel?.[req.user.id] === 'blocked') throw forbidden('You can’t message that user');
      const shares = o.bot || req.user.rel?.[id] === 'friend' || Object.values(db.servers).some((s) => s.members[id] && s.members[req.user.id]);
      if (!shares) throw forbidden('You can only message friends or people who share a server with you');
    }
    let ch;
    if (ids.length === 1) {
      ch = Object.values(db.channels).find((c) => c.type === 'dm' && c.recipients.includes(req.user.id) && c.recipients.includes(ids[0]));
      if (ch && req.user.closedDms?.[ch.id]) { delete req.user.closedDms[ch.id]; save(); }
    }
    if (!ch) {
      const id = newId(); const recipients = [req.user.id, ...ids];
      ch = { id, serverId: null, type: ids.length === 1 ? 'dm' : 'group', recipients, ownerId: ids.length > 1 ? req.user.id : undefined, name: ids.length > 1 ? (String(b.name || '').trim().slice(0, 100) || null) : null, createdAt: Date.now() };
      db.channels[id] = ch; db.messages[id] = []; save();
      emitTo(recipients, 'dm_create', { channel: channelView(ch), users: usersFor(recipients) });
      if (ch.type === 'group') systemMessage(id, 'group_create', req.user.id);
    } else emitTo([req.user.id], 'dm_open', { channel: channelView(ch), users: usersFor(ch.recipients) });
    res.json(channelView(ch));
  }));
  function leaveGroup(ch, userId) {
    ch.recipients = ch.recipients.filter((id) => id !== userId);
    emitTo([userId], 'dm_close', { channelId: ch.id });
    if (!ch.recipients.length) { delete db.channels[ch.id]; delete db.messages[ch.id]; }
    else { if (ch.ownerId === userId) ch.ownerId = ch.recipients[0]; systemMessage(ch.id, 'recipient_remove', userId); emitTo(ch.recipients, 'dm_update', { channel: channelView(ch) }); }
    save();
  }
  r.put('/channels/:id/recipients/:uid', h(async (req, res) => {
    const ch = getChannel(req, req.params.id); if (ch.serverId || !['group', 'dm'].includes(ch.type)) throw bad('Not a group chat');
    const o = db.users[req.params.uid]; if (!o || o.bot) throw notFound('Unknown user');
    if (ch.recipients.includes(o.id)) throw bad('Already in this chat');
    if (ch.recipients.length >= 10) throw bad('Group chats are limited to 10 people');
    if (req.user.rel?.[o.id] !== 'friend') throw forbidden('You can only add friends');
    if (ch.type === 'dm') { // upgrade to a new group so the 1:1 history stays untouched
      const id = newId(); const recipients = [...ch.recipients, o.id];
      const g = { id, serverId: null, type: 'group', recipients, ownerId: req.user.id, name: null, createdAt: Date.now() };
      db.channels[id] = g; db.messages[id] = []; save();
      emitTo(recipients, 'dm_create', { channel: channelView(g), users: usersFor(recipients) });
      systemMessage(id, 'group_create', req.user.id);
      return res.json(channelView(g));
    }
    ch.recipients.push(o.id); save();
    emitTo(ch.recipients, 'dm_update', { channel: channelView(ch), users: usersFor(ch.recipients) });
    emitTo([o.id], 'dm_create', { channel: channelView(ch), users: usersFor(ch.recipients) });
    systemMessage(ch.id, 'recipient_add', req.user.id, o.id);
    res.json(channelView(ch));
  }));
  r.delete('/channels/:id/recipients/:uid', h(async (req, res) => {
    const ch = getChannel(req, req.params.id); if (ch.type !== 'group') throw bad('Not a group chat');
    const uid = req.params.uid;
    if (uid !== req.user.id && ch.ownerId !== req.user.id) throw forbidden('Only the group owner can remove people');
    if (!ch.recipients.includes(uid)) throw notFound('Not in this chat');
    leaveGroup(ch, uid); res.json({ ok: true });
  }));

  /* ---- invites ---- */
  r.post('/servers/:id/invites', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'CREATE_INVITE');
    const b = req.body || {};
    const code = randomCode(8);
    const maxAge = clampInt(b.maxAge, 0, 604800, 0); const maxUses = clampInt(b.maxUses, 0, 1000, 0);
    db.invites[code] = { code, serverId: s.id, inviterId: req.user.id, createdAt: Date.now(), uses: 0, maxUses, expiresAt: maxAge ? Date.now() + maxAge * 1000 : null };
    audit(s, req.user.id, 'invite_create', { code }); save(); res.json(db.invites[code]);
  }));
  r.get('/servers/:id/invites', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_SERVER');
    res.json(Object.values(db.invites).filter((i) => i.serverId === s.id && !i.vanity && (!i.expiresAt || i.expiresAt > Date.now())));   // the custom link has its own section
  }));
  r.delete('/invites/:code', h(async (req, res) => {
    const inv = db.invites[req.params.code]; if (!inv) throw notFound();
    const s = db.servers[inv.serverId]; if (!s || (inv.inviterId !== req.user.id && !can(s, req.user.id, 'MANAGE_SERVER'))) throw forbidden();
    if (inv.vanity) throw forbidden('The custom invite link can only be changed in Server Settings → Invites');
    delete db.invites[inv.code]; audit(s, req.user.id, 'invite_delete', { code: inv.code }); save(); res.json({ ok: true });
  }));

  /* ---- a server's custom invite link (<site>/invite/<name>): one per server, set by admins, changeable once every 7 days ---- */
  const VANITY = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/; const VANITY_WAIT = 7 * 86400_000;
  r.put('/servers/:id/vanity', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'ADMINISTRATOR');
    const code = String(req.body?.code || '').trim().toLowerCase();
    if (!VANITY.test(code)) throw bad('Use 3–32 letters, numbers or dashes (not at the start or end)', 'code');
    if (code === s.vanity?.code) return res.json(s.vanity);
    const left = (s.vanity?.changedAt || 0) + VANITY_WAIT - Date.now();
    if (left > 0) throw new ApiError(429, `The custom link can be changed once every 7 days. Try again in ${formatDuration(left)}.`, 'vanity_wait');
    // one person, one server with a custom link: "a person" is every account used in the same browser (the browser id kept for bans)
    const mine = deviceHashesOf(req.user, requestHashes(req));
    const other = Object.values(db.servers).find((t) => t.id !== s.id && t.vanity && (() => {
      const by = db.users[t.vanity.by || db.invites[t.vanity.code]?.inviterId];
      return by && (by.id === req.user.id || [...deviceHashesOf(by)].some((x) => mine.has(x)));
    })());
    if (other) throw new ApiError(403, `You already set a custom invite link for ${other.name}. Each person can have one server with a custom link.`, 'vanity_limit');
    if (Object.keys(db.invites).some((k) => k.toLowerCase() === code)) throw bad('That link is already taken', 'code');
    if (db.invites[s.vanity?.code]?.vanity) delete db.invites[s.vanity.code];   // the old link stops working
    db.invites[code] = { code, serverId: s.id, inviterId: req.user.id, createdAt: Date.now(), uses: 0, maxUses: 0, expiresAt: null, vanity: true };
    audit(s, req.user.id, 'vanity_update', { code, old: s.vanity?.code || null });
    s.vanity = { code, changedAt: Date.now(), by: req.user.id };
    save(); pushServerUpdate(s); res.json(s.vanity);
  }));

  /* ---- a server's tag: 1–5 letters or numbers with an icon and a color, worn by members next to their name; set by admins, changeable once a week ---- */
  const TAG = /^[A-Za-z0-9]{1,5}$/; const TAG_ICON = /^[a-z0-9-]{1,24}$/; const TAG_WAIT = 7 * 86400_000;
  r.put('/servers/:id/tag', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'ADMINISTRATOR');
    const b = req.body || {}; const text = String(b.text || '').trim();
    if (!TAG.test(text)) throw bad('A server tag is 1–5 letters or numbers', 'text');
    if (!TAG_ICON.test(String(b.icon || ''))) throw bad('Pick an icon for the tag');
    if (!HEX.test(String(b.color || ''))) throw bad('Pick a color for the tag');
    const next = { text, icon: b.icon, color: b.color.toLowerCase() };
    if (s.tag && next.text === s.tag.text && next.icon === s.tag.icon && next.color === s.tag.color) return res.json(s.tag);
    const left = (s.tag?.changedAt || 0) + TAG_WAIT - Date.now();
    if (left > 0) throw new ApiError(429, `The server tag can be changed once a week. Try again in ${formatDuration(left)}.`, 'tag_wait');
    audit(s, req.user.id, 'tag_update', { text, old: s.tag?.text || null });
    s.tag = { ...next, changedAt: Date.now(), by: req.user.id };
    save(); pushServerUpdate(s);
    for (const u of Object.values(db.users)) if (u.tagServer === s.id && s.members[u.id]) emitTo(relatedUserIds(u.id), 'user_update', { user: publicUser(u) });   // everyone wearing it shows the new one
    res.json(s.tag);
  }));

  /* ---- custom emoji & stickers (a server's "expressions") ---- */
  const EXPR_MAX = { emojis: 50, stickers: 30 }; const EXPR_BYTES = 512 * 1024;
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  /** An uploaded picture that is really a small PNG / JPEG / GIF / WebP; says whether it moves. */
  async function expressionFile(url) {
    const ref = uploadRef(url); if (!ref) throw bad('Upload the image first');
    const base = path.basename(ref); await restoreUpload(base);   // after a restart the file may only be in the database
    const file = path.join(UPLOAD_DIR, base); let st; try { st = fs.statSync(file); } catch { throw bad('That upload was not found'); }
    if (st.size > EXPR_BYTES) throw bad('Images must be under 512 KB');
    const head = Buffer.alloc(32); const fd = fs.openSync(file, 'r'); try { fs.readSync(fd, head, 0, 32, 0); } finally { fs.closeSync(fd); }
    const kind = head.subarray(0, 8).equals(PNG_SIG) ? 'png' : (head[0] === 0xff && head[1] === 0xd8) ? 'jpeg' : head.subarray(0, 3).toString('latin1') === 'GIF' ? 'gif'
      : (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') ? 'webp' : null;
    if (!kind) throw bad('Use a PNG, JPEG, GIF or WebP image');
    const animated = kind === 'gif' || (kind === 'webp' && head.subarray(12, 16).toString('latin1') === 'VP8X' && (head[20] & 2) !== 0);
    return { url: ref, animated };
  }
  const exprName = (v, kind, list, selfId) => {
    const name = String(v ?? '').trim();
    if (kind === 'emojis' ? !/^[A-Za-z0-9_]{2,32}$/.test(name) : (name.length < 2 || name.length > 30)) throw bad(kind === 'emojis' ? 'Emoji names are 2–32 letters, numbers or underscores' : 'Sticker names are 2–30 characters', 'name');
    if (list.some((x) => x.id !== selfId && x.name.toLowerCase() === name.toLowerCase())) throw bad('Something here already has that name', 'name');
    return name;
  };
  for (const kind of ['emojis', 'stickers']) {
    r.post(`/servers/:id/${kind}`, limit(`expr-${kind}`, 40, 60_000, (req) => req.user.id), h(async (req, res) => {
      const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_EXPRESSIONS');
      const b = req.body || {}; const list = (s[kind] ||= []);
      if (list.length >= EXPR_MAX[kind]) throw bad(`This server can have at most ${EXPR_MAX[kind]} ${kind}`);
      const name = exprName(b.name, kind, list); const file = await expressionFile(b.url);
      const item = { id: newId(), name, url: file.url, animated: file.animated, by: req.user.id, at: Date.now() };
      if (kind === 'stickers') item.description = String(b.description || '').trim().slice(0, 100);
      list.push(item); save(); pushServerUpdate(s); res.json(item);
    }));
    r.patch(`/servers/:id/${kind}/:eid`, h(async (req, res) => {
      const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_EXPRESSIONS');
      const list = s[kind] || []; const item = list.find((x) => x.id === req.params.eid); if (!item) throw notFound('Unknown ' + kind.slice(0, -1));
      const b = req.body || {};
      if (b.name !== undefined) item.name = exprName(b.name, kind, list, item.id);
      if (kind === 'stickers' && b.description !== undefined) item.description = String(b.description || '').trim().slice(0, 100);
      save(); pushServerUpdate(s); res.json(item);
    }));
    r.delete(`/servers/:id/${kind}/:eid`, h(async (req, res) => {
      const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_EXPRESSIONS');
      s[kind] = (s[kind] || []).filter((x) => x.id !== req.params.eid); save(); pushServerUpdate(s); res.json({ ok: true });   // messages that used it keep showing it (they carry the picture)
    }));
  }
  /** `{ serverId, id }` from the sticker picker → the sticker as it is stored in a message (only from servers the sender is in). */
  function serverSticker(ref, userId) {
    const s = db.servers[String(ref?.serverId)]; if (!s || !s.members[userId]) return null;
    const st = s.stickers?.find((x) => x.id === String(ref.id)); if (!st) return null;
    return { id: 's:' + st.id, title: st.name, url: st.url, w: 160, h: 160, kind: 'sticker', custom: true, serverId: s.id, animated: !!st.animated };
  }

  /* ---- roles & members ---- */
  const roleView = (s, id) => s.roles.find((r) => r.id === id);
  r.post('/servers/:id/roles', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_ROLES');
    const b = req.body || {};
    if (s.roles.length >= 50) throw bad('Too many roles');
    const perms = (Array.isArray(b.permissions) ? b.permissions : []).filter((p) => PERMS.includes(p));
    const role = { id: newId(), name: str(b.name || 'new role', 1, 100, 'Role name'), color: HEX.test(b.color) ? b.color : null, position: Math.max(...s.roles.map((r) => r.position)) + 1, permissions: perms, hoist: !!b.hoist };
    if (topRolePos(s, req.user.id) <= role.position && s.ownerId !== req.user.id) role.position = Math.max(1, topRolePos(s, req.user.id) - 1);
    s.roles.push(role); audit(s, req.user.id, 'role_create', { target: role.id, name: role.name }); save(); pushServerUpdate(s); res.json(role);
  }));
  r.patch('/servers/:id/roles/:rid', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_ROLES');
    const role = roleView(s, req.params.rid); if (!role) throw notFound('Unknown role');
    if (role.id !== s.id && s.ownerId !== req.user.id && role.position >= topRolePos(s, req.user.id)) throw forbidden('That role is above yours');
    const b = req.body || {};
    if (b.name !== undefined && role.id !== s.id) role.name = str(b.name, 1, 100, 'Role name');
    if (b.color !== undefined) role.color = HEX.test(b.color) ? b.color : null;
    if (b.hoist !== undefined) role.hoist = !!b.hoist;
    if (b.position !== undefined && role.id !== s.id) role.position = clampInt(b.position, 1, 1000, role.position);
    if (b.permissions !== undefined) {
      const wanted = (Array.isArray(b.permissions) ? b.permissions : []).filter((p) => PERMS.includes(p));
      if (s.ownerId !== req.user.id) { const mine = permsOf(s, req.user.id); if (wanted.some((p) => !mine.has(p))) throw forbidden('You can only grant permissions you have'); }
      role.permissions = wanted;
    }
    audit(s, req.user.id, 'role_update', { target: role.id, name: role.name, fields: Object.keys(b).filter((k) => b[k] !== undefined).slice(0, 8) });
    save(); pushServerUpdate(s); res.json(role);
  }));
  r.delete('/servers/:id/roles/:rid', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_ROLES');
    const role = roleView(s, req.params.rid); if (!role || role.id === s.id) throw notFound('Unknown role');
    if (s.ownerId !== req.user.id && role.position >= topRolePos(s, req.user.id)) throw forbidden('That role is above yours');
    s.roles = s.roles.filter((r) => r.id !== role.id);
    for (const m of Object.values(s.members)) m.roles = m.roles.filter((x) => x !== role.id);
    for (const c of channelsOfServer(s.id)) if (c.overwrites) c.overwrites = c.overwrites.filter((o) => !(o.type === 'role' && o.id === role.id));
    audit(s, req.user.id, 'role_delete', { target: role.id, name: role.name });
    save(); pushServerUpdate(s); res.json({ ok: true });
  }));
  const memberRole = (add) => h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_ROLES');
    const m = s.members[req.params.uid]; const role = roleView(s, req.params.rid);
    if (!m || !role || role.id === s.id) throw notFound();
    if (s.ownerId !== req.user.id && role.position >= topRolePos(s, req.user.id)) throw forbidden('That role is above yours');
    if (add !== m.roles.includes(role.id)) audit(s, req.user.id, add ? 'member_role_add' : 'member_role_remove', { target: req.params.uid, role: role.name });
    m.roles = add ? [...new Set([...m.roles, role.id])] : m.roles.filter((x) => x !== role.id);
    save(); pushServerUpdate(s); res.json({ ok: true });
  });
  r.put('/servers/:id/members/:uid/roles/:rid', memberRole(true));
  r.delete('/servers/:id/members/:uid/roles/:rid', memberRole(false));

  r.patch('/servers/:id/members/:uid', h(async (req, res) => {
    const s = getServer(req, req.params.id); const m = s.members[req.params.uid]; if (!m) throw notFound('Unknown member');
    const self = req.params.uid === req.user.id;
    need(s, req.user.id, self ? 'CHANGE_NICKNAME' : 'MANAGE_NICKNAMES');
    const nick = String((req.body || {}).nick || '').trim().slice(0, 32);
    m.nick = nick || null; if (!self) audit(s, req.user.id, 'member_nick', { target: req.params.uid, nick: m.nick }); save();
    emitTo(serverAudience(s), 'member_update', { serverId: s.id, member: memberView(req.params.uid, m) });
    res.json({ ok: true });
  }));
  const removeMember = (s, uid, ban) => {
    delete s.members[uid]; if (ban) { s.bans ||= []; if (!s.bans.includes(uid)) s.bans.push(uid); }
    save();
    emitTo([uid], 'server_delete', { serverId: s.id });
    emitTo(serverAudience(s), 'member_remove', { serverId: s.id, userId: uid });
    memberLeft(s, uid);
    for (const set of [...(conns.get(uid) || [])]) if (set.voice && db.channels[set.voice]?.serverId === s.id) set.leaveVoice?.('kicked');
  };
  mountStaff(r, { h, limit, removeMember });   // reports, and the Staff page (server/staff.js)
  // kick, ban and timeout are shared by their routes and Orbit's /kick, /ban and /timeout (server/orbit.js): req.user is the moderator
  function kickMember(req, s, uid, reason = '') {
    need(s, req.user.id, 'KICK_MEMBERS');
    if (!s.members[uid]) throw notFound('Unknown member');
    if (uid === s.ownerId || uid === req.user.id) throw forbidden('You can’t kick that member');
    if (topRolePos(s, req.user.id) <= topRolePos(s, uid)) throw forbidden('That member is above you');
    audit(s, req.user.id, 'member_kick', { target: uid, reason });
    removeMember(s, uid, false);
  }
  r.delete('/servers/:id/members/:uid', h(async (req, res) => {
    kickMember(req, getServer(req, req.params.id), req.params.uid); res.json({ ok: true });
  }));
  /** The other accounts on the browser(s) of `uid` that a ban would take with them (never the server's owners or anyone ranked above you). */
  function bannableAlts(req, s, uid) {
    const { alts, safe } = altAccounts(s, uid, req.user.id, req);
    return { alts: alts.filter((id) => !(s.members[id] && topRolePos(s, req.user.id) <= topRolePos(s, id))), safe };
  }
  // the ban dialog shows them before you ban (accounts only: the browser ids themselves are never shown)
  r.get('/servers/:id/bans/:uid/alts', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'BAN_MEMBERS');
    if (!db.users[req.params.uid]) throw notFound('Unknown user');
    res.json({ alts: bannableAlts(req, s, req.params.uid).alts.map((id) => publicUser(db.users[id])) });
  }));
  r.put('/servers/:id/bans/:uid', h(async (req, res) => {
    const alts = banMember(req, getServer(req, req.params.id), req.params.uid, req.body || {});
    res.json({ ok: true, alts: alts.map((id) => ({ id, displayName: db.users[id].displayName })) });
  }));
  /** Bans `uid` (with { reason, deleteHours, deleteAll, alts }); returns the ids of the alt accounts banned along with them. */
  function banMember(req, s, uid, b = {}) {
    need(s, req.user.id, 'BAN_MEMBERS');
    if (!db.users[uid]) throw notFound('Unknown user');
    if (uid === s.ownerId || uid === req.user.id) throw forbidden('You can’t ban that member');
    if (s.members[uid] && topRolePos(s, req.user.id) <= topRolePos(s, uid)) throw forbidden('That member is above you');
    // remember why and by whom, and which browsers the person used — they can't come back with another account from those,
    // and the accounts they already have on them (their alts) are banned along with them
    s.banInfo ||= {}; s.bannedDevices ||= {}; s.bans ||= [];
    const { alts: found, safe } = bannableAlts(req, s, uid);
    const alts = b.alts === false ? [] : found;
    const hours = b.deleteAll ? Infinity : clampInt(b.deleteHours, 0, 168, 0); const reason = String(b.reason || '').trim().slice(0, 200); const at = Date.now();   // deleteAll: everything they ever posted here
    for (const target of [uid, ...alts]) {
      s.banInfo[target] = { reason: target === uid ? reason : `Alt of ${db.users[uid].displayName}${reason ? ` — ${reason}` : ''}`.slice(0, 200), by: req.user.id, at, ...(target === uid ? {} : { altOf: uid }) };
      for (const h of deviceHashesOf(db.users[target])) if (!safe.has(h)) s.bannedDevices[h] = uid;
      if (s.members[target]) removeMember(s, target, true); else if (!s.bans.includes(target)) s.bans.push(target);
      purgeMessages(s, target, hours);
    }
    audit(s, req.user.id, 'member_ban', { target: uid, reason, ...(alts.length ? { alts: alts.length } : {}) });
    save();
    return alts;
  }
  /** Deletes what a person posted in this server during the last `hours` hours (0 = nothing, Infinity = all of it). */
  function purgeMessages(s, uid, hours) {
    if (!hours) return;
    const cutoff = Date.now() - hours * 3600_000;
    for (const c of channelsOfServer(s.id)) {
      const list = db.messages[c.id]; if (!list?.length) continue;
      const gone = list.filter((m) => m.authorId === uid && m.createdAt >= cutoff && (!m.type || m.type === 'default'));
      if (!gone.length) continue;
      db.messages[c.id] = list.filter((m) => !gone.includes(m));
      for (const m of gone) emitTo(audienceOf(c), 'message_delete', { channelId: c.id, messageId: m.id });
      messagesDeleted(c, gone.map((m) => m.id));
    }
    save();
  }
  r.get('/servers/:id/bans', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'BAN_MEMBERS');
    const deviceBanned = new Set(Object.values(s.bannedDevices || {}));
    res.json((s.bans || []).map((id) => {
      const u = publicUser(db.users[id]); if (!u) return null; const info = s.banInfo?.[id] || {};
      return { ...u, ban: { reason: info.reason || '', by: info.by ? (db.users[info.by]?.displayName || null) : null, at: info.at || null, deviceBanned: deviceBanned.has(id) || !!info.altOf, altOf: info.altOf ? (db.users[info.altOf]?.displayName || null) : null } };
    }).filter(Boolean));
  }));
  r.delete('/servers/:id/bans/:uid', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'BAN_MEMBERS');
    const uid = req.params.uid; const info = s.banInfo?.[uid];
    // unbanning the person frees their alts too; unbanning one alt on its own frees just what only that account used
    const targets = [uid, ...Object.entries(s.banInfo || {}).filter(([, i]) => i.altOf === uid).map(([id]) => id)];
    for (const t of targets) { s.bans = (s.bans || []).filter((id) => id !== t); if (s.banInfo) delete s.banInfo[t]; }
    for (const [h, id] of Object.entries(s.bannedDevices || {})) if (id === uid) delete s.bannedDevices[h];   // their browsers are free again
    if (info?.altOf) { const main = deviceHashesOf(db.users[info.altOf]); for (const h of deviceHashesOf(db.users[uid])) if (!main.has(h) && s.bannedDevices?.[h] === info.altOf) delete s.bannedDevices[h]; }
    audit(s, req.user.id, 'member_unban', { target: uid }); save(); res.json({ ok: true, freed: targets.length - 1 });
  }));

  /* ---- audit log: who did what (moderators' actions and AutoMod), for people who can manage the server ---- */
  r.get('/servers/:id/audit-log', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_SERVER');
    const kinds = String(req.query.action || '').split(',').filter(Boolean);
    let list = (s.auditLog || []).filter((e) => !kinds.length || kinds.some((k) => e.action.startsWith(k)));
    if (req.query.before) { const i = list.findIndex((e) => e.id === String(req.query.before)); if (i >= 0) list = list.slice(i + 1); }
    const page = list.slice(0, 50);
    res.json({ entries: page, users: usersFor(page.flatMap((e) => [e.actorId, e.target]).filter((id) => id && db.users[id])), hasMore: list.length > 50 });
  }));

  /* ---- onboarding: a newcomer accepts the rules and picks roles before they can talk; anyone can come back and change their picks ---- */
  r.post('/servers/:id/onboarding', h(async (req, res) => {
    const s = getServer(req, req.params.id); const m = s.members[req.user.id]; const ob = s.onboarding;
    if (!ob?.enabled) throw bad('This server has no rules screen');
    const offered = new Set((ob.roles || []).map((x) => x.roleId).filter((id) => pickableRole(s, id)));
    const want = new Set((Array.isArray(req.body?.roles) ? req.body.roles : []).map(String).filter((id) => offered.has(id)));
    m.roles = [...m.roles.filter((id) => !offered.has(id)), ...want]; delete m.pending;
    save(); pushServerUpdate(s); res.json({ ok: true });
  }));

  /* ---- timeouts: a member can read but not talk, react or join voice until it runs out ---- */
  r.put('/servers/:id/members/:uid/timeout', h(async (req, res) => {
    res.json({ ok: true, ...timeoutMember(req, getServer(req, req.params.id), req.params.uid, (req.body || {}).minutes) });
  }));
  /** Times `uid` out for `minutes` (0 lifts it), along with their alts; returns { timeoutUntil, alts } (how many alts). */
  function timeoutMember(req, s, uid, minutesIn, reason = '') {
    need(s, req.user.id, 'MODERATE_MEMBERS');
    const m = s.members[uid]; if (!m) throw notFound('Unknown member');
    if (uid === s.ownerId || uid === req.user.id || can(s, uid, 'ADMINISTRATOR')) throw forbidden('You can’t time out that member');
    if (topRolePos(s, req.user.id) <= topRolePos(s, uid)) throw forbidden('That member is above you');
    const minutes = clampInt(minutesIn, 0, 28 * 24 * 60, 0);
    const until = minutes ? Date.now() + minutes * 60_000 : 0;
    const { alts, mine } = altAccounts(s, uid, req.user.id, req);
    const apply = (id, by) => { const mm = s.members[id]; if (!mm) return false; if (until) { mm.timeoutUntil = until; if (by) mm.timeoutAlt = by; } else { delete mm.timeoutUntil; delete mm.timeoutAlt; } return true; };
    apply(uid, null);
    s.timeoutLinks = (s.timeoutLinks || []).filter((l) => l.uid !== uid && l.until > Date.now());
    let hit = 0;
    if (until) {
      for (const id of alts) { if (id === s.ownerId || can(s, id, 'ADMINISTRATOR') || (s.members[id] && topRolePos(s, req.user.id) <= topRolePos(s, id))) continue; if (apply(id, uid)) hit++; }
      if (mine.size) s.timeoutLinks.push({ uid, until, hashes: [...mine] });   // an account made (or joined) later on the same browser gets it too
    } else { for (const [id, mm] of Object.entries(s.members)) if (mm.timeoutAlt === uid) { apply(id, null); hit++; } }
    audit(s, req.user.id, minutes ? 'member_timeout' : 'member_timeout_remove', { target: uid, reason, ...(minutes ? { minutes } : {}) });
    save(); pushServerUpdate(s); revalidateVoice(s);
    return { timeoutUntil: m.timeoutUntil || null, alts: hit };
  }
  /** A new member whose browser matches someone currently timed out here is timed out for the rest of that time. */
  function linkedTimeout(s, userId, hashes) {
    const now = Date.now(); s.timeoutLinks = (s.timeoutLinks || []).filter((l) => l.until > now);
    const m = s.members[userId]; if (!m || isOwner(s, userId)) return;
    for (const l of s.timeoutLinks) if (l.uid !== userId && l.hashes.some((h) => hashes.has(h)) && (m.timeoutUntil || 0) < l.until) { m.timeoutUntil = l.until; m.timeoutAlt = l.uid; }
  }

  /* --------------------------- messages --------------------------- */
  r.get('/channels/:id/messages', h(async (req, res) => {
    const ch = getChannel(req, req.params.id);
    if (ch.type === 'voice' || ch.type === 'stage' || ch.type === 'category' || ch.type === 'forum') return res.json({ messages: [], users: [], hasMore: false });
    const list = db.messages[ch.id] || [];
    const limitN = clampInt(req.query.limit, 1, 100, 50);
    let slice; let hasMore = false;
    const { before, after, around } = req.query;
    if (around) {
      const i = Math.max(0, list.findIndex((m) => m.id === String(around)));
      const start = Math.max(0, i - Math.floor(limitN / 2));
      slice = list.slice(start, start + limitN); hasMore = start > 0;
    } else if (after) {
      const i = list.findIndex((m) => cmpId(m.id, String(after)) > 0);
      slice = i < 0 ? [] : list.slice(i, i + limitN);
    } else if (before) {
      let i = list.findIndex((m) => cmpId(m.id, String(before)) >= 0); if (i < 0) i = list.length;
      slice = list.slice(Math.max(0, i - limitN), i); hasMore = i - limitN > 0;
    } else { slice = list.slice(-limitN); hasMore = list.length > limitN; }
    const ids = new Set();
    for (const m of slice) { ids.add(m.authorId); for (const u of m.mentions || []) ids.add(u); if (m.type === 'recipient_add' && m.content) ids.add(m.content); }
    res.json({ messages: slice.map(messageView), users: usersFor([...ids]), hasMore });
  }));

  r.post('/channels/:id/messages', limit('msg', 12, 6000, (req) => req.user.id), h(async (req, res) => {
    const ch = getChannel(req, req.params.id); noteSite(ch.id, baseUrl(req));   // a Discord-linked channel learns Orata's address for pictures
    if (ch.type === 'voice' && !ch.serverId) throw bad('Cannot post here');
    if (ch.type === 'category') throw bad('Cannot post to a category');
    if (ch.type === 'stage') throw bad('A stage has no messages — it is for talking');
    if (ch.type === 'forum') throw bad('Start a post instead — a forum has no messages of its own', 'forum');
    if (ch.type === 'post' && ch.locked && !canIn(req.user.id, ch, 'MANAGE_MESSAGES') && ch.ownerId !== req.user.id) throw forbidden('This post is locked');
    const server = ch.serverId ? db.servers[ch.serverId] : null;
    if (server) needIn(req.user.id, ch, 'SEND_MESSAGES');
    if (!server && ch.type === 'dm') {
      const other = db.users[ch.recipients.find((id) => id !== req.user.id)];
      if (other?.rel?.[req.user.id] === 'blocked' || req.user.rel?.[other?.id] === 'blocked') throw forbidden('You can’t send messages to this user');
    }
    const b = req.body || {};
    if (server && ch.slowmode && !canIn(req.user.id, ch, 'MANAGE_MESSAGES')) {
      const last = [...(db.messages[ch.id] || [])].reverse().find((m) => m.authorId === req.user.id);
      if (last && Date.now() - last.createdAt < ch.slowmode * 1000) throw new ApiError(429, `Slowmode is on — wait ${Math.ceil((ch.slowmode * 1000 - (Date.now() - last.createdAt)) / 1000)}s`, 'slowmode');
    }
    await Promise.all((Array.isArray(b.attachments) ? b.attachments.slice(0, 10) : []).map((a) => restoreUpload(path.basename(String(a?.url || '')))));   // after a restart the file may only be in the database
    let attachments = sanitizeAttachments(b.attachments, fs, path, UPLOAD_DIR);
    if (server && attachments.length && !canIn(req.user.id, ch, 'ATTACH_FILES')) attachments = [];
    const gif = sanitizeMedia(b.gif, 'gif'); const sticker = b.sticker?.custom ? serverSticker(b.sticker.custom, req.user.id) : sanitizeMedia(b.sticker, 'sticker');
    const forward = b.forward ? forwardCopy(req, b.forward, ch) : null;
    if (forward && server && forward.attachments.length && !canIn(req.user.id, ch, 'ATTACH_FILES')) forward.attachments = [];
    if (forward && server && (forward.gif || forward.sticker) && !canIn(req.user.id, ch, 'SEND_GIFS')) { forward.gif = null; forward.sticker = null; }
    automod(ch, req.user.id, [b.content, forward?.content].filter(Boolean).join('\n'), { host: req.get('host') });
    const content = guardText(ch, req.user.id, typeof b.content === 'string' ? b.content : '');
    const poll = b.poll ? sanitizePoll(b.poll) : null;
    if (poll) { poll.question = guardText(ch, req.user.id, poll.question); for (const a of poll.answers) a.text = guardText(ch, req.user.id, a.text); }
    const theme = b.theme ? sanitizeSharedTheme(b.theme) : null;
    if (!content.trim() && !attachments.length && !gif && !sticker && !poll && !theme && !forward) throw bad('Cannot send an empty message');
    if ((gif || sticker) && server && !canIn(req.user.id, ch, 'SEND_GIFS')) throw new ApiError(403, 'You don’t have permission to send GIFs or stickers here', 'no_gifs');
    if (content.length > 4000) throw bad('Message is too long (4000 characters max)');
    const msg = postMessage(ch, req.user.id, { content, attachments, gif, sticker, replyTo: b.replyTo, replyPing: b.replyPing !== false, nonce: b.nonce, poll, theme, forward });
    res.json(messageView(msg));
  }));
  /** A copy of a message from a channel you can see, to send on elsewhere ("Forwarded"). Audio messages aren't forwarded (they expire), polls and themes neither. */
  function forwardCopy(req, f, target) {
    const src = db.channels[String(f?.channelId || '')]; const gone = () => notFound('That message can’t be forwarded');
    if (!src || !canView(req.user.id, src)) throw gone();
    const m = (db.messages[src.id] || []).find((x) => x.id === String(f.messageId || '')); if (!m || (m.type && m.type !== 'default')) throw gone();
    const o = m.forward || m; const s = src.serverId && db.servers[src.serverId]; const author = db.users[o.authorId || m.authorId];
    const copy = {
      // where the original is, so "Forwarded from …" can take you there (for a forward of a forward, the original's own place)
      messageId: m.forward ? m.forward.messageId : m.id, channelId: m.forward ? m.forward.channelId : src.id, serverId: m.forward ? m.forward.serverId : src.serverId || null,
      authorId: o.authorId || m.authorId, authorName: o.authorName || (s ? s.members[m.authorId]?.nick : null) || author?.displayName || 'Someone',
      from: m.forward ? m.forward.from : s ? `#${src.name} · ${s.name}` : src.type === 'group' ? (src.name || 'a group chat') : 'a direct message',
      content: guardText(target, req.user.id, String(o.content || '')), attachments: (o.attachments || []).filter((a) => !a.voice), gif: o.gif || null, sticker: o.sticker || null, createdAt: o.createdAt || m.createdAt,
    };
    if (!copy.content.trim() && !copy.attachments.length && !copy.gif && !copy.sticker) throw bad('There is nothing in that message to forward');
    return copy;
  }

  const findMsg = (ch, id) => { const m = (db.messages[ch.id] || []).find((x) => x.id === id); if (!m) throw notFound('Unknown message'); return m; };
  r.patch('/channels/:id/messages/:mid', h(async (req, res) => {
    const ch = getChannel(req, req.params.id); const m = findMsg(ch, req.params.mid);
    if (m.authorId !== req.user.id) throw forbidden('You can only edit your own messages');
    if (m.type !== 'default') throw forbidden();
    if (m.poll) throw forbidden('A poll can’t be edited');
    if (m.theme) throw forbidden('A shared theme can’t be edited');
    automod(ch, req.user.id, String((req.body || {}).content ?? ''), { edit: true, host: req.get('host') });
    const content = guardText(ch, req.user.id, String((req.body || {}).content ?? ''));
    if (!content.trim() && !(m.attachments?.length || m.gif || m.sticker || m.forward)) throw bad('Message cannot be empty — delete it instead');
    if (content.length > 4000) throw bad('Message is too long');
    m.content = content; m.editedAt = Date.now();
    m.emojis = customEmojisIn(content, req.user.id, m.emojis || []) || undefined;
    m.mentions = [...new Set([...content.matchAll(/<@!?(\d{10,20})>/g)].map((x) => x[1]))].filter((id) => db.users[id] && id !== req.user.id);
    save(); emitTo(audienceOf(ch), 'message_update', { message: messageView(m) }); messageEdited(ch, m);
    res.json(messageView(m));
  }));
  r.delete('/channels/:id/messages/:mid', h(async (req, res) => {
    const ch = getChannel(req, req.params.id); const m = findMsg(ch, req.params.mid);
    const s = ch.serverId && db.servers[ch.serverId];
    if (m.authorId !== req.user.id && !(s && canIn(req.user.id, ch, 'MANAGE_MESSAGES'))) throw forbidden();
    if (s && m.authorId !== req.user.id) audit(s, req.user.id, 'message_delete', { target: m.authorId, channel: ch.name });
    db.messages[ch.id] = db.messages[ch.id].filter((x) => x.id !== m.id); save();
    emitTo(audienceOf(ch), 'message_delete', { channelId: ch.id, messageId: m.id }); messagesDeleted(ch, [m.id]);
    res.json({ ok: true });
  }));
  r.post('/channels/:id/messages/bulk-delete', h(async (req, res) => {
    const ch = getChannel(req, req.params.id); const s = ch.serverId && db.servers[ch.serverId];
    if (!s) throw forbidden(); needIn(req.user.id, ch, 'MANAGE_MESSAGES');
    const ids = new Set((Array.isArray((req.body || {}).ids) ? req.body.ids : []).slice(0, 100).map(String));
    db.messages[ch.id] = (db.messages[ch.id] || []).filter((x) => !ids.has(x.id));
    audit(s, req.user.id, 'message_bulk_delete', { channel: ch.name, count: ids.size }); save();
    for (const id of ids) emitTo(audienceOf(ch), 'message_delete', { channelId: ch.id, messageId: id });
    messagesDeleted(ch, [...ids]); res.json({ ok: true });
  }));

  const reaction = (add) => h(async (req, res) => {
    const ch = getChannel(req, req.params.id); const m = findMsg(ch, req.params.mid);
    const s = ch.serverId && db.servers[ch.serverId];
    const emoji = decodeURIComponent(req.params.emoji);
    const custom = /^<a?:[A-Za-z0-9_]{2,32}:\d{6,20}>$/.test(emoji);
    if (!emoji || emoji.length > (custom ? 64 : 40) || (!custom && /[<>]/.test(emoji))) throw bad('Invalid emoji');
    if (custom) { const e = findEmoji(emoji.match(/:(\d{6,20})>$/)[1], req.user.id); if (!e) throw bad('You can only use emoji from servers you are in'); m.emojis = customEmojisIn(emoji, req.user.id, m.emojis || []); }
    m.reactions ||= {};
    const arr = m.reactions[emoji] || [];
    // Taking your own reaction back needs no permission. Starting a reaction nobody has used on the message needs "Add New Reactions"; joining one that is already there needs "React to Messages" (or "Add New Reactions", which includes it).
    if (add && s && !canIn(req.user.id, ch, 'ADD_REACTIONS') && (!arr.length || !canIn(req.user.id, ch, 'USE_REACTIONS'))) throw new ApiError(403, arr.length ? 'You can’t react to messages here.' : 'You can’t add new reactions here — you can only join the ones already there.', arr.length ? 'no_react' : 'no_new_react');
    if (add) {
      if (!arr.includes(req.user.id)) { if (!m.reactions[emoji] && Object.keys(m.reactions).length >= 20) throw bad('Too many reactions'); m.reactions[emoji] = [...arr, req.user.id]; }
      else return res.json({ ok: true });
    } else {
      if (!arr.includes(req.user.id)) return res.json({ ok: true });
      m.reactions[emoji] = arr.filter((id) => id !== req.user.id); if (!m.reactions[emoji].length) delete m.reactions[emoji];
    }
    save();
    emitTo(audienceOf(ch), add ? 'reaction_add' : 'reaction_remove', { channelId: ch.id, messageId: m.id, emoji, userId: req.user.id });
    const rs = reactionRole(ch, m, emoji, req.user.id, add); if (rs) pushServerUpdate(rs);   // a reaction-roles message gives (or takes back) its role
    messageReacted(ch, m, emoji, req.user.id, add);   // Orbit's starboard
    res.json({ ok: true });
  });
  r.put('/channels/:id/messages/:mid/reactions/:emoji/@me', reaction(true));
  r.delete('/channels/:id/messages/:mid/reactions/:emoji/@me', reaction(false));
  r.delete('/channels/:id/messages/:mid/reactions', h(async (req, res) => {
    const ch = getChannel(req, req.params.id); const m = findMsg(ch, req.params.mid); const s = ch.serverId && db.servers[ch.serverId];
    if (!s) throw forbidden(); needIn(req.user.id, ch, 'MANAGE_MESSAGES');
    m.reactions = {}; save(); emitTo(audienceOf(ch), 'message_update', { message: messageView(m) }); res.json({ ok: true });
  }));

  r.get('/channels/:id/pins', h(async (req, res) => {
    const ch = getChannel(req, req.params.id);
    const pins = (db.messages[ch.id] || []).filter((m) => m.pinned).reverse();
    res.json({ messages: pins.map(messageView), users: usersFor(pins.map((m) => m.authorId)) });
  }));
  const pin = (on) => h(async (req, res) => {
    const ch = getChannel(req, req.params.id); const m = findMsg(ch, req.params.mid); const s = ch.serverId && db.servers[ch.serverId];
    if (s) needIn(req.user.id, ch, 'MANAGE_MESSAGES');
    if (on && (db.messages[ch.id] || []).filter((x) => x.pinned).length >= 50) throw bad('This channel has reached the pin limit (50)');
    if (!!m.pinned === on) return res.json({ ok: true });
    m.pinned = on; if (s) audit(s, req.user.id, on ? 'message_pin' : 'message_unpin', { target: m.authorId, channel: ch.name }); save();
    emitTo(audienceOf(ch), 'message_update', { message: messageView(m) });
    if (on) { const sm = systemMessage(ch.id, 'pin', req.user.id, ''); sm.replyTo = m.id; }
    res.json({ ok: true });
  });
  r.put('/channels/:id/pins/:mid', pin(true));
  r.delete('/channels/:id/pins/:mid', pin(false));

  /* ---- polls ---- */
  /* ---- shared themes (the /theme command): a look others can try with one click. The server only checks the shape and size; the client re-checks every setting against its own limits when applying. */
  const THEME_SECTIONS = ['theme', 'bg', 'rain', 'glass', 'fonts', 'motion', 'chat'];
  function sanitizeSharedTheme(t) {
    if (!t || typeof t !== 'object' || !t.data || typeof t.data !== 'object') throw bad('There is no theme to share');
    const clean = (v, depth) => {
      if (v === null || typeof v === 'boolean') return v;
      if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
      if (typeof v === 'string') return v.length <= 300 && !/[;{}<>"'`\\\r\n]/.test(v) ? v : undefined;   // nothing that could break out of a CSS value
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) {
        const out = {};
        for (const [k, x] of Object.entries(v)) { if (!/^\w{1,24}$/.test(k)) continue; const c = clean(x, depth + 1); if (c !== undefined) out[k] = c; }
        return out;
      }
      return undefined;
    };
    const data = {};
    for (const k of THEME_SECTIONS) { const c = clean(t.data[k], 0); if (c && typeof c === 'object' && Object.keys(c).length) data[k] = c; }
    if (data.bg) delete data.bg.library;       // your saved wallpapers stay yours
    if (data.motion) delete data.motion.reduce;   // an accessibility choice nobody else should flip
    if (!Object.keys(data).length) throw bad('There is no theme to share');
    if (JSON.stringify(data).length > 6000) throw bad('That theme is too large to share');
    return { name: String(t.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40) || null, data };
  }
  function sanitizePoll(p) {
    if (!p || typeof p !== 'object') return null;
    const question = String(p.question || '').trim().slice(0, 300); if (!question) throw bad('Ask a question first');
    const answers = (Array.isArray(p.answers) ? p.answers : []).map((a) => ({ text: String(a?.text ?? a ?? '').trim().slice(0, 55), emoji: String(a?.emoji || '').trim().slice(0, 8) || null })).filter((a) => a.text);
    if (answers.length < 2) throw bad('A poll needs at least two answers'); if (answers.length > 10) throw bad('A poll can have at most 10 answers');
    const hours = [1, 4, 8, 24, 72, 168, 336].includes(Number(p.hours)) ? Number(p.hours) : 24;
    return { question, answers: answers.map((a, i) => ({ id: String(i + 1), ...a })), multi: !!p.multi, expiresAt: Date.now() + hours * 3600_000, votes: {}, closed: false };
  }
  const pollOf = (req) => { const ch = getChannel(req, req.params.id); const m = findMsg(ch, req.params.mid); if (!m.poll) throw notFound('There is no poll on that message'); return { ch, m, p: m.poll }; };
  r.put('/channels/:id/messages/:mid/poll/votes', limit('vote', 40, 30_000, (req) => req.user.id), h(async (req, res) => {
    const { ch, m, p } = pollOf(req);
    if (p.closed || (p.expiresAt && p.expiresAt <= Date.now())) throw bad('This poll has ended', 'poll_closed');
    let ids = [...new Set((Array.isArray((req.body || {}).answers) ? req.body.answers : []).map(String))].filter((id) => p.answers.some((a) => a.id === id));
    if (!p.multi) ids = ids.slice(0, 1);
    p.votes ||= {};
    if (ids.length) p.votes[req.user.id] = ids; else delete p.votes[req.user.id];
    save(); emitTo(audienceOf(ch), 'message_update', { message: messageView(m) });
    res.json({ ok: true });
  }));
  r.post('/channels/:id/messages/:mid/poll/close', h(async (req, res) => {
    const { ch, m, p } = pollOf(req);
    if (m.authorId !== req.user.id && !(ch.serverId && canIn(req.user.id, ch, 'MANAGE_MESSAGES'))) throw forbidden();
    p.closed = true; save(); emitTo(audienceOf(ch), 'message_update', { message: messageView(m) });
    res.json({ ok: true });
  }));

  r.post('/channels/:id/typing', limit('typing', 20, 10_000, (req) => req.user.id), h(async (req, res) => {
    const ch = getChannel(req, req.params.id);
    emitTo(audienceOf(ch).filter((id) => id !== req.user.id), 'typing', { channelId: ch.id, userId: req.user.id, timestamp: Date.now() });
    res.json({ ok: true });
  }));
  r.post('/channels/:id/ack', h(async (req, res) => {
    const ch = getChannel(req, req.params.id);
    const mid = String((req.body || {}).messageId || lastMessageId(ch.id) || '');
    req.user.reads ||= {};
    const cur = req.user.reads[ch.id]?.lastRead;
    if (mid && (!cur || cmpId(mid, cur) > 0)) { req.user.reads[ch.id] = { lastRead: mid }; save(); }
    emitTo([req.user.id], 'read_ack', { channelId: ch.id, ...readStateFor(req.user, ch) });
    res.json({ ok: true });
  }));

  /* --------------------------- search --------------------------- */
  r.get('/search', h(async (req, res) => {
    const q = String(req.query.q || '').toLowerCase().trim();
    const from = req.query.from ? String(req.query.from) : null; const has = req.query.has ? String(req.query.has) : null;
    if (!q && !from && !has) return res.json({ results: [], users: [] });
    let channels;
    if (req.query.channelId) channels = [getChannel(req, String(req.query.channelId))];
    else if (req.query.serverId) { const s = getServer(req, String(req.query.serverId)); channels = channelsOfServer(s.id).filter((c) => canView(req.user.id, c) && c.type === 'text'); }
    else channels = Object.values(db.channels).filter((c) => !c.serverId && c.recipients?.includes(req.user.id));
    const terms = q.split(/\s+/).filter(Boolean);
    const out = [];
    const URL_RE = /https?:\/\//i;
    for (const ch of channels) {
      const list = db.messages[ch.id] || [];
      for (let i = list.length - 1; i >= 0 && out.length < 200; i--) {
        const m = list[i]; if (m.type !== 'default') continue;
        if (from && m.authorId !== from) continue;
        if (has === 'image' && !m.attachments?.some((a) => a.type?.startsWith('image/'))) continue;
        if (has === 'file' && !m.attachments?.length) continue;
        if (has === 'link' && !URL_RE.test(m.content)) continue;
        if (has === 'gif' && !m.gif) continue;
        if (has === 'pin' && !m.pinned) continue;
        const text = (m.content || '').toLowerCase();
        if (terms.some((t) => !text.includes(t) && !(m.attachments || []).some((a) => a.name?.toLowerCase().includes(t)))) continue;
        out.push(m);
      }
    }
    out.sort((a, b) => cmpId(b.id, a.id));
    const page = out.slice(clampInt(req.query.offset, 0, 1000, 0), clampInt(req.query.offset, 0, 1000, 0) + 25);
    res.json({ results: page.map(messageView), total: out.length, users: usersFor(page.map((m) => m.authorId)) });
  }));

  /* --------------------------- uploads --------------------------- */
  const MAX_UPLOAD = Number(ENV.MAX_UPLOAD_MB || 25) * 1024 * 1024;
  r.post('/upload', limit('upload', 30, 60_000, (req) => req.user.id), express.raw({ type: () => true, limit: MAX_UPLOAD }), h(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Empty upload');
    let rawName = String(req.headers['x-filename'] || 'file');
    try { rawName = decodeURIComponent(rawName); } catch { /* keep the raw header */ }
    rawName = rawName.replace(/[\\/\0]/g, '_').slice(0, 150) || 'file';
    let ext = path.extname(rawName).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 100);
    const id = newId();
    const file = `${id}${ext}`;
    try { await storeUpload(file, type, req.body); } catch (e) {   // files go to data/uploads, and with DATABASE_URL into the database too
      if (e.code === 'QUOTA') throw new ApiError(507, e.message, 'storage_full');
      console.error('[orata] could not store an upload:', e.message); throw new ApiError(503, 'Could not save the file right now. Try again in a moment.', 'storage_error');
    }
    res.json({ id, url: `/uploads/${file}`, name: rawName, size: req.body.length, type });
  }));

  /* --------------------------- GIFs & stickers (KLIPY) --------------------------- */
  const gifCache = new Map();
  const norm = (it, kind) => {
    const f = it.file || {}; const big = f.md || f.hd || f.sm; const small = f.sm || f.md || f.hd || f.xs;
    const pickUrl = (set, ...keys) => { for (const k of keys) if (set?.[k]?.url) return set[k]; return null; };
    const bigMain = pickUrl(big, 'gif', 'webp', 'png', 'jpg') || {};
    const prevMain = pickUrl(small, 'webp', 'gif', 'png', 'jpg') || bigMain;
    return {
      id: String(it.id), title: it.title || '', w: bigMain.width || 220, h: bigMain.height || 220,
      preview: { url: prevMain.url, w: prevMain.width || 120, h: prevMain.height || 120, mp4: small?.mp4?.url || null, webp: small?.webp?.url || null, gif: small?.gif?.url || null },
      full: { url: kind === 'stickers' ? (big?.webp?.url || big?.png?.url || big?.gif?.url) : (big?.mp4?.url || big?.gif?.url || big?.webp?.url), gif: big?.gif?.url, webp: big?.webp?.url, mp4: big?.mp4?.url, webm: big?.webm?.url, jpg: big?.jpg?.url, png: big?.png?.url, poster: big?.jpg?.url },
    };
  };
  r.get('/gifs', limit('gifs', 120, 60_000, (req) => req.user.id), h(async (req, res) => {
    const key = ENV.KLIPY_API_KEY; if (!key) throw new ApiError(503, 'GIFs are not configured on this server', 'no_gif_key');
    const kind = req.query.type === 'stickers' ? 'stickers' : 'gifs';
    const mode = ['search', 'categories'].includes(req.query.mode) ? req.query.mode : 'trending';
    const page = clampInt(req.query.page, 1, 100, 1); const perPage = clampInt(req.query.per_page, 4, 50, 24);
    const q = String(req.query.q || '').slice(0, 80).trim();
    if (mode === 'search' && !q) throw bad('Search for something');
    const qs = new URLSearchParams({ page: String(page), per_page: String(perPage), customer_id: 'orate-' + req.user.id });
    if (mode === 'search') qs.set('q', q);
    const url = `https://api.klipy.com/api/v1/${key}/${kind}/${mode}${mode === 'categories' ? '' : '?' + qs}`;
    const ck = url; const hit = gifCache.get(ck);
    if (hit && hit.t > Date.now() - 60_000) return res.json(hit.v);
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } }).catch(() => null);
    if (!resp || !resp.ok) throw new ApiError(502, 'The GIF service is unavailable right now', 'gif_upstream');
    const j = await resp.json();
    let out;
    if (mode === 'categories') out = { categories: (j.data?.categories || []).map((c) => ({ name: c.category, query: c.query, preview: c.preview_url })) };
    else out = { items: (j.data?.data || []).filter((it) => it && it.file).map((it) => norm(it, kind)), page, hasNext: !!j.data?.has_next };
    gifCache.set(ck, { t: Date.now(), v: out });
    if (gifCache.size > 300) gifCache.delete(gifCache.keys().next().value);
    res.json(out);
  }));

  /* --------------------------- fonts --------------------------- */
  let fontsCache = null;
  r.get('/fonts', h(async (req, res) => {
    if (!fontsCache) {
      const file = path.join(DATA_DIR, 'fonts-cache.json');
      try { const st = fs.statSync(file); if (Date.now() - st.mtimeMs < 7 * 86400_000) fontsCache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ }
      if (!fontsCache) {
        try {
          const resp = await fetch('https://fonts.google.com/metadata/fonts', { signal: AbortSignal.timeout(8000) });
          const txt = (await resp.text()).replace(/^\)\]\}'/, '');
          const list = JSON.parse(txt).familyMetadataList.filter((f) => f.subsets.includes('latin')).map((f) => {
            const keys = Object.keys(f.fonts); const wa = f.axes.find((a) => a.tag === 'wght');
            return [f.family, f.category, f.popularity, keys.filter((k) => !k.endsWith('i')).join(','), keys.some((k) => k.endsWith('i')) ? 1 : 0, wa ? [wa.min, wa.max] : 0];
          }).sort((a, b) => a[2] - b[2]);
          fontsCache = list; fs.writeFileSync(file, JSON.stringify(list));
        } catch { fontsCache = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'fonts-fallback.json'), 'utf8')); }
      }
    }
    res.set('Cache-Control', 'public, max-age=3600').json(fontsCache);
  }));

  /* --------------------------- link previews --------------------------- */
  const unfurlCache = new Map();
  const isPrivateIp = (ip) => {
    if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:127.') || ip.startsWith('::ffff:10.') || ip.startsWith('::ffff:192.168.');
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  };
  async function safeFetch(rawUrl, { image = false } = {}) {
    let u = new URL(rawUrl);
    for (let hop = 0; hop < 4; hop++) {
      if (!/^https?:$/.test(u.protocol)) throw bad('Unsupported URL');
      const addrs = await dns.lookup(u.hostname, { all: true });
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw bad('Blocked address');
      const go = (ua, accept) => fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(image ? 20000 : 5000), headers: { 'user-agent': ua, accept, 'accept-language': 'en' } });
      let resp = await go(image ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' : 'Mozilla/5.0 (compatible; OrataBot/1.0; +link-preview)', image ? 'image/avif,image/webp,image/*;q=0.8' : 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5');
      // some CDNs (Cloudflare bot rules) reject a full browser UA that lacks matching client hints but accept a bare one
      if (image && (resp.status === 403 || resp.status === 429)) { resp.body?.cancel().catch(() => {}); resp = await go('Mozilla/5.0', 'image/*,*/*;q=0.8'); }
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) { u = new URL(resp.headers.get('location'), u); continue; }
      return { resp, url: u };
    }
    throw bad('Too many redirects');
  }
  const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h2) => String.fromCodePoint(parseInt(h2, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).trim();
  r.get('/unfurl', limit('unfurl', 90, 60_000, (req) => req.user.id), h(async (req, res) => {
    const url = String(req.query.url || ''); if (!/^https?:\/\//i.test(url) || url.length > 1000) throw bad('Invalid URL');
    const hit = unfurlCache.get(url); if (hit && hit.t > Date.now() - 3600_000) return res.json(hit.v);
    let out = { url, type: 'none' };
    try {
      const { resp, url: finalUrl } = await safeFetch(url);
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (ct.startsWith('image/')) out = { url, type: 'image', image: finalUrl.href };
      else if (ct.startsWith('video/')) out = { url, type: 'video', video: finalUrl.href };
      else if (ct.includes('html')) {
        const reader = resp.body.getReader(); let html = ''; let bytes = 0; const dec = new TextDecoder();
        while (bytes < 400_000) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; html += dec.decode(value, { stream: true }); if (/<\/head>/i.test(html)) break; }
        reader.cancel().catch(() => {});
        const meta = {};
        for (const m of html.matchAll(/<meta\s+[^>]*>/gi)) {
          const tag = m[0]; const k = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]; const v = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
          if (k && v) meta[k.toLowerCase()] = decode(v[1] ?? v[2]);
        }
        const title = meta['og:title'] || meta['twitter:title'] || decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]);
        const desc = meta['og:description'] || meta['twitter:description'] || meta.description || '';
        let image = meta['og:image'] || meta['twitter:image'] || '';
        try { if (image) image = new URL(image, finalUrl).href; } catch { image = ''; }
        const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,15})/.exec(finalUrl.href)?.[1];
        if (title || desc || image) out = { url, type: 'link', title: title.slice(0, 200), description: desc.slice(0, 400), image, siteName: meta['og:site_name'] || finalUrl.hostname.replace(/^www\./, ''), color: HEX.test(meta['theme-color'] || '') ? meta['theme-color'] : null, youtube: yt || null, hostname: finalUrl.hostname };
      }
    } catch { /* leave as none */ }
    unfurlCache.set(url, { t: Date.now(), v: out });
    if (unfurlCache.size > 500) unfurlCache.delete(unfurlCache.keys().next().value);
    res.json(out);
  }));

  r.use((req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') err = new ApiError(413, 'That file is too large', 'too_large');
    if (!(err instanceof ApiError)) { if (!err.status) console.error('[api]', err); err = err.status && err.status < 500 ? new ApiError(err.status, err.message) : new ApiError(500, 'Something went wrong on our end', 'server_error'); }
    res.status(err.status).json({ error: err.message, code: err.code });
  });
  return r;
}
