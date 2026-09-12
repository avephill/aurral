"""Match tracks from iTunes library XML exports to Navidrome media_file rows.

The library was reorganised by Lidarr and beets after the exports were made, so
file paths are useless as a join key. What survives is metadata: artist, title,
album, and above all duration, which beets never touches. Matching runs through
tiers from exact to fuzzy, and every result records which tier produced it so
the caller can decide how much to trust it.

Reads Navidrome's SQLite database read-only. Writes nothing.

    python3 itunes_match.py --db /path/navidrome.db "Library.xml" "iTunes Library.xml"

Several exports may be given; the first one wins for a track that appears in
more than one (put the newest first), later ones contribute tracks and
playlists the newer export dropped.
"""
import argparse
import csv
import json
import plistlib
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from urllib.parse import unquote, urlparse

# --------------------------------------------------------------------------- normalisation

_JUNK_PAREN = re.compile(
    r"\s*[\(\[](?:[^\)\]]*?)(?:remaster|remastered|album version|single version|radio edit|"
    r"bonus track|deluxe|explicit|mono|stereo|edit|version|mix|live|acoustic|demo|feat\.?|ft\.?|"
    r"featuring|instrumental|\d{4})(?:[^\)\]]*?)[\)\]]",
    re.I,
)
_FEAT = re.compile(r"\s+(?:feat\.?|ft\.?|featuring)\s+.*$", re.I)
_ALBUM_JUNK = re.compile(
    r"\s*[\(\[\-–]\s*(?:deluxe|expanded|remaster|remastered|bonus|anniversary|edition|version|single|ep|disc \d|cd ?\d)[^\)\]]*[\)\]]?\s*$",
    re.I,
)
_ANY_BRACKET = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")


def strip_accents(s):
    return "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))


def norm(s):
    if not s:
        return ""
    s = strip_accents(str(s)).lower()
    s = s.replace("&", " and ").replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()


def norm_loose(s):
    """Title without version/feat decorations."""
    if not s:
        return ""
    s = _JUNK_PAREN.sub("", str(s))
    s = _FEAT.sub("", s)
    s = re.sub(r"\s*[-–]\s*(?:live|remaster(?:ed)?(?: \d{4})?|single version|radio edit)\s*$", "", s, flags=re.I)
    return norm(s)


def norm_bare(s):
    """Title with every bracketed group and dash-suffix removed: MusicBrainz likes
    'Tom Traubert's Blues (Four Sheets to the Wind in Copenhagen)' where iTunes had
    'Tom Traubert's Blues'. Duration keeps live/remix versions apart."""
    if not s:
        return ""
    s = _ANY_BRACKET.sub("", str(s))
    s = _FEAT.sub("", s)
    s = re.sub(r"\s+[-–]\s+.*$", "", s)
    return norm(s)


def norm_artist(s):
    """Artist names compare as one alphanumeric run so 'J.J. Cale' == 'JJ Cale'."""
    s = norm(s)
    s = re.sub(r"^the ", "", s)
    s = re.sub(r"\s+(?:feat|ft|featuring)\s+.*$", "", s)
    return s.replace(" ", "")


def norm_album(s):
    return norm(_ALBUM_JUNK.sub("", str(s or "")))


def norm_comment(s):
    """iTunes comments here are a comma-separated tag vocabulary; order does not matter."""
    parts = [norm(p) for p in re.split(r"[,;/|]+", s or "")]
    return tuple(sorted(p for p in parts if p))


# --------------------------------------------------------------------------- inputs

SKIP_KINDS = ("video", "podcast")


def is_music(t):
    kind = (t.get("Kind") or "").lower()
    if any(k in kind for k in SKIP_KINDS):
        return False
    if t.get("Podcast") or t.get("Movie") or t.get("TV Show") or t.get("Music Video"):
        return False
    return t.get("Track Type") in ("File", "Remote")


def classify_playlist(pl):
    if pl.get("Master"):
        return "master"
    if "Distinguished Kind" in pl:
        return "system"
    if pl.get("Folder"):
        return "folder"
    if "Smart Info" in pl or "Smart Criteria" in pl:
        return "smart"
    return "user"


