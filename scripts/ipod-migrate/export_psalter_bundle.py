#!/usr/bin/env python3
"""Turn an iPod Classic metadata backup into a Psalter library bundle.

The backup is the one in avery_ipod/: exports/library.json holds every track
the device knew, exports/playlists.json holds the playlists with their tracks
spelled out rather than referenced by id. This writes the bundle that
POST /api/song-records/import takes.

Two things are deliberately left behind. The comment tags, because they came
from a library inherited from someone else and are not this person's own
vocabulary. And the On-The-Go playlists, which are click-wheel scratch space.
"""
import argparse
import json
import pathlib

# Click-wheel scratch lists, and a feed rather than music.
SKIP_EXACT = {"Podcasts"}
SKIP_PREFIX = "On-The-Go"


def load(path):
    return json.load(open(path, encoding="utf-8"))


def record_key(track):
    return str(track["id"])


def as_record(track):
    """One song as the person's old library knew it. Comments are dropped."""
    return {
        "key": record_key(track),
        "title": track.get("title"),
        "artist": track.get("artist"),
        "albumArtist": None,  # the iPod database keeps no album artist
        "album": track.get("album"),
        "discNumber": None,
        "trackNumber": track.get("track_number"),
        "durationMs": track.get("duration_ms") or 0,
        "year": track.get("year"),
        "genre": track.get("genre"),
        "comment": None,
        "rating": track.get("rating_stars") or 0,
        "loved": False,
        "playCount": track.get("total_plays") or 0,
        "dateAdded": track.get("date_added"),
        "trackType": "File",
        "skipCount": track.get("skip_count") or 0,
        "lastPlayed": track.get("last_played"),
        "kind": track.get("filetype"),
    }


def identity(entry):
    """Playlists name their tracks rather than pointing at them."""
    return (
        (entry.get("artist") or "").strip().casefold(),
        (entry.get("album") or "").strip().casefold(),
        (entry.get("title") or "").strip().casefold(),
        entry.get("duration_ms") or 0,
    )


def build(export_dir, owner, suffix):
    library = load(export_dir / "exports/library.json")
    playlists = load(export_dir / "exports/playlists.json")

    by_identity = {}
    for track in library:
        by_identity.setdefault(identity(track), record_key(track))

    out_playlists = []
    dropped = []
    unresolved = 0
    for playlist in playlists:
        name = (playlist.get("name") or "").strip()
        if not name or name in SKIP_EXACT or name.startswith(SKIP_PREFIX):
            dropped.append(name)
            continue
        keys = []
        for entry in playlist.get("tracks") or []:
            key = by_identity.get(identity(entry))
            if key is None:
                unresolved += 1
                continue
            keys.append(key)
        out_playlists.append({
            "name": f"{name} {suffix}".strip(),
            "kind": "smart" if playlist.get("smart") else "manual",
            "keys": keys,
        })

    return {
        "format": "psalter-ipod-library",
        "owner": owner,
        "records": [as_record(track) for track in library],
        "playlists": out_playlists,
    }, dropped, unresolved


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export_dir", type=pathlib.Path, help="the iPod backup directory")
    ap.add_argument("--owner", required=True, help="the Psalter user whose library this is")
    ap.add_argument("--suffix", default="(iPod)", help="appended to every playlist name")
    ap.add_argument("--out", type=pathlib.Path, required=True)
    args = ap.parse_args()

    bundle, dropped, unresolved = build(args.export_dir, args.owner, args.suffix)
    json.dump(bundle, open(args.out, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"{len(bundle['records'])} songs, {len(bundle['playlists'])} playlists -> {args.out}")
    for playlist in bundle["playlists"]:
        print(f"  {len(playlist['keys']):>4}  {playlist['name']}")
    print(f"dropped {len(dropped)} playlist(s): {', '.join(dropped)}")
    if unresolved:
        print(f"{unresolved} playlist entries matched no song in the library")


if __name__ == "__main__":
    main()
