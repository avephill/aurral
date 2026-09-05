"""Report what was in the iTunes library but is not in Navidrome, grouped so it can
be worked through album by album: whole artists missing, whole albums missing
from artists that are present, and single tracks missing from albums that are.

    python3 missing_report.py --db navidrome.db --out DIR "Library.xml" "iTunes Library.xml"

Writes DIR/missing-report.md (readable), DIR/missing-albums.csv and
DIR/missing-tracks.csv (one row per track, with the iTunes Media folder it
came from). Apple Music streaming tracks, which were never files, are listed
separately so they do not look like lost rips.
"""
import argparse
import csv
import os
from collections import Counter, defaultdict
from difflib import get_close_matches
from urllib.parse import unquote, urlparse

from itunes_match import is_music, load_itunes, load_navidrome, match_all, norm_album, norm_artist

DRM = "Protected AAC audio file"


def media_dir(t):
    loc = t.get("Location")
    return os.path.dirname(unquote(urlparse(loc).path)) if loc else ""


def build(itunes, results, nav):
    nav_artists = set()
    nav_albums = set()
    display_artist = {}
    for r in nav:
        for a, shown in ((r["n_artist"], r["artist"]), (r["n_album_artist"], r["artist"])):
            if a:
                nav_artists.add(a)
                display_artist.setdefault(a, shown)
                nav_albums.add((a, r["n_album"]))

    album_total = Counter()
    for t in itunes.values():
        album_total[(norm_artist(t.get("Album Artist") or t.get("Artist")), norm_album(t.get("Album")))] += 1

    groups = defaultdict(list)  # (bucket, artist shown, album shown) -> tracks
    for pid, r in results.items():
        if r["nav_id"]:
            continue
        t = itunes[pid]
        shown_artist = t.get("Album Artist") or t.get("Artist") or ""
        a, al = norm_artist(shown_artist), norm_album(t.get("Album"))
        if t.get("Track Type") != "File":
            bucket = "apple-music-stream"
        elif a not in nav_artists and norm_artist(t.get("Artist")) not in nav_artists:
            bucket = "artist-missing"
        elif (a, al) not in nav_albums and (norm_artist(t.get("Artist")), al) not in nav_albums:
            bucket = "album-missing"
        else:
            bucket = "tracks-missing-from-album"
        groups[(bucket, shown_artist, t.get("Album") or "")].append(t)

    # An absent artist whose name is one typo away from a present one is probably
    # a spelling variant, not a missing artist.
    variants = {}
    nav_keys = list(nav_artists)
    for (bucket, artist, _album) in groups:
        if bucket == "artist-missing" and artist not in variants:
            close = get_close_matches(norm_artist(artist), nav_keys, n=1, cutoff=0.9)
            variants[artist] = display_artist[close[0]] if close else ""
    return groups, album_total, variants


def write(groups, album_total, variants, out):
    order = ["artist-missing", "album-missing", "tracks-missing-from-album", "apple-music-stream"]
    titles = {
        "artist-missing": "Artists with nothing in Navidrome",
        "album-missing": "Albums missing from artists Navidrome has",
        "tracks-missing-from-album": "Tracks missing from albums Navidrome has (check before ripping: some may be matcher misses)",
        "apple-music-stream": "Apple Music streaming tracks (never files; only relevant if he owns the CD)",
    }

    with open(f"{out}/missing-albums.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["bucket", "album_artist", "album", "tracks_missing", "tracks_in_itunes", "drm", "possible_variant_in_navidrome", "itunes_media_dirs"])
        for (bucket, artist, album), tracks in sorted(groups.items(), key=lambda kv: (order.index(kv[0][0]), kv[0][1].lower(), kv[0][2].lower())):
            total = album_total[(norm_artist(artist), norm_album(album))]
            drm = sum(1 for t in tracks if t.get("Kind") == DRM)
            dirs = sorted({media_dir(t) for t in tracks} - {""})
            w.writerow([bucket, artist, album, len(tracks), total, drm, variants.get(artist, ""), " | ".join(dirs)])

    with open(f"{out}/missing-tracks.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["bucket", "album_artist", "album", "track_no", "title", "artist", "kind", "seconds", "itunes_path"])
        for (bucket, artist, album), tracks in sorted(groups.items(), key=lambda kv: (order.index(kv[0][0]), kv[0][1].lower(), kv[0][2].lower())):
            for t in sorted(tracks, key=lambda t: (t.get("Disc Number") or 1, t.get("Track Number") or 0)):
                loc = t.get("Location")
                w.writerow([bucket, artist, album, t.get("Track Number") or "", t.get("Name"), t.get("Artist"), t.get("Kind"), round((t.get("Total Time") or 0) / 1000), unquote(urlparse(loc).path) if loc else ""])

    lines = ["# Music in the iTunes library that Navidrome does not have", ""]
    for bucket in order:
        entries = {k: v for k, v in groups.items() if k[0] == bucket}
        if not entries:
            continue
        n_tracks = sum(len(v) for v in entries.values())
        lines += [f"## {titles[bucket]}", "", f"{len(entries)} albums, {n_tracks} tracks", ""]
        by_artist = defaultdict(list)
        for (_b, artist, album), tracks in entries.items():
            by_artist[artist].append((album, tracks))
        for artist in sorted(by_artist, key=str.lower):
            albums = by_artist[artist]
            total = sum(len(t) for _, t in albums)
            note = f"  *(spelled '{variants[artist]}' in Navidrome?)*" if variants.get(artist) else ""
            lines.append(f"### {artist or '(no artist)'} — {total} tracks{note}")
            for album, tracks in sorted(albums, key=lambda at: at[0].lower()):
                have = album_total[(norm_artist(artist), norm_album(album))]
                drm = sum(1 for t in tracks if t.get("Kind") == DRM)
                flags = "  (DRM: needs a fresh rip)" if drm else ""
                lines.append(f"- **{album or '(no album)'}** — {len(tracks)} of {have} tracks{flags}")
                if bucket == "tracks-missing-from-album":
                    for t in sorted(tracks, key=lambda t: t.get("Track Number") or 0):
                        lines.append(f"    - {t.get('Track Number') or '?'}. {t.get('Name')}")
            lines.append("")
    with open(f"{out}/missing-report.md", "w") as fh:
        fh.write("\n".join(lines))

    for bucket in order:
        entries = [v for k, v in groups.items() if k[0] == bucket]
        artists = {k[1] for k in groups if k[0] == bucket}
        print(f"{titles[bucket]}: {len(artists)} artists, {len(entries)} albums, {sum(len(v) for v in entries)} tracks")
    print(f"possible spelling variants flagged: {sum(1 for v in variants.values() if v)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("exports", nargs="+", help="iTunes XML exports, newest first")
    ap.add_argument("--db", required=True)
    ap.add_argument("--library-id", type=int, default=1)
    ap.add_argument("--out", default=".")
    args = ap.parse_args()

    tracks, _ = load_itunes(args.exports)
    itunes = {pid: t for pid, t in tracks.items() if is_music(t)}
    nav = load_navidrome(args.db, args.library_id)
    results = match_all(itunes, nav)
    groups, album_total, variants = build(itunes, results, nav)
    os.makedirs(args.out, exist_ok=True)
    write(groups, album_total, variants, args.out)
    print(f"wrote {args.out}/missing-report.md, missing-albums.csv, missing-tracks.csv")


if __name__ == "__main__":
    main()