def track_identity(t):
    """Persistent IDs are regenerated when a library moves to a new Music.app
    generation, so they cannot tie exports together. iTunes always files a track
    as <Artist or Compilations>/<Album>/<file>, and that tail survives every
    Music Folder relocation this library went through."""
    loc = t.get("Location")
    if loc:
        parts = unquote(urlparse(loc).path).split("/")
        return "path:" + "/".join(parts[-3:])
    return "meta:" + "|".join(
        [norm_artist(t.get("Artist")), norm_album(t.get("Album")), norm(t.get("Name")), str(round((t.get("Total Time") or 0) / 1000))]
    )


def load_itunes(export_paths):
    """Union of the exports; the first export listed wins for a track or playlist
    that appears in more than one, so list the newest first."""
    tracks = {}
    playlists = {}
    for path in export_paths:
        with open(path, "rb") as fh:
            lib = plistlib.load(fh)
        id_to_key = {}
        for t in lib["Tracks"].values():
            key = track_identity(t)
            id_to_key[t["Track ID"]] = key
            if key not in tracks:
                tracks[key] = t
        for pl in lib.get("Playlists", []):
            kind = classify_playlist(pl)
            if kind in ("master", "system", "folder"):
                continue
            name = pl.get("Name") or ""
            items = [id_to_key[i["Track ID"]] for i in pl.get("Playlist Items", []) if i["Track ID"] in id_to_key]
            existing = playlists.get(name)
            if existing and (existing["source"] != path or len(existing["items"]) >= len(items)):
                continue
            playlists[name] = {
                "name": name,
                "kind": kind,
                "source": path,
                "exported": lib.get("Date"),
                "items": items,
            }
    return tracks, playlists


def load_navidrome(db_path, library_id):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """select id, path, title, artist, album, album_artist, album_id, duration, comment, compilation
           from media_file where library_id = ? and missing = 0""",
        (library_id,),
    ).fetchall()
    con.close()
    out = []
    for r in rows:
        title = r["title"] or ""
        out.append(
            {
                "id": r["id"],
                "path": r["path"],
                "title": title,
                "artist": r["artist"],
                "album": r["album"],
                "album_id": r["album_id"],
                "duration": float(r["duration"] or 0),
                "compilation": bool(r["compilation"]),
                "n_title": norm(title),
                "l_title": norm_loose(title),
                "b_title": norm_bare(title),
                # 'Changeling / Transmission 1' is two iTunes tracks glued together on another edition.
                "segments": [norm(seg) for seg in re.split(r"\s+/\s+", title) if seg] if " / " in title else [],
                "n_artist": norm_artist(r["artist"]),
                "n_album_artist": norm_artist(r["album_artist"]),
                "n_album": norm_album(r["album"]),
                "n_comment": norm_comment(r["comment"]),
            }
        )
    return out


# --------------------------------------------------------------------------- matching

def _pick(cands, it, tol):
    """Best candidate within duration tolerance, or None. Returns (row, ambiguous)."""
    dur = it["dur"]
    within = [c for c in cands if abs(c["duration"] - dur) <= tol]
    if not within:
        return None, False

    def score(c):
        return (
            c["n_comment"] == it["n_comment"] and bool(it["n_comment"]),
            c["n_album"] == it["n_album"],
            not c["compilation"],
            -abs(c["duration"] - dur),
        )

    within.sort(key=score, reverse=True)
    best = within[0]
    ambiguous = len(within) > 1 and score(within[1])[:2] == score(best)[:2]
    return best, ambiguous


_CREDIT_SPLIT = re.compile(r"\s+(?:and|&|with|feat\.?|ft\.?|featuring|y)\s+|\s*[/,;+]\s*", re.I)


def artist_variants(s):
    """'Neko Case and her Boyfriends' or 'Vampire Weekend/Dr. Dog' as iTunes credited
    them may be filed under 'Neko Case' or 'Dr. Dog' after MusicBrainz tagging."""
    full = norm_artist(s)
    out = []
    for part in _CREDIT_SPLIT.split(s or ""):
        alt = norm_artist(part)
        if alt and alt != full and alt not in out:
            out.append(alt)
    return out


