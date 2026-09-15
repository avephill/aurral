#!/usr/bin/env python3
"""Packs an iTunes library into the bundle Psalter imports as one person's songs.

Psalter keeps each iTunes song as a record of its own - title, artist, album,
length, and the tags he gave it: comments, genre, year, rating, date added. The
record is the backbone; which file on the server it belongs to is a separate
link, made once here from the matcher's results and remade by Psalter whenever
new music arrives. A song not on the server yet keeps its record and its tags,
and picks up a link the day the album is ripped and imported.

    python3 export_psalter_library.py --owner dunshill \\
        --export "exports/2021-02-17 Library.xml" \\
        --match state/match.json --db /path/navidrome.db \\
        --out state/psalter-library.json.gz

Reads everything read-only and writes only the bundle. Upload the bundle on
Psalter's iTunes library page.
"""
import argparse
import gzip
import json
import sqlite3
import plistlib
from datetime import datetime

from itunes_match import classify_playlist, is_music, track_identity
from smart_playlists import convert_export

ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"


def canonical_id(item_id):
    """Navidrome 0.64 re-encoded every 32-hex id as base62; match.json predates it."""
    s = str(item_id or "")
    if len(s) == 32 and all(ch in "0123456789abcdef" for ch in s):
        n, out = int(s, 16), ""
        while n:
            n, r = divmod(n, 62)
            out = ALPHABET[r] + out
        return out.rjust(22, "0")
    return s


def iso(value):
    return value.isoformat() + "Z" if isinstance(value, datetime) else None


def record(t, key, link):
    rating = t.get("Rating") or 0
    return {
        "key": key,
        "persistentId": t.get("Persistent ID"),
        "title": t.get("Name"),
        "artist": t.get("Artist"),
        "albumArtist": t.get("Album Artist"),
        "album": t.get("Album"),
        "discNumber": t.get("Disc Number"),
        "trackNumber": t.get("Track Number"),
        "durationMs": t.get("Total Time"),
        "year": t.get("Year"),
        "genre": t.get("Genre"),
        "comment": t.get("Comments"),
        # A rating iTunes worked out from the album's is not one he gave.
        "rating": 0 if t.get("Rating Computed") else rating // 20,
        "loved": bool(t.get("Loved")),
        "playCount": t.get("Play Count") or 0,
        "skipCount": t.get("Skip Count") or 0,
        "dateAdded": iso(t.get("Date Added")),
        "lastPlayed": iso(t.get("Play Date UTC")),
        "trackType": t.get("Track Type"),
        "kind": t.get("Kind"),
        "link": link,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--owner", required=True, help="the Psalter username these songs belong to")
    ap.add_argument("--export", required=True, help="the iTunes library XML")
    ap.add_argument("--match", required=True, help="match.json from itunes_match.py")
    ap.add_argument("--db", required=True, help="navidrome.db, opened read-only")
    ap.add_argument("--library-id", type=int, default=1, help="the Navidrome library match.json was made against")
    ap.add_argument("--out", required=True, help="where to write the bundle (.json.gz)")
    args = ap.parse_args()

    with open(args.export, "rb") as fh:
        library = plistlib.load(fh)
    with open(args.match) as fh:
        match = json.load(fh)
    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    path_by_id = dict(con.execute(
        "SELECT id, path FROM media_file WHERE library_id = ? AND missing = 0", (args.library_id,)
    ))

    records, key_by_track_id = {}, {}
    linked = 0
    for t in library["Tracks"].values():
        if not is_music(t):
            continue
        key = track_identity(t)
        key_by_track_id[t["Track ID"]] = key
        if key in records:
            continue
        found = match.get(key) or {}
        path = path_by_id.get(canonical_id(found.get("nav_id"))) if found.get("nav_id") else None
        link = {"navidromePath": path, "method": found.get("tier"), "ambiguous": bool(found.get("ambiguous"))} if path else None
        linked += bool(link)
        records[key] = record(t, key, link)

    playlists = []
    for pl in library.get("Playlists", []):
        kind = classify_playlist(pl)
        if kind in ("master", "system", "folder"):
            continue
        keys = [key_by_track_id[i["Track ID"]] for i in pl.get("Playlist Items", []) if i["Track ID"] in key_by_track_id]
        playlists.append({"name": pl.get("Name") or "", "kind": kind, "keys": keys})

    smart = []
    for result in convert_export(args.export):
        if result.get("rules") is None:
            continue
        smart.append({
            "name": result["name"],
            "rules": result["rules"],
            "unsupported": result.get("unsupported", []),
            "convertible": bool(result.get("convertible")),
        })

    bundle = {
        "format": "psalter-itunes-library",
        "version": 1,
        "owner": args.owner,
        "exportedAt": iso(library.get("Date")),
        "records": list(records.values()),
        "playlists": playlists,
        "smartPlaylists": smart,
    }
    with gzip.open(args.out, "wt", encoding="utf-8") as fh:
        json.dump(bundle, fh)
    print(f"{len(records)} songs ({linked} linked to a server file), {len(playlists)} playlists, "
          f"{len(smart)} smart playlists -> {args.out}")


if __name__ == "__main__":
    main()
