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
npm test                         # backend self-test (62 checks: auth, servers, messages, DMs, uploads, GIFs, settings sync, TURN credentials, voice signalling …)
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

## What's inside

**Chat** — servers with categories, text & voice channels, private channels, roles & permissions, invites (expiry / max uses), kicks & bans, nicknames; DMs and group DMs; friends, requests, blocking; replies, edits, deletes, pins, reactions; unread markers and mention badges; typing indicators; message search with filters; markdown (bold, italic, underline, strike, spoilers, quotes, headings, lists, code blocks with syntax highlighting, timestamps); `@user`, `@role`, `#channel` and `:emoji:` autocomplete; slash commands (`/shrug`, `/me`, `/spoiler`, `/gif`, `/nick` …); link previews with inline YouTube; images, video and audio inline with a lightbox; drag-and-drop & paste uploads with progress; GIFs and stickers from KLIPY; a full emoji picker with skin tones and "frequently used".

**Voice & video** — WebRTC mesh calls in voice channels and DMs, speaking indicators, mute / deafen, camera, screen share (with audio), per-user volume, push-to-talk, noise suppression, echo cancellation, device pickers and a mic level test. Incoming-call ring for DMs. Connects peer-to-peer using STUN; add a [TURN relay](#turn-relay-for-voice--video) for people behind strict NATs or firewalls.

**Customization** (User Settings → Appearance)

* **Theme** — dark / light / midnight / system, solid or gradient accent, solid or gradient panels, panel opacity, panel blur, saturation, corner radius, spacing, custom text color.
* **Wallpaper** — 8 built-in gradients, 6 photos, your own upload or image link, solid color or custom gradient; live brightness, saturation, zoom, position, mouse parallax, and two separate blur controls: **Wallpaper blur** (the picture itself) and **Panel blur** (the frosted glass of the panels in front of it). Both default to subtle values — set them to 0 for a crisp wallpaper.
* **Rain & Glass** — the original Codrops raindrop effect (see [credits](#credits)) with weather presets (Rain / Drizzle / Storm / Fallout) and sliders for amount, drop size, speed, refraction, mist, wet trails, tiny droplets, lightning and frame rate; plus Apple-style **liquid glass** buttons (a WebGL lens that refracts your real wallpaper, with a specular rim and pointer-following light) or frosted glass, switchable per area.
* **Button effects** — press ripples and particle bursts (send, reactions, toggles, confirmations, colour swatches), with an intensity slider; all of it off under *Reduce motion*.
* **Fonts** — search the whole Google Fonts catalogue; every font is previewed in its own typeface. Separate interface, chat and code fonts, plus size, weight, line height and letter spacing.
* **Chat** — compact mode, 24-hour time, link previews, GIF autoplay, large emoji.
* Themes can be exported / imported as JSON. Settings sync to your account, so your look follows you.
* Also: server tags, custom status, 12 interface languages, accessibility options, notification sounds.

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