def itunes_key(t):
    return {
        "dur": (t.get("Total Time") or 0) / 1000.0,
        "n_title": norm(t.get("Name")),
        "l_title": norm_loose(t.get("Name")),
        "b_title": norm_bare(t.get("Name")),
        "n_artist": norm_artist(t.get("Artist")),
        "artist_variants": artist_variants(t.get("Artist")),
        "n_album_artist": norm_artist(t.get("Album Artist")),
        "n_album": norm_album(t.get("Album")),
        "n_comment": norm_comment(t.get("Comments")),
    }


def match_all(itunes, nav):
    """itunes: {persistent id: track dict}; nav: rows from load_navidrome.
    Returns {persistent id: {"nav_id", "tier", "ambiguous"}} with nav_id None when unmatched."""
    by_artist_title = defaultdict(list)
    by_artist_ltitle = defaultdict(list)
    by_artist_btitle = defaultdict(list)
    by_artist_segment = defaultdict(list)
    by_artist_album = defaultdict(list)
    by_title = defaultdict(list)
    by_artist = defaultdict(list)
    for r in nav:
        artists = {r["n_artist"], r["n_album_artist"]} - {""}
        for a in artists:
            by_artist_title[(a, r["n_title"])].append(r)
            by_artist_ltitle[(a, r["l_title"])].append(r)
            by_artist_btitle[(a, r["b_title"])].append(r)
            by_artist_album[(a, r["n_album"])].append(r)
            for seg in r["segments"]:
                by_artist_segment[(a, seg)].append(r)
        by_title[r["n_title"]].append(r)
        by_artist[r["n_artist"]].append(r)

    results = {}
    for pid, t in itunes.items():
        it = itunes_key(t)
        found = None
        for tier, cands, tol in (
            ("T1 artist+album+title", [c for c in by_artist_title[(it["n_artist"], it["n_title"])] if c["n_album"] == it["n_album"]], 3),
            ("T2 artist+title", by_artist_title[(it["n_artist"], it["n_title"])], 3),
            ("T2 albumartist+title", by_artist_title[(it["n_album_artist"], it["n_title"])] if it["n_album_artist"] else [], 3),
            ("T2 artist variant+title", [c for alt in it["artist_variants"] for c in by_artist_title[(alt, it["n_title"])]], 3),
            ("T3 artist variant+bare title", [c for alt in it["artist_variants"] for c in by_artist_btitle[(alt, it["b_title"])]] if it["b_title"] else [], 3),
            ("T3 artist+loose title", by_artist_ltitle[(it["n_artist"], it["l_title"])], 3),
            ("T3 artist+bare title", by_artist_btitle[(it["n_artist"], it["b_title"])] if it["b_title"] else [], 3),
            ("T3 albumartist+bare title", by_artist_btitle[(it["n_album_artist"], it["b_title"])] if it["n_album_artist"] and it["b_title"] else [], 3),
            ("T4 title+comment", [c for c in by_title[it["n_title"]] if it["n_comment"] and c["n_comment"] == it["n_comment"]], 2),
            ("T5 artist+title wide dur", by_artist_title[(it["n_artist"], it["n_title"])], 15),
        ):
            if not cands:
                continue
            best, ambiguous = _pick(cands, it, tol)
            if best:
                found = (tier, best, ambiguous)
                break

        if not found and it["n_artist"] and it["n_title"]:
            # T6: same artist, close duration, fuzzy title.
            pool = [c for c in by_artist[it["n_artist"]] if abs(c["duration"] - it["dur"]) <= 3]
            scored = [(SequenceMatcher(None, it["l_title"], c["l_title"]).ratio(), c) for c in pool]
            scored = [(s, c) for s, c in scored if s >= 0.82]
            if scored:
                scored.sort(key=lambda sc: sc[0], reverse=True)
                found = ("T6 fuzzy title", scored[0][1], len(scored) > 1 and scored[1][0] == scored[0][0])

        if not found and it["n_title"]:
            # T7: title only, unique within a tight duration window.
            best, ambiguous = _pick(by_title[it["n_title"]], it, 1.5)
            if best and not ambiguous:
                found = ("T7 title+duration only", best, False)

        if not found and it["n_album"]:
            # T9: same artist and album, same length to the second, and a title that at least
            # resembles: MusicBrainz rewrote 'Ocean' as 'The Ocean', 'Julie's In The Drug Squad'
            # as 'Julie’s Been Working for the Drug Squad'.
            pool = [c for c in by_artist_album[(it["n_artist"], it["n_album"])] if abs(c["duration"] - it["dur"]) <= 1.0]
            scored = [(SequenceMatcher(None, it["b_title"], c["b_title"]).ratio(), c) for c in pool]
            scored = [(s, c) for s, c in scored if s >= 0.5 or it["b_title"] in c["b_title"] or c["b_title"] in it["b_title"]]
            if scored:
                scored.sort(key=lambda sc: sc[0], reverse=True)
                found = ("T9 same album+duration, similar title", scored[0][1], len(scored) > 1)

        if not found and it["n_album"] and it["b_title"]:
            # T10: same artist and album, near-identical title, any length. A radio
            # edit or a different pressing of the same song is still that song for a
            # playlist; the strict title bar keeps unrelated tracks apart.
            pool = by_artist_album[(it["n_artist"], it["n_album"])]
            scored = [(SequenceMatcher(None, it["b_title"], c["b_title"]).ratio(), c) for c in pool]
            scored = [(s, c) for s, c in scored if s >= 0.8]
            if scored:
                scored.sort(key=lambda sc: (-sc[0], abs(sc[1]["duration"] - it["dur"])))
                found = ("T10 same album, same title, other length", scored[0][1], len(scored) > 1 and scored[1][0] == scored[0][0])

        if not found and it["n_title"]:
            # T8: iTunes track is one segment of a longer 'A / B' track on another edition.
            pool = [c for c in by_artist_segment[(it["n_artist"], it["n_title"])] if c["duration"] >= it["dur"] - 3]
            if pool:
                pool.sort(key=lambda c: c["duration"])
                found = ("T8 segment of merged track", pool[0], False)

        if found:
            tier, row, ambiguous = found
            results[pid] = {"nav_id": row["id"], "tier": tier, "ambiguous": ambiguous}
        else:
            results[pid] = {"nav_id": None, "tier": "unmatched", "ambiguous": False}

    claim_album_by_album_and_length(itunes, results, nav)
    claim_album_by_duration_fingerprint(itunes, results, nav)
    claim_album_leftovers(itunes, results, nav)
    return results


