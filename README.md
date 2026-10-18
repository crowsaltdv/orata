# Orate

A realtime chat app for the web — servers, channels, DMs, group chats, friends, GIFs, stickers, emoji, file sharing, voice & video — wrapped in a **fully customizable glass UI**: your own wallpaper with blur and dim, a WebGL **rain-on-glass** effect, Apple-style **liquid glass** buttons, gradient or solid accent colors, and any **Google Font**.

The layout and behavior follow Discord's, with the bear mark as the logo.

## Quick start

**On Windows:** double-click **`start.bat`** — it installs dependencies on the first run, starts the server and opens your browser.

Or from a terminal:

```bash
npm install
npm start
```

Open <http://localhost:3000>, create an account, and you're in. The first account to register becomes the owner of the shared **Orate Community** server; everybody after joins it automatically. A built-in helper bot, **Orbit**, DMs every new user (say `help`).

Requires Node.js 20 or newer. Nothing else — there is no database to set up, data lives in `data/`.

```bash
npm run dev                      # restart on file changes
npm test                         # backend self-tests (145 checks: auth, servers, messages, DMs, uploads, GIFs, settings sync, TURN credentials, voice signalling, email verification …)
npm run reset-password <user>    # forgot a password? prints a new one
```

## Configuration (`.env`)

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Interface to listen on (`127.0.0.1` = this machine only) |
| `KLIPY_API_KEY` | – | Enables the GIF and sticker pickers (proxied server-side; the key never reaches the browser) |
| `MAX_UPLOAD_MB` | `25` | Largest file upload |
| `HTTPS_KEY` / `HTTPS_CERT` | – | Paths to a TLS key/cert to serve HTTPS directly |
| `TRUST_PROXY` | – | Set to `1` when running behind a reverse proxy |
| `STUN_URLS` | Google public STUN | Comma-separated STUN servers for voice & video |
| `TURN_URLS` | – | Comma-separated TURN relay URLs (`turn:` / `turns:`) — see [TURN relay](#turn-relay-for-voice--video) |
| `TURN_SECRET` | – | coturn `static-auth-secret`; Orate hands each user time-limited credentials |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | – | Fixed TURN credentials (use instead of `TURN_SECRET`) |
| `TURN_TTL` | `86400` | Lifetime of generated TURN credentials, in seconds |
| `ICE_TRANSPORT_POLICY` | `all` | Set to `relay` to force every call through TURN (testing / hiding IP addresses) |

> **Microphone, camera, screen sharing and desktop notifications only work on `localhost` or over HTTPS.** To use voice with other devices on your network, set `HTTPS_KEY`/`HTTPS_CERT`, or put Orate behind a TLS reverse proxy (Caddy, nginx, Cloudflare Tunnel …). Make sure it forwards WebSocket upgrades on `/gateway`.

## Email verification

Orate can make people prove they own the address they sign up with: after filling in the sign-up form they get an email with a **6-digit code** and the account is only created once they type it in. It is **off until you configure it** — with nothing in `.env` the sign-up form just creates the account. When it is on, the server prints `Email verification: ON …` at startup (and `OFF …` when it isn't), so you can always tell.

| You set | What happens |
| --- | --- |
| nothing | No verification (the default). |
| `SMTP_HOST` (+ login) | Sign-up sends the code by email through your mail server. If the email can't be sent, the person sees an error instead of waiting for nothing. |
| `REQUIRE_EMAIL_VERIFICATION=true` | Same flow, even without a mail server (dev mode: the code is printed in the console). It also locks accounts out of the app until they re-verify after changing their email address. |

Add the mail settings to `.env` and restart:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587              # 587 = STARTTLS (default), 465 = implicit TLS (set SMTP_SECURE=true)
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password
MAIL_FROM=Orate <you@gmail.com>
PUBLIC_URL=https://chat.example.com   # where people reach Orate; used for links in emails (address changes)
# REQUIRE_EMAIL_VERIFICATION=true
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMTP_HOST` / `SMTP_PORT` | – / `587` | Your mail server. Port 465 with `SMTP_SECURE=true` uses TLS from the start; anything else upgrades with STARTTLS. |
| `SMTP_USER` / `SMTP_PASS` | – | Login (AUTH PLAIN / LOGIN). Credentials are never sent without TLS (loopback servers excepted). |
| `MAIL_FROM` | `Orate <SMTP_USER>` | The sender, e.g. `Orate <no-reply@example.com>`. Most providers require a verified sender or domain. |
| `PUBLIC_URL` | the address the request came to | **Set this in production.** Base of the verification *link* (used when someone changes their address later); without it Orate trusts the `Host` header of the request. |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Turn verification on even without SMTP (dev mode), and lock unverified accounts out (see above). |
| `EMAIL_TOKEN_TTL_HOURS` | `24` | How long a verification link works. (Sign-up codes always expire after 10 minutes.) |
| `SMTP_TLS_VERIFY` | `true` | Set `false` only for a self-signed certificate on a private mail server. |

**Check your settings without signing anyone up:** `npm run test-mail` connects to your mail server and logs in (sending nothing) and tells you what's wrong if it can't; `npm run test-mail you@example.com` also sends a real test email. Remember that lines in `.env` that start with `#` are comments and are ignored.

Working providers: Gmail or Google Workspace (create an *app password*; 2-step verification must be on), Outlook / Microsoft 365, Brevo, Mailgun, SendGrid, Postmark, Resend and Amazon SES — each shows its SMTP host, port and credentials in its dashboard.

**No mail server yet? Dev mode.** Leave `SMTP_HOST` empty and set `REQUIRE_EMAIL_VERIFICATION=true`: the email is printed in the terminal where Orate runs, code included — type it in. If someone has an *existing* unverified account and can't receive email, you can mark them verified yourself:

```bash
npm run verify-email <username>
```

How the sign-up code works: nothing is written to the database until the code is typed in (the half-finished sign-up only lives in server memory for 10 minutes); five wrong guesses cancel it; "Resend code" is limited to once a minute (five times in all), and only the browser that started the sign-up can finish it. Accounts created before you turned this on count as verified. Changing the email address later in Settings sends a verification *link* to the new address and marks the account unverified until it is clicked (links are random 256-bit tokens, stored hashed, single-use, verified through a POST so mail scanners that pre-open links can't use them up).

## TURN relay for voice & video

Calls are peer-to-peer. A STUN server (Google's public one by default) is enough on most home networks, but when someone is behind a corporate firewall, a symmetric NAT or mobile carrier-grade NAT, a direct connection is impossible and the call silently has no audio. A **TURN** server relays the media for those users.

Orate asks its own server for the ICE configuration every time you join a call (`GET /api/ice`), so TURN is configured once in `.env` and never hard-coded in the browser. *Settings → Voice & Video* shows whether a relay is configured.

1. Run a TURN server — [coturn](https://github.com/coturn/coturn) is the usual choice. Minimal `/etc/turnserver.conf`:

   ```ini
   listening-port=3478
   tls-listening-port=5349
   realm=turn.example.com
   use-auth-secret
   static-auth-secret=CHANGE-ME-TO-A-LONG-RANDOM-STRING
   # cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem   # needed for turns:
   # pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
   no-multicast-peers
   no-cli
   fingerprint
   ```

   Open UDP+TCP `3478`, TCP `5349` and the relay port range (`49152–65535/udp` by default) on its firewall.

2. Point Orate at it in `.env`:

   ```ini
   TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
   TURN_SECRET=CHANGE-ME-TO-A-LONG-RANDOM-STRING
   ```

   With `TURN_SECRET`, Orate generates short-lived credentials per user (coturn's "TURN REST API": username `<expiry>:<userId>`, credential `base64(HMAC-SHA1(secret, username))`), so nothing long-lived is ever sent to browsers. If you'd rather use a fixed account, set `TURN_USERNAME` and `TURN_CREDENTIAL` instead. Restart Orate afterwards.

3. Test it: set `ICE_TRANSPORT_POLICY=relay` temporarily — every call is then forced through TURN, so a working call proves the relay works. Remove it again afterwards (relaying everything costs bandwidth on your server).

Hosted TURN services (Cloudflare, Twilio, Metered …) work too: use the URLs and static username/credential they give you.

## Free hosting with a free database

Hosts like Render's free plan wipe the app's folder on every restart, so Orate's usual `data/` folder would lose everything. Set **`DATABASE_URL`** and Orate keeps *all* its data — accounts, servers, messages, sessions and uploaded files — in a PostgreSQL database instead (a free one is enough). Without `DATABASE_URL` nothing changes: it uses local files.

**1. Make the free database.** Create a project on [Neon](https://neon.tech) (or [Supabase](https://supabase.com)); neither needs a card. Copy the *connection string* — it looks like `postgresql://user:password@host/dbname?sslmode=require`. Orate creates its two tables (`orate_state`, `orate_files`) by itself.

**2. (Optional) bring your existing data.** Put the connection string in your local `.env` and start Orate once:

```ini
DATABASE_URL=postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require
```

An empty database adopts your local `data/db.json` and `data/uploads/` automatically, and the startup text says `Storage: PostgreSQL (…)`. Check it with `npm run db:info`. (`npm run db:import -- --force` re-copies local data over what's there.)

**3. Deploy on Render.** Push the project to GitHub (`.env` and `data/` are git-ignored — keep it that way), then either use **New → Blueprint** (this repo contains a `render.yaml`) or create a **Web Service** with build command `npm install` and start command `npm start`. Set these environment variables in Render's dashboard:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the connection string from step 1 |
| `TRUST_PROXY` | `true` (Render puts a proxy in front of the app) |
| `PUBLIC_URL` | `https://<your-service>.onrender.com` |
| `MAX_UPLOAD_MB` | `8` (uploads are stored in the free database, so keep files small) |
| `KLIPY_API_KEY`, `SMTP_*` | as in your `.env` — put secrets here, never in git |

**Settings**

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | – | Set it to use PostgreSQL. |
| `DATABASE_SSL` | verify | `no-verify` if the database's certificate can't be verified (some Supabase connections), `off` for a database without TLS. Local databases never use TLS. |
| `DATABASE_FILES_MB` | `350` | Cap for uploaded files in the database, so a 0.5 GB free plan can't fill up; uploads beyond it are refused with a clear message. |
| `DATABASE_SAVE_DELAY_MS` | `2500` | Changes are saved a moment after they happen (batched). |
| `DATABASE_POOL_MAX` | `3` | Database connections. |

**What to expect**
- **Render's free service sleeps** after about 15 minutes without visitors; the next visit wakes it (up to a minute) and everybody's live connection reconnects by itself. The data is untouched.
- **Run one Orate per database.** Orate keeps live state (who is online, voice calls) in memory, so two servers can't share a database. If a second one writes, the stale one *refuses to overwrite* and exits so it restarts with the newest data — don't leave your PC's copy running against the same database as Render.
- **Storage:** the database holds the whole chat history as one compressed record plus your uploads; the free tier's ~0.5 GB goes a long way for a friend group. `npm run db:info` shows what's used.
- **Backups / leaving:** `npm run db:export` writes `data/db.json` and `data/uploads/` from the database (an existing `db.json` is backed up first), and that folder runs as a normal local Orate.
- Your Postgres password is as sensitive as the data: keep `DATABASE_URL` out of git.

## What's inside

**Chat** — servers with categories, text & voice channels, private channels, roles & permissions, invites (expiry / max uses), kicks & bans, nicknames; DMs and group DMs; friends, requests, blocking; replies, edits, deletes, pins, reactions; unread markers and mention badges; typing indicators; message search with filters; markdown (bold, italic, underline, strike, spoilers, quotes, headings, lists, code blocks with syntax highlighting, timestamps); `@user`, `@role`, `#channel` and `:emoji:` autocomplete; slash commands (`/shrug`, `/me`, `/spoiler`, `/gif`, `/nick` …); link previews with inline YouTube; images, video and audio inline with a lightbox; drag-and-drop & paste uploads with progress; GIFs and stickers from KLIPY (picking one stages it in the message box like an upload — you press send); a full emoji picker with skin tones and "frequently used".

**Voice & video** — WebRTC mesh calls in voice channels and DMs, speaking indicators, mute / deafen, camera, screen share (with audio), per-user volume, push-to-talk, noise suppression, echo cancellation, device pickers and a mic level test. Incoming-call ring for DMs. Connects peer-to-peer using STUN; add a [TURN relay](#turn-relay-for-voice--video) for people behind strict NATs or firewalls.

**Customization** (User Settings → Appearance) — new accounts start with a slate-blue dark theme, the Snow Peaks wallpaper, light rain and the Klee One font; everything below can be changed.

* **Theme** — dark / light / midnight / system, solid or gradient accent, solid or gradient panels, panel opacity, panel blur, saturation, corner radius, spacing, custom text color.
* **Wallpaper** — 8 built-in gradients, 6 photos, your own upload or image link, solid color or custom gradient; live brightness, saturation, zoom, position, mouse parallax, and two separate blur controls: **Wallpaper blur** (the picture itself) and **Panel blur** (the frosted glass of the panels in front of it). Both default to subtle values — set them to 0 for a crisp wallpaper.
* **Rain & Glass** — the original Codrops raindrop effect (see [credits](#credits)) with weather presets (Rain / Drizzle / Storm / Fallout) and sliders for amount, drop size, speed, refraction, mist, wet trails, tiny droplets, lightning and frame rate; plus Apple-style **liquid glass** for the whole interface — panels, menus, windows, toasts and buttons get a WebGL glass lip that refracts your real wallpaper, with a specular rim. It reacts to the cursor: buttons catch the light where you hover, and panels glow and bend more under the pointer and send a light ripple through the glass when you click. It is **off by default**; switch it on (or choose frosted instead) and pick which areas it covers.
* **Button effects** — press ripples and particle bursts (send, reactions, toggles, confirmations, colour swatches), with an intensity slider; all of it off under *Reduce motion*.
* **Fonts** — search the whole Google Fonts catalogue; every font is previewed in its own typeface. Separate interface, chat and code fonts, plus size, weight, line height and letter spacing.
* **Chat** — compact mode, 24-hour time, link previews, GIF autoplay, large emoji.
* Themes can be exported / imported as JSON. Settings sync to your account, so your look follows you.
* **Profile** — animated avatars: upload a GIF or pick one from KLIPY (it's downloaded once and stored on your server).
* Also: custom status, 12 interface languages, accessibility options, notification sounds.

Everything is smooth by default; **Reduce motion** turns most animation (and the rain) off. If the GPU can't keep up, Orate automatically steps liquid glass down to frosted glass once per session.

## Wallpapers & the image proxy

The six photo wallpapers are loaded through a small image proxy (`/api/img`) that fetches the original once, caches it in `data/imgcache/`, and serves it same-origin. That makes them work offline afterwards and lets the WebGL rain effect sample them (cross-origin images can't be read by WebGL). The proxy only serves images, blocks private network addresses, and caps file size. If a host refuses server-side fetches (e.g. behind bot protection), Orate retries with a plainer user agent, and failing that shows the image directly and simply skips the rain effect for it.

## Architecture

```
server/
  index.js      Express + HTTPS, static files, CSP, uploads
  api.js        REST API (auth, users, servers, channels, messages, friends, GIFs, fonts, unfurl, image proxy)
  gateway.js    WebSocket: presence, typing, voice rooms, WebRTC signalling
  core.js       JSON-file persistence, permissions, serializers, event fan-out
  messages.js   message creation (mentions, replies, DM reopening)
  bot.js        Orbit, the helper bot
  mail.js       dependency-free SMTP client (TLS / STARTTLS) with a console fallback
  signup.js     emailed sign-up codes
  storage.js    optional PostgreSQL storage (DATABASE_URL): state + uploaded files
  env.js        .env parsing   db-tool.js  db:import / db:export / db:info
  verify.js     email verification tokens, modes and gating
public/
  js/           Preact + htm (vendored, no build step), ES modules (rain.js, glass.js, fx.js: rain, liquid glass, button particles)
  css/          base · layout · chat · ui · features · settings · auth
  img/rain/     drop textures for the rain effect
  data/         emoji dataset (generated from Emojibase)
```

* **No build step.** The browser loads native ES modules; `public/vendor/preact-htm.js` is Preact + htm in one file.
* **Realtime** — the client keeps one WebSocket (`/gateway`); mutations go through REST and are fanned out as events.
* **State** — one small reactive store with selector subscriptions; settings sync to the server and persist locally.
* **Storage** — `data/db.json` (atomic writes, debounced) and `data/uploads/`. Back up the `data/` folder.

## Security notes

Passwords are hashed with scrypt; sessions are random 256-bit tokens (stored hashed). Message content is escaped by Orate's own markdown renderer before it reaches the DOM, uploads are served with a sandboxing CSP and non-media files download instead of rendering, link previews and the image proxy refuse private addresses, and a strict Content-Security-Policy is sent with every page. Auth and message endpoints are rate limited. Orate is designed for small/medium communities and self-hosting; put it behind HTTPS before exposing it to the internet.

## Credits

* **Rain on glass** is a port of Lucas Bebber's [Rain & Water Effect Experiments](https://tympanus.net/codrops/2015/11/04/rain-water-effect-experiments/) (Codrops, 2015): the drop simulation, the drop textures (`public/img/rain/`) and the water shader come from the [original project](https://github.com/codrops/RainEffect), adapted into a single ES module with Orate's sliders, presets and lightning. Its licence lets you integrate or build upon it in personal or commercial projects, but not republish or redistribute it as-is — so keep it as part of Orate rather than extracting it on its own.
* **Liquid glass** uses the signed-distance-field lens, rim-light and dispersion approach from the [Apple-style glass CodePen](https://codepen.io/jhnsnc/pen/ByoEmoq) by jhnsnc, re-implemented as per-button WebGL lenses over your wallpaper.

## License

MIT — do what you like (with the exception of the Codrops rain effect noted above). Emoji data © Emojibase (MIT); GIFs and stickers by KLIPY.
