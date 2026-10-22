#!/usr/bin/env python3
"""Orata's music helper: YouTube Music search, charts and genre pages through ytmusicapi (https://github.com/sigma67/ytmusicapi).

The Node server (server/music.js) starts this once and talks to it over stdin/stdout, one JSON object per line:

    -> {"id": 7, "op": "search", "q": "daft punk", "limit": 24}
    <- {"id": 7, "ok": true, "result": [ ...tracks... ]}        or        {"id": 7, "ok": false, "error": "...", "code": "upstream"}

The first line it prints is {"ready": true, "version": "1.12.3"} (or {"ready": false, "error": "..."} when ytmusicapi is not installed).
Only public search and browsing are used, so no YouTube login or API key is needed. Audio is not fetched here: ytmusicapi only returns
metadata (YouTube hands out audio links that need its player to decode them), so the browser plays tracks in YouTube's own embedded player.

    python music-service/service.py --check      searches once and prints how many songs came back (is everything installed?)
Environment: MUSIC_COUNTRY (two letters, default US) picks the charts and the language of the catalogue.
"""
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, wait

for stream in (sys.stdout, sys.stdin):
    try:
        stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001 - an old Python or a wrapped stream: carry on with the default
        pass
LOCK = threading.Lock()


def out(obj):
    with LOCK:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")  # where install.mjs (run by `npm install`) puts ytmusicapi
if os.path.isdir(VENDOR):
    sys.path.insert(0, VENDOR)

try:
    import ytmusicapi
    from ytmusicapi import YTMusic
    from ytmusicapi.constants import SUPPORTED_LOCATIONS
    from ytmusicapi.parsers.browsing import parse_song_flat
except Exception as e:  # noqa: BLE001
    out({"ready": False, "error": f"ytmusicapi is not installed ({type(e).__name__}: {e}). Run: npm install   (or: pip install -r music-service/requirements.txt)"})
    sys.exit(2)

COUNTRY = (os.environ.get("MUSIC_COUNTRY") or "US").strip().upper()
if COUNTRY not in SUPPORTED_LOCATIONS:
    COUNTRY = "US"
yt = YTMusic(language="en", location=COUNTRY)

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


class Problem(Exception):
    def __init__(self, message, code="upstream"):
        super().__init__(message)
        self.code = code