FINGERPRINT_MIN_TRACKS = 3     # fewer than this is not a fingerprint
# "Various Artists" is not an artist; its catalogue is the whole library, and
# matching a rip against it by length alone put a Boyz II Men Christmas song on
# a recording of Rita Dove reading poetry.
FINGERPRINT_SKIP_ARTISTS = {"variousartists", "various", "compilation", "compilations",
                            "originalsoundtrack", "soundtrack", "unknownartist"}
_TRAILING_NUMBER = re.compile(r"\s*\d+$")
FINGERPRINT_SHARE = 0.70       # how much of the rip the album has to account for
FINGERPRINT_MARGIN = 2         # and by how many tracks it must beat the runner-up


def placeholder_album(album, artist):
    """Whether the album name tells us nothing about which record this is.

    Ripped without a CDDB match, iTunes falls back to the artist's name, or the
    artist's name and a disc number - "Jamiroquai 1" for Return of the Space
    Cowboy - or gives up entirely and writes "Unknown Album".
    """
    name = (album or "").strip()
    if not name or name in {"unknown album", "unknownalbum", "untitled", "no album"}:
        return True
    bare = _TRAILING_NUMBER.sub("", name)
    return norm_artist(bare) == artist and bool(artist)


def claim_album_by_duration_fingerprint(itunes, results, nav, *, tol=3.0):
    """T13: find the record by how long its tracks are.

    Ripped without a CDDB match, iTunes names the album after the artist -
    "Jamiroquai 1" for Return of the Space Cowboy, "Tony Bennett" for a Tony
    Bennett record, "Unknown Album" for the rest. No amount of comparing album
    names will ever place those, because the name he has is not the name of the
    record.

    What does survive is the shape of the disc. A run of track lengths is close
    to unique, so the rip is tried against each album that artist has and the
    one that accounts for most of it wins - provided it accounts for most of it
    and beats whatever came second by a clear margin.
    """
    claimed = {r["nav_id"] for r in results.values() if r["nav_id"]}
    by_artist_album = defaultdict(lambda: defaultdict(list))
    for row in nav:
        for artist in {row["n_artist"], row["n_album_artist"]} - {""}:
            by_artist_album[artist][row["album_id"]].append(row)

    rips = defaultdict(list)
    for pid, t in itunes.items():
        if results[pid]["nav_id"]:
            continue
        artist = norm_artist(t.get("Album Artist")) or norm_artist(t.get("Artist"))
        if artist and artist not in FINGERPRINT_SKIP_ARTISTS:
            rips[(artist, norm_album(t.get("Album")))].append(pid)

    for (artist, album), pids in rips.items():
        # Only where the album name is no help at all. "Dean Martin Assortment"
        # and "R&B Christmas" name something real and belong to the tiers that
        # read names; sending them here matched them to whatever ran the same
        # number of seconds.
        if not placeholder_album(album, artist):
            continue
        if len(pids) < FINGERPRINT_MIN_TRACKS:
            continue
        wanted = [((itunes[pid].get("Total Time") or 0) / 1000.0, pid) for pid in pids]

        scored = []
        for _album_id, rows in by_artist_album.get(artist, {}).items():
            free = [r for r in rows if r["id"] not in claimed]
            if not free:
                continue
            pairs = []
            for dur, pid in wanted:
                for row in free:
                    gap = abs(row["duration"] - dur)
                    if gap <= tol:
                        pairs.append((gap, pid, row))
            pairs.sort(key=lambda c: c[0])
            used, taken, chosen = set(), set(), []
            for gap, pid, row in pairs:
                if pid in used or row["id"] in taken:
                    continue
                used.add(pid)
                taken.add(row["id"])
                chosen.append((pid, row))
            scored.append((len(chosen), chosen))

        if not scored:
            continue
        scored.sort(key=lambda s: -s[0])
        best, chosen = scored[0]
        runner = scored[1][0] if len(scored) > 1 else 0
        if best < len(pids) * FINGERPRINT_SHARE or best - runner < FINGERPRINT_MARGIN:
            continue
        for pid, row in chosen:
            claimed.add(row["id"])
            results[pid] = {"nav_id": row["id"], "tier": "T13 album by track lengths", "ambiguous": False}


