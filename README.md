# Orata

A realtime chat app for the web — servers, channels, DMs, group chats, friends, GIFs, stickers, emoji, file sharing, voice & video — wrapped in a **fully customizable glass UI**: your own wallpaper with blur and dim, a WebGL **rain-on-glass** effect, glassy **liquid glass** buttons and panels, gradient or solid accent colors, and any **Google Font**.

The layout and behavior follow Discord's, with the bear mark as the logo.

## Quick start

**On Windows:** double-click **`start.bat`** — it installs dependencies on the first run, starts the server and opens your browser.

Or from a terminal:

```bash
npm install
npm start
```

Open <http://localhost:3000>, create an account, and you're in. The first account to register becomes the owner of the shared **Orata Community** server; everybody after joins it automatically. A built-in helper bot, **Orbit**, DMs every new user (say `help`).

Requires Node.js 20 or newer. Nothing else — there is no database to set up, data lives in `data/`. (Only the **Music** page also wants Python 3.10+ and one pip package, see [Music](#music-youtube-music--no-key-needed); without them everything else works.)

```bash
npm run dev                      # restart on file changes
npm test                         # backend self-tests (486 checks: auth, servers, messages, DMs, uploads, GIFs, settings sync, permissions, bans, emoji, forums, polls, stage channels, email verification …)
npm run reset-password <user>    # forgot a password? prints a new one
```

## Configuration (`.env`)

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Interface to listen on (`127.0.0.1` = this machine only) |
| `KLIPY_API_KEY` | – | Enables the GIF and sticker pickers (proxied server-side; the key never reaches the browser) |
| `MAX_UPLOAD_MB` | `25` | Largest file upload |
| `ACCOUNTS_PER_BROWSER` / `ACCOUNTS_PER_HOUR` | `3` / `3` | How many accounts one browser may have at a time, and make in an hour |
| `HTTPS_KEY` / `HTTPS_CERT` | – | Paths to a TLS key/cert to serve HTTPS directly |
| `TRUST_PROXY` | – | Set to `1` when running behind a reverse proxy |
| `STUN_URLS` | Google public STUN | Comma-separated STUN servers for voice & video |
| `TURN_URLS` | – | Comma-separated TURN relay URLs (`turn:` / `turns:`) — see [TURN relay](#turn-relay-for-voice--video) |
| `TURN_SECRET` | – | coturn `static-auth-secret`; Orata hands each user time-limited credentials |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | – | Fixed TURN credentials (use instead of `TURN_SECRET`) |
| `TURN_TTL` | `86400` | Lifetime of generated TURN credentials, in seconds |
| `ICE_TRANSPORT_POLICY` | `all` | Set to `relay` to force every call through TURN (testing / hiding IP addresses) |
| `MUSIC` | on | `MUSIC=off` turns the Music player off — see [Music](#music-youtube-music--no-key-needed) |
| `DISCORD_BOT_TOKEN` | – | Turns on the [Discord bridge](#discord-bridge): `/link` mirrors an Orata channel with a Discord channel |

> **Microphone, camera, screen sharing and desktop notifications only work on `localhost` or over HTTPS.** To use voice with other devices on your network, set `HTTPS_KEY`/`HTTPS_CERT`, or put Orata behind a TLS reverse proxy (Caddy, nginx, Cloudflare Tunnel …). Make sure it forwards WebSocket upgrades on `/gateway`.

## Email verification

An email address is **optional** when signing up: leave it blank and the account is created straight away with just a username and password (an address can be added, changed or removed later in *Settings → My Account*). Orata can make the people who *do* give one prove they own it: after filling in the sign-up form they get an email with a **6-digit code** and the account is only created once they type it in. It is **off until you configure it** — with nothing in `.env` the sign-up form just creates the account. When it is on, the server prints `Email verification: ON …` at startup (and `OFF …` when it isn't), so you can always tell.

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
MAIL_FROM=Orata <you@gmail.com>
PUBLIC_URL=https://chat.example.com   # where people reach Orata; used for links in emails (address changes)
# REQUIRE_EMAIL_VERIFICATION=true
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMTP_HOST` / `SMTP_PORT` | – / `587` | Your mail server. Port 465 with `SMTP_SECURE=true` uses TLS from the start; anything else upgrades with STARTTLS. |
| `SMTP_USER` / `SMTP_PASS` | – | Login (AUTH PLAIN / LOGIN). Credentials are never sent without TLS (loopback servers excepted). |
| `MAIL_FROM` | `Orata <SMTP_USER>` | The sender, e.g. `Orata <no-reply@example.com>`. Most providers require a verified sender or domain. |
| `PUBLIC_URL` | the address the request came to | **Set this in production.** Base of the verification *link* (used when someone changes their address later); without it Orata trusts the `Host` header of the request. |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Turn verification on even without SMTP (dev mode), and lock unverified accounts out (see above). |
| `EMAIL_TOKEN_TTL_HOURS` | `24` | How long a verification link works. (Sign-up codes always expire after 10 minutes.) |
| `SMTP_TLS_VERIFY` | `true` | Set `false` only for a self-signed certificate on a private mail server. |

**Check your settings without signing anyone up:** `npm run test-mail` connects to your mail server and logs in (sending nothing) and tells you what's wrong if it can't; `npm run test-mail you@example.com` also sends a real test email. Remember that lines in `.env` that start with `#` are comments and are ignored.

Working providers: Gmail or Google Workspace (create an *app password*; 2-step verification must be on), Outlook / Microsoft 365, Brevo, Mailgun, SendGrid, Postmark, Resend and Amazon SES — each shows its SMTP host, port and credentials in its dashboard.

**No mail server yet? Dev mode.** Leave `SMTP_HOST` empty and set `REQUIRE_EMAIL_VERIFICATION=true`: the email is printed in the terminal where Orata runs, code included — type it in. If someone has an *existing* unverified account and can't receive email, you can mark them verified yourself:

```bash
npm run verify-email <username>
```

How the sign-up code works: nothing is written to the database until the code is typed in (the half-finished sign-up only lives in server memory for 10 minutes); five wrong guesses cancel it; "Resend code" is limited to once a minute (five times in all), and only the browser that started the sign-up can finish it. Accounts created before you turned this on count as verified. Changing the email address later in Settings sends a verification *link* to the new address and marks the account unverified until it is clicked (links are random 256-bit tokens, stored hashed, single-use, verified through a POST so mail scanners that pre-open links can't use them up).

## TURN relay for voice & video

Calls are peer-to-peer. A STUN server (Google's public one by default) is enough on most home networks, but when someone is behind a corporate firewall, a symmetric NAT or mobile carrier-grade NAT, a direct connection is impossible and the call silently has no audio. A **TURN** server relays the media for those users.

Orata asks its own server for the ICE configuration every time you join a call (`GET /api/ice`), so TURN is configured once in `.env` and never hard-coded in the browser. *Settings → Voice & Video* shows whether a relay is configured.

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

2. Point Orata at it in `.env`:

   ```ini
   TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
   TURN_SECRET=CHANGE-ME-TO-A-LONG-RANDOM-STRING
   ```

   With `TURN_SECRET`, Orata generates short-lived credentials per user (coturn's "TURN REST API": username `<expiry>:<userId>`, credential `base64(HMAC-SHA1(secret, username))`), so nothing long-lived is ever sent to browsers. If you'd rather use a fixed account, set `TURN_USERNAME` and `TURN_CREDENTIAL` instead. Restart Orata afterwards.

3. Test it: set `ICE_TRANSPORT_POLICY=relay` temporarily — every call is then forced through TURN, so a working call proves the relay works. Remove it again afterwards (relaying everything costs bandwidth on your server).

Hosted TURN services (Cloudflare, Twilio, Metered …) work too: use the URLs and static username/credential they give you.

**The easy way — a hosted relay with a free tier (no server of your own).** If you host Orata somewhere like Render you can't run coturn there, but you can let Orata fetch short-lived relay credentials from a provider; just put the provider's key in `.env` (or Render's environment) and restart:

```ini
# Cloudflare Realtime TURN: Cloudflare dashboard → Realtime → TURN → create a key
CLOUDFLARE_TURN_KEY_ID=your-turn-key-id
CLOUDFLARE_TURN_API_TOKEN=your-turn-key-api-token

# …or Metered (Open Relay): dashboard → TURN Server → your app name and API key
# METERED_APP=your-app-name
# METERED_API_KEY=your-api-key
```

Orata asks the provider for credentials on the server (never from the browser), caches them, and hands them to people when they join a call. Check *Settings → Voice & Video* — it should now say a relay is configured.

**Calls: nobody can hear / see anyone?** Two people on the same home Wi-Fi usually connect directly, but school and public Wi-Fi often stops devices on it from reaching each other, so two friends sitting next to each other can both be stuck on *Connecting…* (the same relay fixes that). Across the internet the usual culprit is a network that blocks direct connections (mobile data, school / work Wi-Fi, some routers) and **no relay**. Orata shows *Connecting…* / *Can't connect* on each person's tile and explains it once with a message; the fix is the relay above. Also remember that the microphone, camera and screen share only work on `https://` or `localhost` (a plain `http://192.168…` address can listen but can't talk).

## Music (YouTube Music — no key needed)

The note icon above Home opens the **Music page** (`/music`): search YouTube Music or browse **categories** — Top Songs, Trending, the popular genres (Pop, Hip-hop, Rock, R&B & soul, Dance & electronic, Latin, K-Pop, Country, Jazz, Classical, Metal …, with the other ~30 behind *More*) and moods (Chill, Focus, Workout, Party, Sleep …) — press play, and what you're listening to shows on your profile (and in friends' *Active Now*) while it plays. A big *Now playing* card with the song's album cover, a mini player above your user bar and your recently played songs are always at hand. It plays **full songs** and needs **no account and no API key**.

**Artists, albums and playlists.** Click an artist's name anywhere on the Music page — or in someone's *Listening to* card on their profile — and their page opens right here in Orata (`/music/artist/<id>`): their picture and banner, listener numbers, their songs, and their **albums, singles and EPs**. Every album opens as its own page (`/music/album/<id>`) with its songs in the album's order, so songs are sorted into their albums wherever you meet them (the album name under a song links to it). A search also finds matching artists. Nothing opens a page on another website.

Make your own **playlists**: the **+** on any song (on a cover, in a list, or on the *Now playing* card) adds it to one of your playlists or starts a new one with it. *Your playlists* on the Music page lists them; each opens (`/music/playlist/<id>`) to play, rename, delete or take songs out of. Playlists belong to your account — **only you can see them** — and the server keeps them (up to 30 playlists of 300 songs each).

Orata finds songs with [ytmusicapi](https://github.com/sigma67/ytmusicapi) (MIT), an unofficial Python library for YouTube Music's public search and charts, and plays them in YouTube's own embedded player. So the **server needs Python 3.10 or newer** — but there is nothing to install by hand: **`npm install` sets it up** (it runs `music-service/install.mjs`, which puts the library into `music-service/vendor`, about 10 seconds). If the machine's own Python is missing or too old, the installer downloads a private Python 3.12 with [uv](https://github.com/astral-sh/uv) (about a minute, ~70 MB, kept in `music-service/python`); if there is no Python with pip at all it skips music and says so. The install never fails over music, and everything else in Orata works without it.

```bash
npm install                                  # also sets up music
python music-service/service.py --check      # optional: searches once, to show everything works
npm run music:update                         # update ytmusicapi later — worth doing if search stops working
```

**On Render, a Droplet or any host that runs `npm install` there is nothing to change** — the build command `npm install` is enough (the build log shows `music: …` lines, and the service log says `Music: YouTube Music through ytmusicapi` once it runs). Without Python the log says `Music: OFF — …` and the Music page tells people what is missing.

| Variable | Default | What it does |
| --- | --- | --- |
| `MUSIC` | on | `MUSIC=off` turns the music player off for everybody |
| `MUSIC_COUNTRY` | `US` | Which country's charts and catalogue YouTube Music shows (two letters, e.g. `GB`) |
| `MUSIC_API_PER_MIN` | `40` | The most requests Orata sends to YouTube per minute, however many people search |
| `MUSIC_PYTHON` | – | Path to the Python to use, when you don't want the one the installer picked |
| `MUSIC_INSTALL` | on | `MUSIC_INSTALL=off` stops `npm install` from setting up music (`MUSIC_INSTALL_MANAGED=1` always uses the private Python) |

**How it works:** the server starts `music-service/service.py` once and talks to it over stdin/stdout (a line of JSON per request); if it ever dies, the next request starts it again. Searches are cached for 10 minutes and charts for 30. ytmusicapi only returns *information* about songs (YouTube hands out its audio links in a form only its own player can decode), so the browser plays each song in YouTube's embedded player — a track id is a YouTube video id — which is kept on the page, parked out of sight in a corner of the window (on screen so the browser keeps the sound going, but invisible), so the music goes on while you move around. The app never shows the video or mentions where the songs come from; covers are YouTube Music's own album art.

**Good to know:**
* YouTube only plays embedded videos on pages with a real address: **`localhost` or a domain name**, not a bare IP number like `http://192.168.1.5:3000` — there the Music page says so. (Your domain with HTTPS, as in the Droplet setup, is fine.)
* Playback is YouTube's: an ad can play now and then, and a few songs can't be embedded (the player skips them). It is subject to YouTube's Terms of Service, which ask for a visible player — Orata hides it, so that is your call to make.
* ytmusicapi is unofficial and YouTube Music changes now and then. If search stops working, update it: `npm run music:update`.

**What others see:** the title, artist, artwork and a progress bar, only while it plays. They always come from YouTube Music via the server — a client can't make up a "listening to" status — and disappear when you pause, stop, close the last tab or the song ends. Nothing is shown when **Settings → Privacy → Show my status to everyone** is off or you are *Invisible* (the switch is also on the Music page). The player links every song back to YouTube Music.

## Discord bridge

Link an Orata channel with a Discord channel and they act as one conversation: messages, pictures, files, GIFs, stickers, replies, edits and deletes go both ways. Discord people show up in Orata with their Discord name and picture and a **DISCORD** tag; Orata people show up in Discord with their Orata name and picture (Discord adds its usual **APP** label). Mentions become plain names on the other side, custom Discord emoji plain `:name:` text, and nothing from Orata can ping anyone on Discord. Bots' messages and polls aren't mirrored. GIFs from Discord's GIF picker play as GIFs, and Discord stickers come across as stickers (Discord's own animated ones are played with [lottie-web](https://github.com/airbnb/lottie-web)). Discord can't show WebP profile pictures (Orata saves cropped pictures as WebP), so the bridge gives Discord a PNG copy, made once per picture with [sharp](https://sharp.pixelplumbing.com).

**Set it up once (the host):**
1. On the [Discord Developer Portal](https://discord.com/developers/applications) make a **New Application** (call it Orbit and give it Orbit's picture if you like).
2. On its **Bot** page, switch on **Message Content Intent** (under *Privileged Gateway Intents*), then **Reset Token** and copy the token.
3. Put it in `.env` (or your host's environment) as `DISCORD_BOT_TOKEN=…` and restart Orata. The console says `[discord] connected as …`. Keep the token secret: anyone with it controls the bot.
4. Discord loads Orata people's pictures from Orata's public address: `PUBLIC_URL` when it's set, otherwise the `https://` address `/link` was typed at. (From `localhost` Discord can't reach them, so it shows its default picture.)

**Link a channel (any admin):** Orbit has to be in the Orata server. In the Orata channel type **`/link`** (needs *Manage Server*): Orbit privately gives you a code that works for 10 minutes, plus a link to add the bot to your Discord server if it isn't there yet. In the Discord channel, someone with *Manage Server* types **`/orata-link code:XXXX-XXXX`**. To stop, type `/unlink` in Orata or `/orata-unlink` in Discord. Links and unlinks go in the audit log.

**Limits:** files bigger than `MAX_UPLOAD_MB` (from Discord) or 10 MB (to Discord) come across as links. Text over 2,000 characters is split for Discord. Edits and deletes sync for the last 3,000 messages of each link. On a host that sleeps (Render's free plan, after 15 minutes without visitors), the bot is offline while Orata sleeps: when it wakes up it posts what was said on Discord in the meantime (up to 500 messages per channel), and Discord's commands only answer while Orata is awake. `KEEP_AWAKE=1` makes Orata visit its own address every 10 minutes so it doesn't sleep (it then uses the host's free hours around the clock: Render gives 750 a month across all your free services). `/link-instructions` says when the bot is offline or can't log in.

## Free hosting with a free database

Hosts like Render's free plan wipe the app's folder on every restart, so Orata's usual `data/` folder would lose everything. Set **`DATABASE_URL`** and Orata keeps *all* its data — accounts, servers, messages, sessions and uploaded files — in a PostgreSQL database instead (a free one is enough). Without `DATABASE_URL` nothing changes: it uses local files.

**1. Make the free database.** Create a project on [Neon](https://neon.tech) (or [Supabase](https://supabase.com)); neither needs a card. Copy the *connection string* — it looks like `postgresql://user:password@host/dbname?sslmode=require`. Orata creates its two tables (`orate_state`, `orate_files`) by itself.

**2. (Optional) bring your existing data.** Put the connection string in your local `.env` and start Orata once:

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
- **Stuck on "Connecting…"?** The server log looking fine (`Orata is running … :10000`) only proves the server started. Usually the browser is holding a login the server no longer knows (a free instance that lost its data, or a different database) and Render's proxy hides the "your login is invalid" reply, so the page retried forever. Current Orata recovers by itself (it signs you out after a few failed tries and the loading screen offers *Try again* / *Sign out*). On an older version, open the site in a private window or clear the site's data once (browser dev tools → Console → \`localStorage.clear(); location.reload()\`). Also open \`https://<your-service>.onrender.com/api/config\`: if that shows JSON, the server is up.
- **Logins don't expire.** You stay signed in until you log out (or change your password, which signs out your other devices). With Postgres each login is saved in its own table the moment you sign in, so a restart, a deploy or an update can't sign anyone out.
- **Run one Orata per database.** Orata keeps live state (who is online, voice calls) in memory, so two servers can't share a database. If a second one writes, the stale one *refuses to overwrite* and exits so it restarts with the newest data — don't leave your PC's copy running against the same database as Render.
- **Storage:** the database holds the whole chat history as one compressed record plus your uploads; the free tier's ~0.5 GB goes a long way for a friend group. `npm run db:info` shows what's used.
- **Backups / leaving:** `npm run db:export` writes `data/db.json` and `data/uploads/` from the database (an existing `db.json` is backed up first), and that folder runs as a normal local Orata.
- Your Postgres password is as sensitive as the data: keep `DATABASE_URL` out of git.

## What's inside

**Chat** — servers with categories, text & voice channels, roles & permissions with **per-channel and per-category permission overwrites** (see below), invites (expiry / max uses) that show up in chat as a server card with live Online / Member counts and a **Join** button, kicks, **timeouts** and **bans that follow the person's browser** (see *Moderation* below), nicknames, **GIF server icons and big GIF banners**, **custom emoji & stickers**, **forum channels** and **polls**; **server folders** — drag one server onto another (or use the server menu → *Server Folder*) to group them, rename / recolour the folder, drag servers in and out; **several accounts** on one device with a Discord-style *Switch Accounts* menu (Add / Manage Accounts); DMs and group DMs; friends, requests, blocking; replies, edits, deletes, pins, reactions; unread markers and mention badges; typing indicators; message search with filters; markdown (bold, italic, underline, strike, spoilers, quotes, headings, lists, code blocks with syntax highlighting, timestamps); `@user`, `@role`, `#channel` and `:emoji:` autocomplete; slash commands (`/shrug`, `/me`, `/spoiler`, `/gif`, `/poll`, `/theme`, `/cloak`, `/nick` …); link previews with inline YouTube; images, video and audio inline with a lightbox; drag-and-drop & paste uploads with progress; GIFs and stickers from KLIPY (picking one stages it in the message box like an upload — you press send; a sent GIF is shown whole, at its own shape and without rounded corners, and the **star** on it — or on any GIF in the picker — saves it to your **Favorites**, the first category of the picker, which follows your account); a full emoji picker with skin tones and "frequently used".

**Channel & category permissions** — right-click a channel or category → *Edit Permissions*. Pick a role or a member and set each permission to **Allow**, **Deny** or **Inherit**, exactly like Discord: the order is server permissions → @everyone → the member's roles → the member themselves, an Allow from a role beats a Deny from another role, and a channel you can't *View* grants nothing (that is also how private channels work; the *Private Channel* switch is a shortcut for it). Channels inside a category are **synced** with it — change the category and every synced channel follows. Changing a synced channel's permissions **unsyncs** it (the banner shows *Not synced*); *Sync Now* re-adopts the category's, *Unsync* detaches a copy. Only people with *Manage Permissions* can edit, they can't grant what they don't have, and they can't touch roles at or above their own. Everything is enforced on the server (messages, reactions, attachments, @everyone, voice) and the member list of a channel updates live.

**Audio messages** — the mic button in the message box records an audio message of up to **3 minutes** (it stops by itself at 3:00; throw it away or keep it, then send). Dropping or picking an audio file (MP3, WAV, OGG, M4A, FLAC…) turns it into an audio message too, and one longer than 3 minutes isn't allowed. Audio messages play in a little player and **delete themselves a day after they are sent** — the audio file is deleted from the server as well; a message that also had text keeps the text.

**Account limits** — one browser can have at most **3 accounts at a time** and make at most **3 an hour**; the 4th in an hour is told how many minutes to wait. "One browser" is the browser id Orata already keeps for bans (never the network, so a shared school or home connection doesn't block anyone). Both numbers can be changed (`ACCOUNTS_PER_BROWSER`, `ACCOUNTS_PER_HOUR`).

**Orbit in your server** — tick *Add Orbit* when you create a server (or use *Server Settings → Overview → Orbit* later) and the server gets its own Orbit that answers slash commands: `/help`, `/ping`, `/roll 2d6`, `/flip`, `/8ball`, `/choose a | b`, `/joke`, `/remind 10m stretch`, and for moderators `/say`, `/reactionroles`, `/kick @member [reason]`, `/ban @member [reason]` and `/timeout @member 10m [reason]` (a member can be an @mention, a username or an ID). `/help`, `/ping`, reminders being set and any error are shown **only to you** ("Only you can see this"); everything else is posted for the channel. `/settings` (Manage Server) changes that server's Orbit's **name, picture and about text** — it is its own bot, so everyone's DM Orbit stays the same — and **which roles may use each command**: by default a command needs its permission (Kick, Ban, Timeout Members, Manage Messages for `/say`), and picking roles narrows it to them; owners and admins can always use everything.

**Server tags** — an admin gives the server a tag of up to 5 letters or numbers with an icon and a color (*Server Settings → Overview*; it can be changed once a week). Members can wear one server's tag next to their name — in messages, the member list and on their profile — from *User Settings → Profile* or the server menu (*Wear server tag*). Leaving the server takes it off; hovering it shows which server it belongs to.

**Discord bridge** — `/link` (Orbit) mirrors a channel with a Discord channel both ways, with names, pictures, files, replies, edits and deletes (see [Discord bridge](#discord-bridge)).

**Custom invite link** — *Server Settings → Invites* lets an admin pick one custom link for the server, like `yoursite.com/invite/my-server` (3–32 letters, numbers or dashes; it works however it's typed). It never expires, every server's link is unique, each person (every account on one browser) can have a custom link on one server only, and it can be changed only once every 7 days — the old link stops working when it changes. It's also shown in the *Invite People* dialog, and every change is in the audit log.

**Forwarding** — *Forward* in a message's menu sends a copy to any channel or DM you can post in, with an optional note of your own. It shows as "Forwarded" with who said it, where and when; forwarding a forwarded message passes on the original. You can only forward what you can see, and the place it goes to applies its own swearing protection and AutoMod. Audio messages aren't forwarded (they expire). **The gray line under a forward** ("Maker · #general · [server icon] Design Lab · Today at 7:44 PM") is a link: click it and Orata opens the original message in its channel and scrolls to it (for a forward of a forward, the very first message). If you can't see that channel (a server you aren't in, or a channel you have no access to) the line is plain text. If the original was deleted, clicking says so and leaves you where you are.

**Reaction roles** — `/reactionroles` (needs Manage Roles) opens a small editor: write a message and pair emojis with roles, and Orbit posts it with one reaction per role. Clicking a reaction gives that role, taking it back removes it. Roles above your own, and administrator roles, can't be handed out this way.

**Onboarding** — *Server Settings → Onboarding* sets up a rules screen: newcomers read the rules and pick roles (each with an emoji and a description) before they can talk — until then they can read but not send messages, react or join voice. People already in the server aren't asked. Anyone can change their picks later from the server menu (*Rules & roles*). Only roles that grant nothing beyond the default permissions can be offered.

**AutoMod** — *Server Settings → Safety & AutoMod* can block links, invite links (Orata or Discord), messages with too many mentions, and spam (5 messages in 5 seconds, or the same message 3 times in 30 seconds), and can time rule breakers out (1 minute to 1 day). Blocked messages are never posted; the sender is told why. It also checks edits, forum posts and what Orbit would repeat for someone. The owner, admins and people who can manage messages are never checked.

**Audit log** — *Server Settings → Audit Log* (Manage Server) lists who did what: kicks, bans and unbans, timeouts, role and nickname changes, channel, role, server and invite changes, deleted and pinned messages, Orbit changes, reaction roles, and every message AutoMod blocked (with a short excerpt) — with the reason when one was given. Filter by members, roles, channels, messages, AutoMod or server. The last 500 entries per server are kept.

**Badges** — profiles show badges next to the name (hover one for its name): Orata Developer, Orata Staff, Moderator, Early Supporter, Bug Hunter, Verified, Artist, Partner and **Creator** (a paintbrush) are built in. Whoever has the *Orata Developer* badge is a developer: right-click anyone → *Edit Badges* to give or take their badges, or make a custom badge (a name, an icon or an emoji, and a color) — deleting a custom badge takes it from everyone. A developer can't take the developer badge from themselves, so there is always one. The first developers are `oratedev` and Orate_dev (set once when the server starts, `server/badges.js`). The **Creator** badge (given in *Edit Badges* like any other) is one of the three that let someone post themes on Discovery, with the Orata Developer and Orata Staff badges (below).

**Co-owners** — a server can have co-owners (`coOwners` on the server): they get the crown in the member list and every permission, sit above every role, and can't be kicked, banned or timed out; deleting or transferring the server stays the owner's alone. Orate_dev co-owns the Orata Community server.

**Moderation** — *Ban* asks for an optional reason (only moderators see it) and whether to delete the person's recent messages (last hour … 7 days); the *Bans* page shows who banned them, when and why. **A ban follows the person's browser, not their network.** For every account Orata remembers keyed one-way hashes (HMAC with a secret kept in the database) of up to eight browsers it was used from — never the ids themselves, and nothing is shown to anyone. A browser is recognised by a random id it keeps in two places — local storage and a first-party cookie, each restoring the other — and sends as `X-Orata-Device`; clearing just one of them does not reset it, clearing all site data or using a private window does. Banning an account also bans **every other account that was used from one of those browsers (its alts)** — they show up in the ban list as *Alt of …*, and the ban dialog has a switch to ban just the one account — and a brand-new account made in that browser can't join: not through an invite, and not through the community server every new account would otherwise join automatically. The owner's and the banning moderator's own browsers are never used, and *Unban* frees the person and their alts together. **Networks are ignored completely**: two people on the same Wi-Fi (a school, a café, a family, a phone carrier) are never linked, and Orata no longer stores any IP address hash. This is a deterrent, not a wall: a private window, another browser or another device gets around any ban. **Timeouts** (member menu → *Timeout*: 60 seconds … 1 week, needs *Timeout Members*) let someone read but not talk, react, join voice or upload until they expire — and they apply to the person's alts too, including accounts that join from the same browser while it lasts. Timed-out members show a small clock in the member list.

**Swearing protection & GIF permission** — Server Settings → *Safety* has a swearing filter that is **off by default**. *Hide the words* turns swear words into f∗∗∗ and still sends the message; *Block the message* refuses it and tells the person why. It catches repeated letters, symbols between letters and look-alike characters (f.u.c.k, sh1t) but never ordinary words ("class" is fine), covers messages, edits, polls and forum posts (not DMs), lets you add your own blocked words, and never filters the owner or administrators. The **Send GIFs & Stickers** permission (on for everyone by default; existing servers keep working) controls the GIF and sticker pickers — per role or per channel; without it the picker shows emoji only.

**Tab cloak** — Settings → *Cloak* makes the browser tab look like another site: pick one of 26 (Google, Google Drive, Gmail, Docs, Sheets, Slides, Classroom, Calendar, Meet, YouTube, Wikipedia, Khan Academy, Desmos, Canvas, Schoology, Clever, Quizlet, Kahoot, Outlook, Teams, Zoom, PowerSchool, IXL, GitHub …) or give your own title and icon link. It is remembered on this device and applied as soon as the page loads, even on the sign-in screen; the app can't override it. **Open in about:blank** opens Orata inside a blank tab (the address bar shows `about:blank`) wearing the cloak, and can send the original tab to another site. If nothing opens your browser blocked the pop-up — allow pop-ups for the site. (Site icons are fetched once by your own server through its image proxy, so your browser never contacts those sites.) Typing **`/cloak`** in any chat does it in one go: this tab becomes Desmos and Orata opens in an about:blank tab wearing the same cloak.

**Custom emoji & stickers** — Server Settings → *Emoji* / *Stickers* (needs *Manage Expressions*): upload PNG, JPEG, GIF or WebP up to 512 KB (up to 50 emoji and 30 stickers per server; GIFs animate). Use them anywhere in the server by typing `:name:` (autocomplete suggests them), from the emoji picker, as reactions, or send a sticker from the sticker picker. Messages carry their emoji pictures with them, so they keep showing even if the emoji is deleted later or you view them from another server.

**GIF icons & banners** — the server icon and the (now much bigger, 16:9) banner can be an uploaded GIF or one picked from KLIPY with *Choose a GIF*; animated pictures play everywhere.

**Forum channels** — create a *Forum* channel: every topic is its own **post** with a title, tags and a first message, and replies happen inside the post like a normal channel. Posts can be sorted by recent activity or creation date, filtered by tag and searched; moderators can pin and lock posts (the post's author can lock their own and rename it), and a forum can *require a tag* and show guidelines above the new-post form. Posts follow the forum's permissions (private forums keep their posts private), and links to a post open it directly.

**Polls** — the `+` button next to the message box → *Create Poll* (or `/poll`): a question with 2–10 answers, a duration from 1 hour to 2 weeks and an optional multiple-choice mode. Votes update live and results are shown as bars; **click the number of votes** to see who voted for which option. The author or a moderator can end a poll early.

**Sharing your theme** — type `/theme` (or `/theme My Midnight look` to name it) in any channel or DM and your current look — colours, panels, wallpaper, rain, glass, fonts and chat options — is posted as a card with a little preview. Anyone can press **Apply Theme** to try it; the same button then turns into **Undo** and puts back exactly the settings it changed (it survives a reload). Your saved wallpapers and your *Reduce motion* choice are never shared or overwritten. Because a theme arrives in a message, every setting is re-checked before it is applied: unknown settings, colours that aren't colours, wallpaper links that aren't images and anything that could break out of a style value are dropped, and numbers are clamped to what the settings sliders allow.

**Theme library & Discovery** — the **globe** at the top of the server rail (above Music) opens the **Discovery** page (a tab of its own, like Music, at `/themes`): *Browse* shows themes other people made and *My library* (`/themes/library`) is yours; both have two tabs, **Profile themes** and **Site themes**, and a sort: Discovery is **Featured** by default (the most upvoted themes first, newest first among equals), or Random (it keeps its order while you scroll; the shuffle button reshuffles) or Alphabetical; My library is Alphabetical or Random. Each Discovery card is a preview picture, the theme's name, an **upvote** button with its count (not on your own themes), the poster's picture and name in gray, and an **Install** button; on your own saved themes the things you do less often — rename, post, delete — are in the ⋯ menu in the picture's corner, which a right click on the theme opens too; installing copies the theme into your library ("Installed" afterwards, and a clear message when the library is full).
* *Library* — every account has a private library on the server (so it follows you to your other devices; an open window refreshes when you change it on another device): **up to 25 profile themes and 25 site themes, 50 in all, enforced by the server**. *Save my current look* (here, in Settings → Theme, or *Save to library* in Settings → Profile's style section) saves it under a name; **Apply** puts a theme on (**Undo last theme** puts back what it replaced); the pencil renames, the bin deletes.
* *A site theme keeps everything that makes the site look the way it does*: theme colours (mode, accent and gradient, panels with their colour / gradient / opacity / blur / saturation, corner radius, gap, text colour), the wallpaper (a built-in one, your own picture, a gradient or a colour, with blur, dim, brightness, saturation, zoom, position and parallax), rain on glass, liquid glass (intensity and every part it applies to), the button effects, all three fonts with size, weight, line height and letter spacing, the animation speed, and how chat looks (compact, avatars, spacing between groups, large emoji). Not in it, because they are personal: your saved wallpapers, *Reduce motion* and the other accessibility switches, language, and the chat options about what is fetched (link previews, GIF autoplay, 24-hour time). A **profile theme** is your profile style (`sanitizeProfileStyle`: card colours / gradient / **picture or GIF**, outline, shadow and glow, name and text fonts, name colour, outline and shadow, rainbow switches, effect) plus your **banner** (its picture or GIF and its two colours) when you have one — not your avatar or bio. Applying a theme that has a banner sets your banner (picture or GIF and colours); one without a banner leaves yours alone.
* *Pictures and GIFs keep working.* A wallpaper, a profile-card picture or a banner you uploaded (a GIF too) is copied into a file the theme owns (`th_<id>.<ext>` in the uploads, so also in the database when `DATABASE_URL` is set) and checked to be a real picture (PNG, JPEG, WebP, GIF or AVIF; never SVG); a GIF stays a GIF that moves (up to 15 MB), other very big wallpapers are cut down to 2560 pixels wide, and the same picture in many themes is kept once. A wallpaper you set from a web link is fetched by the server (it never reaches into the server's own network) and kept the same way; when the link can't be fetched, or isn't a picture, the theme keeps the link. Installing a theme shares those files. A sweep (at start-up and every 6 hours) removes theme files that no library theme, posted theme, worn wallpaper, card picture or banner uses any more and that are over a day old (`THEME_FILE_GRACE_MS` changes the day).
* *Previews are drawn in your browser* from the theme itself (`public/js/theme-preview.js`, no screenshot service): a site theme is a picture of Orata — the wallpaper with its blur, dim and rain, frosted or glass panels, the rail, channel list, a few messages and the message box, in the theme's colours and fonts; a profile theme is a profile card for a gray "User" with the theme on it (including a still frame of its effect). The picture is uploaded when the theme is saved (and drawn again later for any theme that has none) and is stored like other uploads, as a WebP at most 720 pixels wide.
* *Posting* — people with the **Creator** badge and Orata staff and developers (the Orata Staff and Orata Developer badges) can post. Press the **+** tile at the start of Discovery to pick one of your saved themes (or the look you have now), give it a title and post it, or press the **+** next to one of your saved themes in My library to set its title and post it. It is posted with its preview picture, the title you chose and your name and picture; **Remove** takes it back down (people who installed it keep their copy). A theme you installed can't be posted again, so only the maker posts. Anyone can upvote a theme once (not their own); Orata staff can take any theme down (it goes in the staff log); deleting an account removes its posted themes. Taking the badge away stops new posts but leaves what was already posted up.
* The server side is `server/themes.js` (routes `/api/themes/library…` and `/api/themes/discover…`); what a theme holds, and its checker (shared with the browser, like `profile-data.js`), is `public/js/theme-data.js`; the Discovery page is `public/js/themes.js`. Tests: `server/selftest-themes.js`.

**Voice & video** — WebRTC mesh calls in voice channels and DMs, speaking indicators, mute / deafen, camera, screen share (with audio), per-user volume, push-to-talk, noise suppression, echo cancellation, device pickers and a mic level test. The call grid always fits the screen — tiles change shape as people join or leave, a shared screen gets the big area with everybody else in a strip below it, and nothing scrolls. Incoming-call ring for DMs. Connects peer-to-peer using STUN; add a [TURN relay](#turn-relay-for-voice--video) for people behind strict NATs or firewalls.

**Stage channels** — create a *Stage* (Create Channel → Stage) for a talk: a few **speakers** are on stage and everybody else is in the **audience**, listening. Whoever manages the channel or can time members out (the owner, administrators, anyone with *Manage Channel* / *Timeout Members*) opens an empty stage by joining it; everyone else joins muted, with no microphone or camera, and can **raise their hand** (the button, or the mic button in the sidebar). Moderators see raised hands first — oldest first — and press **Invite to Speak** (or right-click anyone); a speaker starts muted, can unmute, turn on a camera or share a screen, and can **Move to Audience** at any time, while moderators can send other speakers back. The stage holds up to 10 speakers; the *Speak* permission is what lets someone raise a hand or take the stage, and anyone who loses it (role or channel change) steps down by themselves. Audio and video only travel where a speaker is involved — listeners connect to speakers and never to each other, and the server refuses anything else — so a big audience costs the speakers, not the other listeners. The channel topic is shown on the stage (Edit Channel → *Stage topic*). Stage channels follow the same channel permissions as voice channels.

**Music** — a full Music page with YouTube Music search, charts, genres and moods and a full-song player (YouTube's embedded player) behind the note icon above Home (no key needed; needs Python and ytmusicapi on the server), and a "Listening to" card on your profile (see [Music](#music-youtube-music--no-key-needed)).

**Customization** (User Settings → Appearance) — new accounts start with a slate-blue dark theme, the Snow Peaks wallpaper, light rain and the Montserrat font; everything below can be changed. The sign-in and sign-up screens always show this default look (a new account starts from it too), and your own look returns when you log in.

* **Theme** — dark / light / midnight / system, solid or gradient accent, solid or gradient panels, panel opacity, panel blur, saturation, corner radius, spacing, custom text color.
* **Wallpaper** — 8 built-in gradients, 6 photos, your own upload or image link, solid color or custom gradient; live brightness, saturation, zoom, position, mouse parallax, and two separate blur controls: **Wallpaper blur** (the picture itself) and **Panel blur** (the frosted glass of the panels in front of it). Both default to subtle values — set them to 0 for a crisp wallpaper.
* **Rain & Glass** — the original Codrops raindrop effect (see [credits](#credits)) with weather presets (Rain / Drizzle / Storm / Fallout) and sliders for amount, drop size, speed, refraction, mist, wet trails, tiny droplets, lightning and frame rate; plus **liquid glass** — buttons, rails, the message box and menus, windows and toasts get bright inset edges on opposite corners, a thin dark inner edge, a soft blur and a blurred glow in two corners, and buttons lift on hover and press in when clicked. It is plain CSS (no WebGL, so it costs almost nothing). It is **off by default**; switch it on, set how bright it is and pick which areas it covers.
* **Button effects** — press ripples and particle bursts (send, reactions, toggles, confirmations, colour swatches), with an intensity slider; all of it off under *Reduce motion*.
* **Fonts** — search the whole Google Fonts catalogue; every font is previewed in its own typeface. Separate interface, chat and code fonts, plus size, weight, line height and letter spacing.
* **Chat** — compact mode, 24-hour time, link previews, GIF autoplay, large emoji.
* Themes can be exported / imported as JSON. Settings sync to your account, so your look follows you.
* **Profile** — animated avatars and banners: upload a GIF or pick one from KLIPY (it's downloaded once and stored on your server); the banner's gradient has two colors you choose. Every picture you upload for an avatar, banner or server icon opens in a crop dialog where you drag it into place and zoom — like Discord's, the whole picture is shown and everything outside the frame is dimmed, so you see what will be cut off; a banner then shows at exactly that shape (3 : 1) on every profile card — **GIFs too**: every frame gets the same crop and the animation is kept (done in the browser with WebCodecs, so Chrome and Edge; other browsers upload the GIF as it is). A GIF picked from KLIPY can be positioned the same way. **Profile style** (User Settings → Profile, with a live preview): card **colors, gradients or a picture** (one of your own uploads, or a GIF, shown behind the whole card at the opacity you choose); an **outline** (solid / dashed / dotted / double, or a gradient) with a **shadow & glow**; **fonts** for your name and your text (28 Google fonts — just pick one, no switch); a **name style** like Discord's — a color or **gradient** fill, a solid or **gradient outline**, and a **shadow with its own angle, distance, blur and color**; and an animated **effect** from 35 — solar rays, ocean, aurora, sparkles, glitter, stars, warp speed, galaxy, shooting stars, snow, rain, lightning, mist, embers, hearts, bubbles, bokeh, confetti, fireworks, butterflies, petals, autumn leaves, sakura (falling cherry blossoms), lanterns, balloons, ripples, underwater, disco, spotlights, vaporwave, equalizer, plasma, retro CRT, matrix and pixels. Every effect shows a live preview in the picker and you choose its colors, amount, speed and opacity. Each colored part — card colors, outline, shadow, name color, name outline, name shadow and the effect — has a **Rainbow** switch that cycles it through every hue (still under *Reduce motion*). Your name style shows everywhere your name does — messages, replies, the member list, DMs, friends, voice — and a styled name color takes the place of your role color. A profile you open is solid (never see-through) and always fits on screen. Everything is validated on the server and again in the browser (`public/js/profile-data.js`), and effects stand still under *Reduce motion*. The *unsaved changes* bar floats over the bottom of the screen on every settings page.
* **Default avatars** — everyone who has not uploaded a picture gets their own random, good-looking gradient behind the Orata logo (every default avatar got one once, when this arrived); *Settings → Profile → Shuffle color* picks another.
* Also: custom status, 12 interface languages, accessibility options, notification sounds.

Everything is smooth by default; **Reduce motion** turns most animation (and the rain) off. If the GPU can't keep up, Orata automatically turns liquid glass off once per session.

## Wallpapers & the image proxy

The six photo wallpapers are loaded through a small image proxy (`/api/img`) that fetches the original once, caches it in `data/imgcache/`, and serves it same-origin. That makes them work offline afterwards and lets the WebGL rain effect sample them (cross-origin images can't be read by WebGL). The proxy only serves images, blocks private network addresses, and caps file size. If a host refuses server-side fetches (e.g. behind bot protection), Orata retries with a plainer user agent, and failing that shows the image directly and simply skips the rain effect for it.

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
  music.js      YouTube Music search, charts, artist and album pages, your playlists and the "listening to" status, through the Python helper below
  discord.js    the Discord bridge: gateway connection, /link codes, mirroring both ways
  badges.js     profile badges: the catalog, developers (the "dev" badge) and their routes (and staff giving the "creator" badge)
  themes.js     the theme library and Discovery: routes, theme pictures kept as files of their own, previews, the sweep of unused theme files
  automod.js    AutoMod's rules (links, invites, mentions, spam)
  orbit.js      a server's own Orbit: its slash commands (shared list: public/js/orbit-commands.js), /settings and reminders
music-service/
  service.py    the music helper: ytmusicapi behind a line-of-JSON-per-request pipe (requirements.txt: the one pip package)
  install.mjs   what `npm install` runs to set it up (the library into vendor/, or a private Python when the system one is too old)
public/
  js/           Preact + htm (vendored, no build step), ES modules (rain.js, fx.js: rain, button particles; voice.js / stageview.js: calls and stages; music.js / music-pages.js / youtube-player.js: the Music page, its artist, album and playlist pages, and YouTube's embedded player)
  css/          base · layout · chat · ui · features · settings · auth · extras · themes
  img/rain/     drop textures for the rain effect
  data/         emoji dataset (generated from Emojibase)
```

* **No build step.** The browser loads native ES modules; `public/vendor/preact-htm.js` is Preact + htm in one file.
* **Realtime** — the client keeps one WebSocket (`/gateway`); mutations go through REST and are fanned out as events.
* **State** — one small reactive store with selector subscriptions; settings sync to the server and persist locally.
* **Storage** — `data/db.json` (atomic writes, debounced) and `data/uploads/`. Back up the `data/` folder.

## Security notes

Passwords are hashed with scrypt; sessions are random 256-bit tokens (stored hashed, with no address attached). No IP address (or hash of one) is kept anywhere. The only thing remembered for bans is, per account, keyed one-way hashes of the random ids of the browsers it was used from (up to eight) — used solely to make server bans stick (see *Moderation*), never shown or returned by the API, and useless without the secret stored in the database. Message content is escaped by Orata's own markdown renderer before it reaches the DOM, uploads are served with a sandboxing CSP and non-media files download instead of rendering, link previews and the image proxy refuse private addresses, and a strict Content-Security-Policy is sent with every page. Auth and message endpoints are rate limited. Orata is designed for small/medium communities and self-hosting; put it behind HTTPS before exposing it to the internet.

## Credits

* **Rain on glass** is a port of Lucas Bebber's [Rain & Water Effect Experiments](https://tympanus.net/codrops/2015/11/04/rain-water-effect-experiments/) (Codrops, 2015): the drop simulation, the drop textures (`public/img/rain/`) and the water shader come from the [original project](https://github.com/codrops/RainEffect), adapted into a single ES module with Orata's sliders, presets and lightning. Its licence lets you integrate or build upon it in personal or commercial projects, but not republish or redistribute it as-is — so keep it as part of Orata rather than extracting it on its own.
* **Discord's animated stickers** are played with [lottie-web](https://github.com/airbnb/lottie-web) (MIT, `public/vendor/lottie_light.min.js`, license in `public/vendor/lottie-web.LICENSE.md`).
* **Music** is found with [ytmusicapi](https://github.com/sigma67/ytmusicapi) by sigma67 (MIT, installed with pip, not bundled) and plays in YouTube's embedded player; songs, artwork and videos belong to their artists and YouTube.
* **Liquid glass** is a pure-CSS glass-button recipe — inset highlights, a blurred diagonal corner glow and a light backdrop blur.

## License

MIT — do what you like (with the exception of the Codrops rain effect noted above). Emoji data © Emojibase (MIT); GIFs and stickers by KLIPY.