def clamp(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def seconds(text):
    """'3:45' / '1:02:03' -> seconds"""
    try:
        total = 0
        for part in str(text).split(":"):
            total = total * 60 + int(part)
        return total
    except ValueError:
        return 0


def artwork(thumbs):
    """The biggest thumbnail; YouTube's own square covers are asked for at 400 px."""
    best = None
    for t in thumbs or []:
        if isinstance(t, dict) and t.get("url") and (best is None or (t.get("width") or 0) >= (best.get("width") or 0)):
            best = t
    if not best:
        return None
    url = best["url"]
    if "googleusercontent.com" in url or "ggpht.com" in url:
        url = re.sub(r"=w\d+-h\d+.*$", "=w400-h400-l90-rj", url)
    elif "ytimg.com" in url:  # a still from the video: the plain 16:9 one (the usual one has black bars above and below)
        m = re.search(r"/vi/([A-Za-z0-9_-]{11})/", url)
        if m:
            url = f"https://i.ytimg.com/vi/{m.group(1)}/mqdefault.jpg"
    return url


def track(d):
    """One ytmusicapi result (search, playlist, chart or watch-playlist shape) -> what Orata shows, or None when it can't be played."""
    if not isinstance(d, dict):
        return None
    vid = d.get("videoId")
    if not isinstance(vid, str) or not VIDEO_ID.match(vid) or d.get("isAvailable") is False:
        return None
    names = [a.get("name") for a in (d.get("artists") or []) if isinstance(a, dict) and a.get("name")]
    if not names and isinstance(d.get("artist"), str):
        names = [d["artist"]]
    album = d.get("album")
    album = album.get("name") if isinstance(album, dict) else album
    secs = d.get("duration_seconds") or seconds(d.get("duration") or d.get("length"))
    return {
        "id": vid,
        "title": str(d.get("title") or "Untitled")[:200],
        "artist": ", ".join(names)[:100] or "Unknown artist",
        "album": str(album)[:120] if album else None,
        "artwork": artwork(d.get("thumbnails") or d.get("thumbnail")),
        "url": f"https://music.youtube.com/watch?v={vid}",
        "duration": int(secs * 1000) if secs else 0,
        "explicit": bool(d.get("isExplicit")),
    }


def tracks_of(items, limit=50):
    """Mapped, without repeats (the same song is often listed twice by different uploads)."""
    seen, result = set(), []
    for item in items:
        try:
            t = track(item)
        except Exception:  # noqa: BLE001 - one odd item must not lose the list
            continue
        if not t:
            continue
        key = (t["title"].lower(), t["artist"].lower())
        if t["id"] in seen or key in seen:
            continue
        seen.add(t["id"])
        seen.add(key)
        result.append(t)
        if len(result) >= limit:
            break
    return result


_covers = {}  # (title, artist) -> the song's album cover (or None), so every song is looked up once


def plain(text):
    """'Sunflower (Spider-Man: Into the Spider-Verse)' -> 'sunflower': just the words that identify a song"""
    text = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", str(text).lower())
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def find_cover(t):
    """The album cover of the song version of `t` (found by searching its title and artist), or None."""
    key = (t["title"].lower(), t["artist"].lower())
    if key in _covers:
        return _covers[key]
    url = None
    try:
        names = {n.strip().lower() for n in t["artist"].split(",") if n.strip()}
        want = plain(t["title"])
        for r in yt.search(f"{t['title']} {t['artist'].split(',')[0]}", filter="songs", limit=5):
            have = {a["name"].lower() for a in (r.get("artists") or []) if isinstance(a, dict) and a.get("name")}
            got = plain(r.get("title") or "")
            if want and got and have & names and (got.startswith(want) or want.startswith(got)):
                url = artwork(r.get("thumbnails"))
                break
    except Exception:  # noqa: BLE001 - no cover found: the video still stays
        url = None
    _covers[key] = url
    return url


def with_covers(tracks, budget=6.0):
    """Charts and music videos only come with a still from the video. Swap in the song's real album cover, looking them up side by side for a few seconds at most
    (the ones not done in time finish in the background and are used the next time)."""
    todo = [t for t in tracks if t.get("artwork") and "ytimg.com" in t["artwork"]]
    pool = ThreadPoolExecutor(max_workers=8)
    futures = {}
    for t in todo:
        key = (t["title"].lower(), t["artist"].lower())
        if key in _covers:
            t["artwork"] = _covers[key] or t["artwork"]
        else:
            futures[pool.submit(find_cover, t)] = t
    done, _ = wait(futures, timeout=budget)
    for f in done:
        try:
            futures[f]["artwork"] = f.result() or futures[f]["artwork"]
        except Exception:  # noqa: BLE001
            pass
    pool.shutdown(wait=False)
    return tracks


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")


_moods = {"at": 0.0, "table": {}, "order": []}


def mood_table():
    """key -> {name, params, group} from YouTube Music's "Moods & genres" page, the popular genres first, then the moods (kept for six hours)."""
    import time

    if _moods["table"] and time.time() - _moods["at"] < 6 * 3600:
        return _moods
    table = {}
    for section, items in yt.get_mood_categories().items():
        group = "genre" if "genre" in section.lower() else "mood"
        for it in items:
            key = ("g-" if group == "genre" else "m-") + slug(it.get("title"))
            if it.get("params") and key not in table:
                table[key] = {"name": str(it["title"])[:40], "params": it["params"], "group": group}
    popular = ["pop", "hip-hop", "rock", "r-b-soul", "dance-electronic", "latin", "k-pop", "country-americana", "indie-alternative", "metal", "jazz", "classical",
               "chill", "focus", "workout", "party", "feel-good", "sleep", "romance", "energize"]   # what people look for first goes first; the rest follow alphabetically
    rank = lambda k: popular.index(k[2:]) if k[2:] in popular else len(popular)  # noqa: E731
    order = sorted(table, key=lambda k: (table[k]["group"] != "genre", rank(k), table[k]["name"].lower()))
    _moods.update(at=time.time(), table=table, order=order)
    return _moods


def top_songs():
    lists = yt.get_charts(COUNTRY).get("videos") or []
    pick = next((p for p in lists if str(p.get("title", "")).lower().startswith("top 100 music videos")), None) or (lists[0] if lists else None)
    if not pick or not pick.get("playlistId"):
        raise Problem("There is no chart for this country right now.", "unavailable")
    return with_covers(tracks_of(yt.get_playlist(pick["playlistId"], limit=60).get("tracks") or [], 40))


def trending():
    return with_covers(tracks_of((yt.get_explore().get("trending") or {}).get("items") or [], 40))


def songs_shelf(raw):
    """The rows of songs on a genre page (the first shelf made of song rows), parsed with ytmusicapi's own song parser."""
    try:
        sections = raw["contents"]["singleColumnBrowseResultsRenderer"]["tabs"][0]["tabRenderer"]["content"]["sectionListRenderer"]["contents"]
    except (KeyError, IndexError, TypeError):
        return []
    for section in sections:
        items = (section.get("musicCarouselShelfRenderer") or {}).get("contents") or []
        rows = [i["musicResponsiveListItemRenderer"] for i in items if isinstance(i, dict) and "musicResponsiveListItemRenderer" in i]
        if len(rows) < 3:
            continue
        parsed = []
        for row in rows:
            try:
                parsed.append(parse_song_flat(row))
            except Exception:  # noqa: BLE001
                continue
        return parsed
    return []


def category_tracks(entry):
    # ytmusicapi's get_mood_playlists only reads playlists, but a genre page lists songs directly, so read the page and use its song parser
    raw = yt._send_request("browse", {"browseId": "FEmusic_moods_and_genres_category", "params": entry["params"]})
    found = tracks_of(songs_shelf(raw), 40)
    if len(found) < 5:  # the page changed shape: a plain search for the category still gives something to play
        found = tracks_of(yt.search(f"{entry['name']} songs", filter="songs", limit=40), 40)
    return with_covers(found)


def op_search(p):
    q = str(p.get("q") or "").strip()[:100]
    if not q:
        raise Problem("Type something to search for", "bad_request")
    limit = clamp(p.get("limit"), 1, 50, 24)
    songs = yt.search(q, filter="songs", limit=limit)
    found = tracks_of(songs, limit)
    if len(found) < 8:  # few official songs: add music videos
        try:
            found = tracks_of([*songs, *yt.search(q, filter="videos", limit=limit)], limit)
        except Exception:  # noqa: BLE001
            pass
    return with_covers(found)


def op_categories(_):
    cats = [{"key": "top", "name": "Top Songs"}, {"key": "trending", "name": "Trending"}]
    try:
        m = mood_table()
        cats += [{"key": k, "name": m["table"][k]["name"], "group": m["table"][k]["group"]} for k in m["order"]]
    except Exception:  # noqa: BLE001 - the page still works with just the charts
        pass
    return cats


def op_category(p):
    key = str(p.get("key") or "")
    if key == "top":
        return top_songs()
    if key == "trending":
        return trending()
    entry = mood_table()["table"].get(key)
    if not entry:
        raise Problem("Unknown category", "not_found")
    return category_tracks(entry)


def op_song(p):
    vid = str(p.get("videoId") or "")
    if not VIDEO_ID.match(vid):
        raise Problem("Unknown track", "bad_request")
    try:
        found = track(((yt.get_watch_playlist(vid, limit=1).get("tracks")) or [None])[0])
    except Exception:  # noqa: BLE001 - an id that doesn't exist makes YouTube answer with an error page
        found = None
    if not found or found["id"] != vid:
        raise Problem("That song isn’t available.", "unavailable")
    return with_covers([found])[0]


OPS = {"search": op_search, "categories": op_categories, "category": op_category, "song": op_song, "ping": lambda p: "pong"}


def handle(line):
    try:
        req = json.loads(line)
    except ValueError:
        return
    if not isinstance(req, dict):
        return
    rid = req.get("id")
    try:
        fn = OPS.get(req.get("op"))
        if not fn:
            raise Problem("Unknown operation", "bad_request")
        out({"id": rid, "ok": True, "result": fn(req)})
    except Problem as e:
        out({"id": rid, "ok": False, "error": str(e), "code": e.code})
    except Exception as e:  # noqa: BLE001 - YouTube changed something, the network is down, ...: say so, keep running
        out({"id": rid, "ok": False, "error": f"{type(e).__name__}: {str(e)[:160]}", "code": "upstream"})


def main():
    if "--check" in sys.argv:
        found = op_search({"q": "daft punk", "limit": 5})
        print(f"ytmusicapi {ytmusicapi.__version__}: search works, {len(found)} songs, first: {found[0]['title'] if found else '-'}")
        return
    out({"ready": True, "version": getattr(ytmusicapi, "__version__", "?")})
    with ThreadPoolExecutor(max_workers=4) as pool:
        for line in sys.stdin:
            line = line.strip()
            if line:
                pool.submit(handle, line)


if __name__ == "__main__":
    main()