ALBUM_STEM = 12        # how much of an album name buckets it for near-match lookup
ALBUM_SIMILAR = 0.90   # a spelling variant, not a different record
# Words that carry no identity: a label's name, an article, a preposition. What
# is left of "A Putumayo Blend: Music From the Coffee Lands" is the record.
ALBUM_NOISE = {
    "a", "an", "the", "of", "from", "for", "and", "in", "on", "at", "to", "with",
    "presents", "present", "blend", "volume", "vol", "disc", "cd",
}
ALBUM_TOKEN_SHARE = 0.75   # how much of the shorter name the two must have in common
ALBUM_TOKEN_COVER = 0.60   # and how much of the longer, so a short name cannot
                           # swallow a long one: "World Music" is inside "The
                           # Best of World Music: Reggae" and is not that record
ALBUM_MIN_TOKENS = 2       # one word in common is a coincidence


class _WordIndex:
    """Album names looked up by the words in them, so a name can be found
    without comparing it to every album in the library."""

    def __init__(self, names):
        self._by_word = defaultdict(set)
        for name in names:
            for word in album_words(name):
                self._by_word[word].add(name)

    def get_candidates(self, name):
        found = set()
        for word in album_words(name):
            found |= self._by_word.get(word, set())
        return found


def album_words(name):
    """The words of an album name that say which record it is."""
    return {word for word in str(name or "").split() if word not in ALBUM_NOISE}


