# Orate

A realtime chat app for the web — servers, channels, DMs, group chats, friends, GIFs, stickers, emoji, file sharing, voice & video — wrapped in a **fully customizable glass UI**: your own wallpaper with blur and dim, a WebGL **rain-on-glass** effect, glassy **liquid glass** buttons and panels, gradient or solid accent colors, and any **Google Font**.

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
npm test                         # backend self-tests (468 checks: auth, servers, messages, DMs, uploads, GIFs, settings sync, permissions, bans, emoji, forums, polls, stage channels, email verification …)
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
| `CLIENT_IP_HEADER` | – | Header your host sets to the visitor's real address and that visitors can't forge, e.g. `CF-Connecting-IP` behind Cloudflare. Used only to match **bans to networks** (see *Moderation*); without it Orate uses the address Express resolves from `TRUST_PROXY`. Some hosts (Render's proxy appends to a client-supplied `X-Forwarded-For`) let a determined visitor fake that value, so set this if you can verify the header — check with a request that sends it yourself. |
| `STUN_URLS` | Google public STUN | Comma-separated STUN servers for voice & video |
| `TURN_URLS` | – | Comma-separated TURN relay URLs (`turn:` / `turns:`) — see [TURN relay](#turn-relay-for-voice--video) |
| `TURN_SECRET` | – | coturn `static-auth-secret`; Orate hands each user time-limited credentials |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | – | Fixed TURN credentials (use instead of `TURN_SECRET`) |
| `TURN_TTL` | `86400` | Lifetime of generated TURN credentials, in seconds |
| `ICE_TRANSPORT_POLICY` | `all` | Set to `relay` to force every call through TURN (testing / hiding IP addresses) |
| `MUSIC` | on | `MUSIC=off` turns the Music player off — see [Music](#music-apple-music-previews--no-key-needed) |

> **Microphone, camera, screen sharing and desktop notifications only work on `localhost` or over HTTPS.** To use voice with other devices on your network, set `HTTPS_KEY`/`HTTPS_CERT`, or put Orate behind a TLS reverse proxy (Caddy, nginx, Cloudflare Tunnel …). Make sure it forwards WebSocket upgrades on `/gateway`.

## Email verification

An email address is **optional** when signing up: leave it blank and the account is created straight away with just a username and password (an address can be added, changed or removed later in *Settings → My Account*). Orate can make the people who *do* give one prove they own it: after filling in the sign-up form they get an email with a **6-digit code** and the account is only created once they type it in. It is **off until you configure it** — with nothing in `.env` the sign-up form just creates the account. When it is on, the server prints `Email verification: ON …` at startup (and `OFF …` when it isn't), so you can always tell.

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

**The easy way — a hosted relay with a free tier (no server of your own).** If you host Orate somewhere like Render you can't run coturn there, but you can let Orate fetch short-lived relay credentials from a provider; just put the provider's key in `.env` (or Render's environment) and restart:

```ini
# Cloudflare Realtime TURN: Cloudflare dashboard → Realtime → TURN → create a key
CLOUDFLARE_TURN_KEY_ID=your-turn-key-id
CLOUDFLARE_TURN_API_TOKEN=your-turn-key-api-token

# …or Metered (Open Relay): dashboard → TURN Server → your app name and API key
# METERED_APP=your-app-name
# METERED_API_KEY=your-api-key
```

Orate asks the provider for credentials on the server (never from the browser), caches them, and hands them to people when they join a call. Check *Settings → Voice & Video* — it should now say a relay is configured.

**Calls: nobody can hear / see anyone?** Two people on the same Wi-Fi usually connect directly. Across the internet the usual culprit is a network that blocks direct connections (mobile data, school / work Wi-Fi, some routers) and **no relay**. Orate shows *Connecting…* / *Can't connect* on each person's tile and explains it once with a message; the fix is the relay above. Also remember that the microphone, camera and screen share only work on `https://` or `localhost` (a plain `http://192.168…` address can listen but can't talk).

## Music (Apple Music previews — no key needed)

The note icon above Home opens the **Music page** (`/music`): search the Apple Music catalogue or browse **categories** — Top Songs, Pop, Hip-Hop / Rap, R&B, Rock, Alternative, Electronic, Dance, Country, Latin, K-Pop, J-Pop, Jazz, Classical, Metal, Reggae, Singer / Songwriter, Soundtracks, Blues and Gospel (Apple's public top-songs charts, cached for 30 minutes) — press play, and what you're listening to shows on your profile (and in friends' *Active Now*) while it plays. A big *Now playing* card, a mini player above your user bar and your recently played tracks are always at hand. It works out of the box — **no account, no API key**.

Orate uses Apple's public, keyless [iTunes Search API](https://performance-partners.apple.com/search-api) (`itunes.apple.com/search` and `/lookup`): the same catalogue as Apple Music, with cover art, a link to every song on Apple Music and a **30-second preview** of each one. (The Apple Music API proper needs a developer token signed with a key from a paid Apple Developer account — that's the part this avoids. Full-length playback needs MusicKit and each listener's own Apple Music subscription, so previews it is. When a preview ends the next result starts.)

| Variable | Default | What it does |
| --- | --- | --- |
| `MUSIC` | on | `MUSIC=off` turns the music player off for everybody |
| `MUSIC_COUNTRY` | `US` | Which Apple Music storefront the search uses (two letters, e.g. `GB`) |
| `MUSIC_API_PER_MIN` | `18` | The most requests Orate sends to Apple per minute (Apple allows about 20 per IP address) |
| `MUSIC_CACHE_MB` | `48` | Memory used to keep recently played previews |

**How it works:** the server does all the talking to Apple. A preview (about 1 MB) is downloaded when it's asked for, kept in memory for a while and served to the `<audio>` tag from `/api/music/play/<track>` with Range support, so the seek bar works. An `<audio>` tag can't send a login, so that link is signed by the server and short-lived. Searches are cached (10 minutes), and because Apple limits searches per IP address, Orate never sends more than `MUSIC_API_PER_MIN` a minute however many people search — beyond that people see "search is busy" for a moment.

**What others see:** the title, artist, artwork and a progress bar, only while it plays. They always come from Apple via the server — a client can't make up a "listening to" status — and disappear when you pause, stop, close the last tab or the preview ends. Nothing is shown when **Settings → Privacy → Show my status to everyone** is off or you are *Invisible* (the switch is also on the Music page). The player links every track back to Apple Music.

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
- **Stuck on "Connecting…"?** The server log looking fine (`Orate is running … :10000`) only proves the server started. Usually the browser is holding a login the server no longer knows (a free instance that lost its data, or a different database) and Render's proxy hides the "your login is invalid" reply, so the page retried forever. Current Orate recovers by itself (it signs you out after a few failed tries and the loading screen offers *Try again* / *Sign out*). On an older version, open the site in a private window or clear the site's data once (browser dev tools → Console → \`localStorage.clear(); location.reload()\`). Also open \`https://<your-service>.onrender.com/api/config\`: if that shows JSON, the server is up.
- **Logins don't expire.** You stay signed in until you log out (or change your password, which signs out your other devices). With Postgres each login is saved in its own table the moment you sign in, so a restart, a deploy or an update can't sign anyone out.
- **Run one Orate per database.** Orate keeps live state (who is online, voice calls) in memory, so two servers can't share a database. If a second one writes, the stale one *refuses to overwrite* and exits so it restarts with the newest data — don't leave your PC's copy running against the same database as Render.
- **Storage:** the database holds the whole chat history as one compressed record plus your uploads; the free tier's ~0.5 GB goes a long way for a friend group. `npm run db:info` shows what's used.
- **Backups / leaving:** `npm run db:export` writes `data/db.json` and `data/uploads/` from the database (an existing `db.json` is backed up first), and that folder runs as a normal local Orate.
- Your Postgres password is as sensitive as the data: keep `DATABASE_URL` out of git.

## What's inside

**Chat** — servers with categories, text & voice channels, roles & permissions with **per-channel and per-category permission overwrites** (see below), invites (expiry / max uses) that show up in chat as a server card with live Online / Member counts and a **Join** button, kicks, **timeouts** and **bans that also block the person's network** (see *Moderation* below), nicknames, **GIF server icons and big GIF banners**, **custom emoji & stickers**, **forum channels** and **polls**; **server folders** — drag one server onto another (or use the server menu → *Server Folder*) to group them, rename / recolour the folder, drag servers in and out; **several accounts** on one device with a Discord-style *Switch Accounts* menu (Add / Manage Accounts); DMs and group DMs; friends, requests, blocking; replies, edits, deletes, pins, reactions; unread markers and mention badges; typing indicators; message search with filters; markdown (bold, italic, underline, strike, spoilers, quotes, headings, lists, code blocks with syntax highlighting, timestamps); `@user`, `@role`, `#channel` and `:emoji:` autocomplete; slash commands (`/shrug`, `/me`, `/spoiler`, `/gif`, `/poll`, `/theme`, `/nick` …); link previews with inline YouTube; images, video and audio inline with a lightbox; drag-and-drop & paste uploads with progress; GIFs and stickers from KLIPY (picking one stages it in the message box like an upload — you press send; a sent GIF is shown whole, at its own shape and without rounded corners, and the **star** on it — or on any GIF in the picker — saves it to your **Favorites**, the first category of the picker, which follows your account); a full emoji picker with skin tones and "frequently used".

**Channel & category permissions** — right-click a channel or category → *Edit Permissions*. Pick a role or a member and set each permission to **Allow**, **Deny** or **Inherit**, exactly like Discord: the order is server permissions → @everyone → the member's roles → the member themselves, an Allow from a role beats a Deny from another role, and a channel you can't *View* grants nothing (that is also how private channels work; the *Private Channel* switch is a shortcut for it). Channels inside a category are **synced** with it — change the category and every synced channel follows. Changing a synced channel's permissions **unsyncs** it (the banner shows *Not synced*); *Sync Now* re-adopts the category's, *Unsync* detaches a copy. Only people with *Manage Permissions* can edit, they can't grant what they don't have, and they can't touch roles at or above their own. Everything is enforced on the server (messages, reactions, attachments, @everyone, voice) and the member list of a channel updates live.

**Moderation** — *Ban* asks for an optional reason (only moderators see it) and whether to delete the person's recent messages (last hour … 7 days); the *Bans* page shows who banned them, when and why. **A ban follows the person.** For every account Orate remembers keyed one-way hashes (HMAC with a secret kept in the database) of up to eight networks and six browsers it was used from — never the addresses or ids themselves, and nothing is shown to anyone. Banning an account also bans **every other account that shares one of those networks or browsers (its alts)** — they show up in the ban list as *Alt of …*, and the ban dialog has a switch to ban just the one account — and a brand-new account on any of them can't join. A browser is recognised by a random id it sends (`X-Orate-Device`; clearing site data resets it), private / loopback networks are ignored, IPv6 is matched by /64, the owner's and the banning moderator's own networks are never used, and *Unban* frees the person and their alts together. People on a shared network (a school, a café, a mobile carrier) can be caught by someone else's ban — turn the alts switch off, or unban them. Behind a reverse proxy set `TRUST_PROXY=1` (and, if your host provides a header the visitor can't forge, `CLIENT_IP_HEADER`) so Orate sees the visitor's address rather than the proxy's. This is a deterrent, not a wall: a VPN plus a fresh browser gets around any ban. **Timeouts** (member menu → *Timeout*: 60 seconds … 1 week, needs *Timeout Members*) let someone read but not talk, react, join voice or upload until they expire — and they apply to the person's alts too, including accounts that join from the same browser or network while it lasts. Timed-out members show a small clock in the member list.

**Swearing protection & GIF permission** — Server Settings → *Safety* has a swearing filter that is **off by default**. *Hide the words* turns swear words into f∗∗∗ and still sends the message; *Block the message* refuses it and tells the person why. It catches repeated letters, symbols between letters and look-alike characters (f.u.c.k, sh1t) but never ordinary words ("class" is fine), covers messages, edits, polls and forum posts (not DMs), lets you add your own blocked words, and never filters the owner or administrators. The **Send GIFs & Stickers** permission (on for everyone by default; existing servers keep working) controls the GIF and sticker pickers — per role or per channel; without it the picker shows emoji only.

**Tab cloak** — Settings → *Cloak* makes the browser tab look like another site: pick one of 26 (Google, Google Drive, Gmail, Docs, Sheets, Slides, Classroom, Calendar, Meet, YouTube, Wikipedia, Khan Academy, Desmos, Canvas, Schoology, Clever, Quizlet, Kahoot, Outlook, Teams, Zoom, PowerSchool, IXL, GitHub …) or give your own title and icon link. It is remembered on this device and applied as soon as the page loads, even on the sign-in screen; the app can't override it. **Open in about:blank** opens Orate inside a blank tab (the address bar shows `about:blank`) wearing the cloak, and can send the original tab to another site. If nothing opens your browser blocked the pop-up — allow pop-ups for the site. (Site icons are fetched once by your own server through its image proxy, so your browser never contacts those sites.)

**Custom emoji & stickers** — Server Settings → *Emoji* / *Stickers* (needs *Manage Expressions*): upload PNG, JPEG, GIF or WebP up to 512 KB (up to 50 emoji and 30 stickers per server; GIFs animate). Use them anywhere in the server by typing `:name:` (autocomplete suggests them), from the emoji picker, as reactions, or send a sticker from the sticker picker. Messages carry their emoji pictures with them, so they keep showing even if the emoji is deleted later or you view them from another server.

**GIF icons & banners** — the server icon and the (now much bigger, 16:9) banner can be an uploaded GIF or one picked from KLIPY with *Choose a GIF*; animated pictures play everywhere.

**Forum channels** — create a *Forum* channel: every topic is its own **post** with a title, tags and a first message, and replies happen inside the post like a normal channel. Posts can be sorted by recent activity or creation date, filtered by tag and searched; moderators can pin and lock posts (the post's author can lock their own and rename it), and a forum can *require a tag* and show guidelines above the new-post form. Posts follow the forum's permissions (private forums keep their posts private), and links to a post open it directly.

**Polls** — the `+` button next to the message box → *Create Poll* (or `/poll`): a question with 2–10 answers, a duration from 1 hour to 2 weeks and an optional multiple-choice mode. Votes update live and results are shown as bars; **click the number of votes** to see who voted for which option. The author or a moderator can end a poll early.

**Sharing your theme** — type `/theme` (or `/theme My Midnight look` to name it) in any channel or DM and your current look — colours, panels, wallpaper, rain, glass, fonts and chat options — is posted as a card with a little preview. Anyone can press **Apply Theme** to try it; the same button then turns into **Undo** and puts back exactly the settings it changed (it survives a reload). Your saved wallpapers and your *Reduce motion* choice are never shared or overwritten. Because a theme arrives in a message, every setting is re-checked before it is applied: unknown settings, colours that aren't colours, wallpaper links that aren't images and anything that could break out of a style value are dropped, and numbers are clamped to what the settings sliders allow.

**Voice & video** — WebRTC mesh calls in voice channels and DMs, speaking indicators, mute / deafen, camera, screen share (with audio), per-user volume, push-to-talk, noise suppression, echo cancellation, device pickers and a mic level test. The call grid always fits the screen — tiles change shape as people join or leave, a shared screen gets the big area with everybody else in a strip below it, and nothing scrolls. Incoming-call ring for DMs. Connects peer-to-peer using STUN; add a [TURN relay](#turn-relay-for-voice--video) for people behind strict NATs or firewalls.

**Stage channels** — create a *Stage* (Create Channel → Stage) for a talk: a few **speakers** are on stage and everybody else is in the **audience**, listening. Whoever manages the channel or can time members out (the owner, administrators, anyone with *Manage Channel* / *Timeout Members*) opens an empty stage by joining it; everyone else joins muted, with no microphone or camera, and can **raise their hand** (the button, or the mic button in the sidebar). Moderators see raised hands first — oldest first — and press **Invite to Speak** (or right-click anyone); a speaker starts muted, can unmute, turn on a camera or share a screen, and can **Move to Audience** at any time, while moderators can send other speakers back. The stage holds up to 10 speakers; the *Speak* permission is what lets someone raise a hand or take the stage, and anyone who loses it (role or channel change) steps down by themselves. Audio and video only travel where a speaker is involved — listeners connect to speakers and never to each other, and the server refuses anything else — so a big audience costs the speakers, not the other listeners. The channel topic is shown on the stage (Edit Channel → *Stage topic*). Stage channels follow the same channel permissions as voice channels.

**Music** — a full Music page with Apple Music search, genre charts and a 30-second preview player behind the note icon above Home (no key needed), and a "Listening to" card on your profile (see [Music](#music-apple-music-previews--no-key-needed)).

**Customization** (User Settings → Appearance) — new accounts start with a slate-blue dark theme, the Snow Peaks wallpaper, light rain and the Montserrat font; everything below can be changed. The sign-in and sign-up screens always show this default look (a new account starts from it too), and your own look returns when you log in.

* **Theme** — dark / light / midnight / system, solid or gradient accent, solid or gradient panels, panel opacity, panel blur, saturation, corner radius, spacing, custom text color.
* **Wallpaper** — 8 built-in gradients, 6 photos, your own upload or image link, solid color or custom gradient; live brightness, saturation, zoom, position, mouse parallax, and two separate blur controls: **Wallpaper blur** (the picture itself) and **Panel blur** (the frosted glass of the panels in front of it). Both default to subtle values — set them to 0 for a crisp wallpaper.
* **Rain & Glass** — the original Codrops raindrop effect (see [credits](#credits)) with weather presets (Rain / Drizzle / Storm / Fallout) and sliders for amount, drop size, speed, refraction, mist, wet trails, tiny droplets, lightning and frame rate; plus **liquid glass** — buttons, rails, the message box and menus, windows and toasts get bright inset edges on opposite corners, a thin dark inner edge, a soft blur and a blurred glow in two corners, and buttons lift on hover and press in when clicked. It is plain CSS (no WebGL, so it costs almost nothing). It is **off by default**; switch it on, set how bright it is and pick which areas it covers.
* **Button effects** — press ripples and particle bursts (send, reactions, toggles, confirmations, colour swatches), with an intensity slider; all of it off under *Reduce motion*.
* **Fonts** — search the whole Google Fonts catalogue; every font is previewed in its own typeface. Separate interface, chat and code fonts, plus size, weight, line height and letter spacing.
* **Chat** — compact mode, 24-hour time, link previews, GIF autoplay, large emoji.
* Themes can be exported / imported as JSON. Settings sync to your account, so your look follows you.
* **Profile** — animated avatars and banners: upload a GIF or pick one from KLIPY (it's downloaded once and stored on your server). **Profile style** (User Settings → Profile, with a live preview): card **colors and gradients**; an **outline** (solid / dashed / dotted / double, or a gradient) with a **shadow & glow**; **fonts** for your name and your text (28 Google fonts — just pick one, no switch); a **name style** like Discord's — a color or **gradient** fill, a solid or **gradient outline**, and a **shadow with its own angle, distance, blur and color**; and an animated **effect** from 41 — solar rays, ocean, ambient lights, aurora, sparkles, glitter, stars, warp speed, galaxy, shooting stars, snow, rain, lightning, clouds, mist, embers, fire, smoke, hearts, bubbles, bokeh, lava lamp, confetti, fireworks, fireflies, butterflies, petals, autumn leaves, lanterns, balloons, ripples, underwater, disco, spotlights, vaporwave, equalizer, plasma, retro CRT, matrix, pixels and dust. Every effect shows a live preview in the picker and you choose its colors, amount, speed and opacity. Everything is validated on the server and again in the browser (`public/js/profile-data.js`), and effects stand still under *Reduce motion*. The *unsaved changes* bar floats over the bottom of the screen on every settings page.
* **Default avatars** — everyone who has not uploaded a picture gets their own random, good-looking gradient behind the Orate logo (every default avatar got one once, when this arrived); *Settings → Profile → Shuffle color* picks another.
* Also: custom status, 12 interface languages, accessibility options, notification sounds.

Everything is smooth by default; **Reduce motion** turns most animation (and the rain) off. If the GPU can't keep up, Orate automatically turns liquid glass off once per session.

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
  sessions.js   sign-in sessions (never expire; in their own Postgres table when DATABASE_URL is set)
  music.js      Apple Music (iTunes Search API) search + preview relay + "listening to" status
public/
  js/           Preact + htm (vendored, no build step), ES modules (rain.js, fx.js: rain, button particles; voice.js / stageview.js: calls and stages)
  css/          base · layout · chat · ui · features · settings · auth · extras
  img/rain/     drop textures for the rain effect
  data/         emoji dataset (generated from Emojibase)
```

* **No build step.** The browser loads native ES modules; `public/vendor/preact-htm.js` is Preact + htm in one file.
* **Realtime** — the client keeps one WebSocket (`/gateway`); mutations go through REST and are fanned out as events.
* **State** — one small reactive store with selector subscriptions; settings sync to the server and persist locally.
* **Storage** — `data/db.json` (atomic writes, debounced) and `data/uploads/`. Back up the `data/` folder.

## Security notes

Passwords are hashed with scrypt; sessions are random 256-bit tokens (stored hashed, with no address attached). The only network information kept is, per account, keyed one-way hashes of the recent networks (up to eight) and browsers (up to six) it was used from — used solely to make server bans stick (see *Moderation*), never shown or returned by the API, and useless without the secret stored in the database. Message content is escaped by Orate's own markdown renderer before it reaches the DOM, uploads are served with a sandboxing CSP and non-media files download instead of rendering, link previews and the image proxy refuse private addresses, and a strict Content-Security-Policy is sent with every page. Auth and message endpoints are rate limited. Orate is designed for small/medium communities and self-hosting; put it behind HTTPS before exposing it to the internet.

## Credits

* **Rain on glass** is a port of Lucas Bebber's [Rain & Water Effect Experiments](https://tympanus.net/codrops/2015/11/04/rain-water-effect-experiments/) (Codrops, 2015): the drop simulation, the drop textures (`public/img/rain/`) and the water shader come from the [original project](https://github.com/codrops/RainEffect), adapted into a single ES module with Orate's sliders, presets and lightning. Its licence lets you integrate or build upon it in personal or commercial projects, but not republish or redistribute it as-is — so keep it as part of Orate rather than extracting it on its own.
* **Music** comes from Apple's public iTunes Search API (the Apple Music catalogue and its 30-second previews); tracks and artwork belong to their artists and Apple.
* **Liquid glass** is a pure-CSS glass-button recipe — inset highlights, a blurred diagonal corner glow and a light backdrop blur.

## License

MIT — do what you like (with the exception of the Codrops rain effect noted above). Emoji data © Emojibase (MIT); GIFs and stickers by KLIPY.
