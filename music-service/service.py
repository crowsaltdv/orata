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
BROWSE_ID = re.compile(r"^[A-Za-z0-9_-]{8,40}$")  # an artist (UC...) or an album (MPREb_...) id


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


def artist_refs(d):
    """[{name, id}] — the id is what opens the artist's page (None when YouTube Music has none, e.g. "Various Artists")."""
    refs = []
    for a in d.get("artists") or []:
        if isinstance(a, dict) and a.get("name"):
            aid = a.get("id")
            refs.append({"name": str(a["name"])[:60], "id": aid if isinstance(aid, str) and BROWSE_ID.match(aid) else None})
    return refs[:6]


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
    album_id = album.get("id") if isinstance(album, dict) and isinstance(album.get("id"), str) and BROWSE_ID.match(album["id"]) else None
    album = album.get("name") if isinstance(album, dict) else album
    secs = d.get("duration_seconds") or seconds(d.get("duration") or d.get("length"))
    return {
        "id": vid,
        "title": str(d.get("title") or "Untitled")[:200],
        "artist": ", ".join(names)[:100] or "Unknown artist",
        "album": str(album)[:120] if album else None,
        "albumId": album_id,
        "artists": artist_refs(d) or ([{"name": names[0], "id": None}] if names else []),
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


_more = {}  # "top" / "trending" -> (when, playlist ids): the playlists their later pages come from


def top_songs():
    lists = yt.get_charts(COUNTRY).get("videos") or []
    pick = next((p for p in lists if str(p.get("title", "")).lower().startswith("top 100 music videos")), None) or (lists[0] if lists else None)
    if not pick or not pick.get("playlistId"):
        raise Problem("There is no chart for this country right now.", "unavailable")
    return with_covers(tracks_of(yt.get_playlist(pick["playlistId"], limit=100).get("tracks") or [], 100))   # the whole chart (YouTube keeps 100)


def trending():
    return with_covers(tracks_of((yt.get_explore().get("trending") or {}).get("items") or [], 40))


def more_lists(key):
    # After the first page, Top Songs goes on through the country's other chart playlists (daily, weekly, the genre charts) and Trending through
    # the full trending playlists behind its first 20. Kept for an hour; songs already shown are dropped by the server.
    import time

    hit = _more.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    ids = []
    try:
        charts = yt.get_charts(COUNTRY) or {}
        if key == "top":
            vids = [p for p in charts.get("videos") or [] if isinstance(p, dict) and p.get("playlistId")]
            first = next((p for p in vids if str(p.get("title", "")).lower().startswith("top 100 music videos")), None) or (vids[0] if vids else None)   # page 0's (top_songs)
            ids = [p["playlistId"] for p in vids + [g for g in charts.get("genres") or [] if isinstance(g, dict) and g.get("playlistId")] if p is not first]
        else:
            for shelf in ((yt.get_explore() or {}).get("trending"), charts.get("trending")):
                if isinstance(shelf, dict) and shelf.get("playlist"):
                    ids.append(shelf["playlist"])
    except Exception:  # noqa: BLE001 - then it is just its first page
        pass
    ids = list(dict.fromkeys(ids))[:30]
    _more[key] = (time.time(), ids)
    return ids


def playlist_page(ids, page):
    # page 1 is the first of `ids`, page 2 the second…: up to 100 songs from one playlist
    if page > len(ids):
        return {"tracks": [], "more": False}
    try:
        found = tracks_of(yt.get_playlist(ids[page - 1], limit=100).get("tracks") or [], 100)
    except Exception:  # noqa: BLE001 - one playlist gone: the next page goes on
        found = []
    return {"tracks": with_covers(found, 4.0), "more": page < len(ids)}


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


def playlist_ids(node, found=None):
    # every playlist a YouTube Music page links to, in page order: its cards (musicTwoRowItemRenderer) open "VL" + the playlist id.
    # Read from the page itself: ytmusicapi's get_mood_playlists fails on genre pages, whose song rows it can't parse.
    found = [] if found is None else found
    if isinstance(node, dict):
        card = node.get("musicTwoRowItemRenderer")
        if isinstance(card, dict):
            bid = str(((card.get("navigationEndpoint") or {}).get("browseEndpoint") or {}).get("browseId") or "")
            if bid.startswith("VL") and len(bid) > 4 and bid[2:] not in found:
                found.append(bid[2:])
        for v in node.values():
            playlist_ids(v, found)
    elif isinstance(node, list):
        for v in node:
            playlist_ids(v, found)
    return found


def category_tracks(entry):
    # ytmusicapi's get_mood_playlists only reads playlists, but a genre page lists songs directly, so read the page and use its song parser
    raw = yt._send_request("browse", {"browseId": "FEmusic_moods_and_genres_category", "params": entry["params"]})
    _mood_lists[entry["params"]] = playlist_ids(raw)[:40]   # the page's playlists: the genre's next pages
    found = tracks_of(songs_shelf(raw), 40)
    if len(found) < 5:  # the page changed shape: a plain search for the category still gives something to play
        found = tracks_of(yt.search(f"{entry['name']} songs", filter="songs", limit=40), 40)
    return with_covers(found)


_mood_lists = {}  # a genre's params -> the ids of its playlists


def mood_playlists(entry):
    # the genre page's playlists (category_tracks reads them while it loads the page; a later page that finds none yet reads the page once)
    if entry["params"] not in _mood_lists:
        try:
            _mood_lists[entry["params"]] = playlist_ids(yt._send_request("browse", {"browseId": "FEmusic_moods_and_genres_category", "params": entry["params"]}))[:40]
        except Exception:  # noqa: BLE001 - then the genre is just its own page
            _mood_lists[entry["params"]] = []
    return _mood_lists[entry["params"]]


def category_page(entry, page):
    # page 0: the songs on the genre's own page; then one of its playlists per page (a genre has 10 to 40), so a genre runs to hundreds of songs
    if page == 0:
        tracks = category_tracks(entry)
        return {"tracks": tracks, "more": bool(mood_playlists(entry))}
    return playlist_page(mood_playlists(entry), page)


def op_search(p):
    q = str(p.get("q") or "").strip()[:100]
    if not q:
        raise Problem("Type something to search for", "bad_request")
    limit = clamp(p.get("limit"), 1, 200, 24)   # ytmusicapi follows YouTube's "more results" itself up to the limit
    songs = yt.search(q, filter="songs", limit=limit)
    found = tracks_of(songs, limit)
    if len(found) < 8:  # few official songs: add music videos
        try:
            found = tracks_of([*songs, *yt.search(q, filter="videos", limit=limit)], limit)
        except Exception:  # noqa: BLE001
            pass
    return with_covers(found)


DATE_LIKE = re.compile(r"^[A-Z][a-z]{2} \d{1,2}, \d{4}$")


def op_playlist_songs(p):
    """A genre's or an era's songs: the tracks of the first playlist YouTube Music finds for `q` that has enough of them. A playlist keeps to its
    topic; a song search for "2020s Phonk hits" mixes in whatever is popular (rap, rock, pop)."""
    q = str(p.get("q") or "").strip()[:100]
    if not q:
        raise Problem("Type something to search for", "bad_request")
    limit = clamp(p.get("limit"), 10, 200, 100)
    for pl in (yt.search(q, filter="playlists", limit=6) or [])[:6]:
        pid = str(pl.get("browseId") or "")
        pid = pid[2:] if pid.startswith("VL") else pid
        if not pid:
            continue
        try:
            found = tracks_of(yt.get_playlist(pid, limit=limit).get("tracks") or [], limit)
        except Exception:  # noqa: BLE001 - a playlist that won't open: try the next one
            continue
        found = [t for t in found if not DATE_LIKE.match(t["artist"])]   # (an upload with an upload date where its artist should be: nobody can name that)
        if len(found) >= 10:
            return with_covers(found)
    return []


def op_categories(_):
    cats = [{"key": "top", "name": "Top Songs"}, {"key": "trending", "name": "Trending"}]
    try:
        m = mood_table()
        cats += [{"key": k, "name": m["table"][k]["name"], "group": m["table"][k]["group"]} for k in m["order"]]
    except Exception:  # noqa: BLE001 - the page still works with just the charts
        pass
    return cats


def op_category(p):
    # -> {"tracks": [...], "more": bool}, one page at a time (the charts are a single page)
    key = str(p.get("key") or "")
    page = clamp(p.get("page"), 0, 60, 0)
    if key in ("top", "trending"):
        if page == 0:
            return {"tracks": top_songs() if key == "top" else trending(), "more": bool(more_lists(key))}
        return playlist_page(more_lists(key), page)
    entry = mood_table()["table"].get(key)
    if not entry:
        raise Problem("Unknown category", "not_found")
    return category_page(entry, page)


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


def album_cards(items, kind):
    """Albums, EPs and singles of an artist as small cards."""
    cards = []
    for it in items or []:
        bid = it.get("browseId") if isinstance(it, dict) else None
        if not isinstance(bid, str) or not BROWSE_ID.match(bid):
            continue
        cards.append({
            "id": bid,
            "title": str(it.get("title") or "Untitled")[:120],
            "year": (str(it.get("year") or "")[:4] or None),
            "type": str(it.get("type") or kind)[:20],
            "artwork": artwork(it.get("thumbnails")),
        })
    return cards


def artist_albums(a, cid, section):
    sec = a.get(section) or {}
    items = list(sec.get("results") or [])
    if sec.get("params"):  # the artist has more than the few shown on their page
        try:
            items = yt.get_artist_albums(cid, sec["params"], limit=40) or items
        except Exception:  # noqa: BLE001 - the few on the page are still good
            pass
    return items


def op_artist(p):
    cid = str(p.get("browseId") or "")
    if not BROWSE_ID.match(cid):
        raise Problem("Unknown artist", "bad_request")
    try:
        a = yt.get_artist(cid)
    except Exception:  # noqa: BLE001 - an id that isn't an artist makes YouTube answer with an error page
        raise Problem("That artist isn’t available.", "unavailable")
    sec = a.get("songs") or {}
    songs = []
    try:
        if sec.get("browseId"):  # every song of theirs, not just the few on the page
            songs = tracks_of(yt.get_playlist(sec["browseId"], limit=40).get("tracks") or [], 40)
    except Exception:  # noqa: BLE001
        songs = []
    if not songs:
        songs = tracks_of(sec.get("results") or [], 40)
    avatar = None  # the page itself only has a wide banner: the square picture is on their search card
    try:
        for r in yt.search(str(a.get("name") or ""), filter="artists", limit=6):
            if r.get("browseId") == cid:
                avatar = artwork(r.get("thumbnails"))
                break
    except Exception:  # noqa: BLE001
        pass
    wide = [t for t in (a.get("thumbnails") or []) if isinstance(t, dict) and t.get("url")]
    banner = max(wide, key=lambda t: t.get("width") or 0)["url"] if wide else None
    return {
        "id": cid,
        "name": str(a.get("name") or "Unknown artist")[:100],
        "description": str(a.get("description") or "")[:700],
        "subscribers": str(a.get("subscribers") or "")[:20] or None,
        "listeners": str(a.get("monthlyListeners") or "")[:30] or None,
        "avatar": avatar,
        "banner": banner,
        "songs": with_covers(songs),
        "albums": album_cards(artist_albums(a, cid, "albums"), "Album"),
        "singles": album_cards(artist_albums(a, cid, "singles"), "Single"),
    }


def op_album(p):
    bid = str(p.get("browseId") or "")
    if not BROWSE_ID.match(bid):
        raise Problem("Unknown album", "bad_request")
    try:
        al = yt.get_album(bid)
    except Exception:  # noqa: BLE001
        raise Problem("That album isn’t available.", "unavailable")
    cover = artwork(al.get("thumbnails"))
    title = str(al.get("title") or "Album")[:120]
    songs = []
    for it in al.get("tracks") or []:
        if not isinstance(it, dict):
            continue
        t = track({**it, "album": {"name": title, "id": bid}, "artists": it.get("artists") or al.get("artists"), "thumbnails": al.get("thumbnails")})
        if t:  # the songs sorted into this album, in its order
            t["artwork"] = cover or t["artwork"]
            songs.append(t)
    secs = al.get("duration_seconds")
    return {
        "id": bid,
        "title": title,
        "type": str(al.get("type") or "Album")[:20],
        "year": (str(al.get("year") or "")[:4] or None),
        "artists": artist_refs(al),
        "artwork": cover,
        "duration": int(secs * 1000) if secs else sum(t["duration"] for t in songs),
        "tracks": songs,
    }


def op_artists(p):
    """Artists matching a search, as small cards (a picture and a name) that open their page."""
    q = str(p.get("q") or "").strip()[:100]
    if not q:
        raise Problem("Type something to search for", "bad_request")
    cards = []
    for r in yt.search(q, filter="artists", limit=6):
        aid = r.get("browseId")
        if isinstance(aid, str) and BROWSE_ID.match(aid) and r.get("artist"):
            cards.append({"id": aid, "name": str(r["artist"])[:100], "avatar": artwork(r.get("thumbnails"))})
    return cards[:5]


OPS = {"search": op_search, "playlist_songs": op_playlist_songs, "categories": op_categories, "category": op_category, "song": op_song, "artist": op_artist, "artists": op_artists, "album": op_album, "ping": lambda p: "pong"}


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