def same_record(left, right):
    """Whether two album names are the same record said differently.

    The names differ at the front as often as the back - "Handel: Messiah
    (Highlights)" against "The Messiah (Highlights)", "A New World Party"
    against "Putumayo Presents: New World Party" - so a prefix test sees
    nothing. What survives in both is the words that name the record.
    """
    a, b = album_words(left), album_words(right)
    if not a or not b:
        return False
    shared = a & b
    return (len(shared) >= ALBUM_MIN_TOKENS
            and len(shared) / min(len(a), len(b)) >= ALBUM_TOKEN_SHARE
            and len(shared) / max(len(a), len(b)) >= ALBUM_TOKEN_COVER)


def claim_album_by_album_and_length(itunes, results, nav, *, tol=3.0):
    """T12: the album name and the length agree, and nothing else has to.

    Two cases the artist-and-title tiers cannot reach, both real:

    iTunes put the movement name in the artist field, so Yo-Yo Ma's Cello
    Suites are credited to "1. Prelude" while Navidrome, tagged from
    MusicBrainz, credits "Johann Sebastian Bach" - and the titles disagree just
    as completely, "J.S. Bach: Cello Suite #2 In D Minor" against "Suite no. 2
    in D minor, BWV 1008: V. Menuett I/II".

    An untitled rip carries "Track 07" where MusicBrainz supplies "Country
    Honk". Same artist, same album, same 178 seconds, nothing in the title to
    match on.

    The album name has to be exclusive - one album in the library answers to it
    - or "Greatest Hits" would match everybody's. Within that album the length
    has to pick out exactly one unclaimed track.

    The tolerance matches the other tiers at three seconds, because a rip and a
    release rarely agree to the second: every track of My Beautiful Dark
    Twisted Fantasy runs exactly two seconds shorter in his library than in the
    export, so a one-second window found none of them.
    """
    by_album = defaultdict(list)
    for row in nav:
        if row["n_album"]:
            by_album[row["n_album"]].append(row)
    # Bucketed on the opening of the name so a near-identical spelling can be
    # found without comparing every album to every other.
    by_stem = defaultdict(set)
    for name in by_album:
        by_stem[name[:ALBUM_STEM]].add(name)
    by_words = _WordIndex(by_album)
    claimed = {r["nav_id"] for r in results.values() if r["nav_id"]}

    # Gather the whole album's worth of possibilities before choosing any of
    # them. Deciding track by track cannot cope with a rip that runs a couple
    # of seconds short throughout: every track then sits near two others, and
    # "exactly one candidate" is never true. Pairing the album as a whole,
    # closest first, lets the offset cancel out.
    pending = defaultdict(list)

    for pid, t in itunes.items():
        if results[pid]["nav_id"]:
            continue
        album = norm_album(t.get("Album"))
        if not album:
            continue
        rows = by_album.get(album)
        if not rows:
            # One disc, filed under two names: iTunes also called the Cello
            # Suites "The Cello Suites Inspired By Bach, From The Six-Part Film
            # Series", which is the library's title with a subtitle glued on.
            # One side being a prefix of the other is the same record.
            # Candidates come from the words in the name, not from its opening.
            # Bucketing on the first twelve characters could not see "Feast Of
            # Wine" against "Feast of Wire", nor anything wearing a label's
            # name in front, and both are common here.
            candidates = by_words.get_candidates(album) | by_stem.get(album[:ALBUM_STEM], set())
            near_names = {
                key for key in candidates
                if len(key) >= 10 and (album.startswith(key) or key.startswith(album)
                                       or SequenceMatcher(None, album, key).ratio() >= ALBUM_SIMILAR
                                       or same_record(album, key))
            }
            # "Blood Sugar Sex Magic" against "Blood Sugar Sex Magik" is one
            # letter; the prefix test cannot see it because they differ at the
            # end. Two candidate names would be a guess, so only one will do.
            if len(near_names) != 1:
                continue
            rows = by_album[next(iter(near_names))]
        # "Greatest Hits" names a dozen records, and those are a dozen
        # different artists - that is the ambiguity worth refusing. One record
        # imported twice is still one record, so the test is on who made it,
        # not on how many rows the library happens to hold.
        if len({row["n_album_artist"] or row["n_artist"] for row in rows}) > 1:
            continue
        dur = (t.get("Total Time") or 0) / 1000.0
        for row in rows:
            if row["id"] in claimed:
                continue
            gap = abs(row["duration"] - dur)
            if gap <= tol:
                pending[id(rows)].append((gap, pid, row))

    for candidates in pending.values():
        # A track whose two best candidates are equally far away is a coin
        # flip, whatever the rest of the album does; leave it.
        gaps = defaultdict(list)
        for gap, pid, _row in candidates:
            gaps[pid].append(gap)
        tied = {pid for pid, g in gaps.items() if len(g) > 1 and sorted(g)[0] == sorted(g)[1]}

        candidates.sort(key=lambda c: c[0])
        used = set()
        for gap, pid, row in candidates:
            if pid in tied or pid in used or row["id"] in claimed:
                continue
            used.add(pid)
            claimed.add(row["id"])
            # A title translated or renamed can share nothing with the original
            # - "Cape Verde Greets You" and "Cabo Verde manda mantenha" are one
            # song - so a low score cannot refuse the pair. But on a soundtrack
            # full of cues of the same length it is the only sign that the
            # album simply does not have this track, so it is flagged.
            left = norm_bare(itunes[pid].get("Name")) or ""
            right = row["b_title"] or ""
            informative = not _TRACK_NO.match(left) and left and right
            unlike = informative and SequenceMatcher(None, left, right).ratio() < 0.3
            results[pid] = {
                "nav_id": row["id"],
                "tier": "T12 album+length",
                "ambiguous": gap > 1.0 or unlike,
            }


_TRACK_NO = re.compile(r"^track\s*(\d+)$")
_ARTIST_TAIL = re.compile(r"\s+-\s+.*$")


def _title_forms(name, artist):
    """The ways this title could reasonably be written. iTunes files a
    compilation track as 'Title - Artist ', so the part before the dash is a
    second reading of the same title rather than a different song."""
    forms = {norm_bare(name) or ""}
    stripped = _ARTIST_TAIL.sub("", name or "")
    if stripped and stripped != name:
        forms.add(norm_bare(stripped) or "")
    if artist:
        tail = re.sub(re.escape(artist) + r"\s*$", "", name or "", flags=re.I).strip(" -")
        if tail:
            forms.add(norm_bare(tail) or "")
    return {f for f in forms if f}


def _leftover_score(forms, cand):
    """How much a free slot's title looks like this one. Containment counts as
    strongly as a near-exact ratio: 'La Llorona' holds 'Liorona' badly but
    'Fée Clochette' sits inside 'La Fée Clochette' exactly."""
    target = cand["b_title"] or cand["n_title"]
    if not target:
        return 0.0
    best = 0.0
    for form in forms:
        ratio = SequenceMatcher(None, form, target).ratio()
        if form in target or target in form:
            ratio = max(ratio, 0.90)
        best = max(best, ratio)
    return best


def claim_album_leftovers(itunes, results, nav, *, floor=0.60, margin=0.15, tol=3.0):
    """T11, run once the per-track tiers have finished.

    When part of an album matched, the album is on the server, and the only
    candidates left for its stragglers are the few tracks of that album nothing
    has claimed. That is a far smaller pool than the library, so a title the
    other tiers could not place - a typo, a dropped article, an accent - becomes
    decidable.

    Length alone is not enough: two tracks on one record often run the same
    number of seconds, and picking by duration would file 'The Black Page #1'
    as 'How Could I Be Such a Fool'. The title has to agree as well.
    """
    nav_by_id = {r["id"]: r for r in nav}
    nav_by_album = defaultdict(list)
    for r in nav:
        nav_by_album[r["album_id"]].append(r)
    claimed = {r["nav_id"] for r in results.values() if r["nav_id"]}

    albums = defaultdict(lambda: ([], []))
    for pid, t in itunes.items():
        album = norm_album(t.get("Album"))
        if not album:
            continue
        key = (norm_artist(t.get("Album Artist") or t.get("Artist")), album)
        albums[key][0 if results[pid]["nav_id"] else 1].append(pid)

    proposals = []
    for matched, unmatched in albums.values():
        if not matched or not unmatched:
            continue
        landed = Counter(nav_by_id[results[p]["nav_id"]]["album_id"] for p in matched)
        free = [r for r in nav_by_album[landed.most_common(1)[0][0]] if r["id"] not in claimed]
        if not free:
            continue
        for pid in unmatched:
            t = itunes[pid]
            dur = (t.get("Total Time") or 0) / 1000.0
            near = [c for c in free if abs(c["duration"] - dur) <= tol]
            if not near:
                continue
            forms = _title_forms(t.get("Name"), t.get("Artist"))
            if not forms:
                continue
            scored = sorted(((_leftover_score(forms, c), c) for c in near), key=lambda sc: -sc[0])
            best, cand = scored[0]
            runner = scored[1][0] if len(scored) > 1 else 0.0
            if best < floor or (len(scored) > 1 and best - runner < margin):
                continue
            # 'Track 09' and 'Track 17' score alike and are not the same track;
            # nothing but the number distinguishes them, and it disagrees.
            left = _TRACK_NO.match(next(iter(forms)))
            right = _TRACK_NO.match(cand["b_title"] or "")
            if left and right and left.group(1) != right.group(1):
                continue
            proposals.append((best, pid, cand))

    # Best first, so two stragglers wanting one slot resolve in favour of the
    # better reading rather than whichever came up first.
    proposals.sort(key=lambda p: -p[0])
    taken = set()
    for score, pid, cand in proposals:
        if cand["id"] in claimed or cand["id"] in taken:
            continue
        taken.add(cand["id"])
        results[pid] = {
            "nav_id": cand["id"],
            "tier": "T11 free slot on a part-matched album",
            "ambiguous": score < 0.75,
        }


# --------------------------------------------------------------------------- reporting

def summarize(itunes, results, playlists):
    lines = []
    tiers = Counter(r["tier"] for r in results.values())
    matched = sum(1 for r in results.values() if r["nav_id"])
    lines.append(f"matched {matched}/{len(itunes)} music tracks = {matched / max(len(itunes), 1):.1%}")
    for tier, n in sorted(tiers.items()):
        lines.append(f"  {n:6d}  {tier}")
    file_backed = [pid for pid, t in itunes.items() if t.get("Track Type") == "File"]
    fb_matched = sum(1 for pid in file_backed if results[pid]["nav_id"])
    lines.append(f"file-backed only: {fb_matched}/{len(file_backed)} = {fb_matched / max(len(file_backed), 1):.1%} (the rest were Apple Music streams)")
    total = ok = 0
    for pl in playlists.values():
        items = [pid for pid in pl["items"] if pid in itunes]
        total += len(items)
        ok += sum(1 for pid in items if results[pid]["nav_id"])
    lines.append(f"playlist entries resolvable: {ok}/{total} = {ok / max(total, 1):.1%}")
    return "\n".join(lines)


def write_unmatched_csv(path, itunes, results):
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["persistent_id", "track_type", "kind", "artist", "album", "title", "seconds", "comments"])
        for pid, r in results.items():
            if r["nav_id"]:
                continue
            t = itunes[pid]
            w.writerow([pid, t.get("Track Type"), t.get("Kind"), t.get("Artist"), t.get("Album"), t.get("Name"), round((t.get("Total Time") or 0) / 1000), t.get("Comments")])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("exports", nargs="+", help="iTunes XML exports, newest first")
    ap.add_argument("--db", required=True, help="path to navidrome.db (opened read-only)")
    ap.add_argument("--library-id", type=int, default=1, help="Navidrome library to match against (default 1)")
    ap.add_argument("--out", default=".", help="directory for match.json and unmatched.csv")
    args = ap.parse_args()

    tracks, playlists = load_itunes(args.exports)
    itunes = {pid: t for pid, t in tracks.items() if is_music(t)}
    nav = load_navidrome(args.db, args.library_id)
    print(f"iTunes tracks: {len(tracks)} ({len(itunes)} music); Navidrome rows: {len(nav)}")
    results = match_all(itunes, nav)
    print(summarize(itunes, results, playlists))
    with open(f"{args.out}/match.json", "w") as fh:
        json.dump(results, fh)
    write_unmatched_csv(f"{args.out}/unmatched.csv", itunes, results)
    print(f"wrote {args.out}/match.json and unmatched.csv")


if __name__ == "__main__":
    main()
