#!/usr/bin/env python3
"""One checklist for everything still missing from his library.

Three different jobs end up looking alike in the reports and are not alike at
all, so they are kept apart here:

  a disc to find        he owned it, the rip is gone, go and look for the CD
  a purchase to fetch   bought from the iTunes Store, re-download it
  a streaming album     never a file at all; it was rented from Apple Music and
                        went when the subscription did, so it has to be bought

Only streaming albums he had in full are listed. Three quarters of what he
streamed is a single track off a record - there is no album there to rebuild.

    python3 finish_library.py --report DIR --export EXPORT [--export ...] --out FILE

DIR holds albums-to-redigitize.csv and missing-tracks.csv from missing_report.py.
Exports are given newest first.
"""

import argparse
import csv
import plistlib
import unicodedata
from collections import defaultdict
from datetime import date

MEDIA_PREFIX = "iTunes Media/Music/"
# Titles that say nothing. Two records called "Unknown Album" are not the same
# record, and merging on the title alone once filed Neko Case and Vampire
# Weekend as one disc.
GENERIC_ALBUMS = {"unknown album", "no album", "untitled", ""}
MIN_ALBUM_TRACKS = 3        # fewer than this is a stray single, not a record
NEAR_COMPLETE = 0.8


def fold(value):
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return " ".join("".join(c if c.isalnum() else " " for c in text).split())


def short_folder(dirs):
    first = (dirs or "").split(" | ")[0]
    index = first.rfind(MEDIA_PREFIX)
    return first[index + len(MEDIA_PREFIX):] if index >= 0 else first


def merge_editions(rows):
    """One disc can appear several times over.

    iTunes filed Yo-Yo Ma's Cello Suites under two album titles and again under
    the movement names as if they were artists, so a single CD showed up as
    five rows and 48 tracks. Rows whose album title is a prefix of another's
    are the same record.
    """
    groups = []
    for row in sorted(rows, key=lambda r: len(fold(r["album"]))):
        folded = fold(row["album"])
        if folded in GENERIC_ALBUMS:
            groups.append([row])
            continue
        for group in groups:
            head = fold(group[0]["album"])
            if head not in GENERIC_ALBUMS and len(head) >= 10 and folded.startswith(head):
                group.append(row)
                break
        else:
            groups.append([row])
    return groups


def load_streaming_albums(report_dir, exports):
    stream = [r for r in csv.DictReader(open(f"{report_dir}/missing-tracks.csv"))
              if r["bucket"] == "apple-music-stream"]
    wanted = {(fold(r["artist"]), fold(r["title"])) for r in stream}

    best = {}
    for path in exports:                     # newest first; the first to know a track wins
        with open(path, "rb") as handle:
            library = plistlib.load(handle)
        for track in library["Tracks"].values():
            key = (fold(track.get("Artist")), fold(track.get("Name")))
            if key in wanted and key not in best:
                best[key] = track

    albums = defaultdict(lambda: {"have": 0, "total": 0, "stars": []})
    for track in best.values():
        artist = track.get("Album Artist") or track.get("Artist") or "(no artist)"
        entry = albums[(artist, track.get("Album") or "(no album)")]
        entry["have"] += 1
        entry["total"] = max(entry["total"], track.get("Track Count") or 0)
        entry["stars"].append(round((track.get("Rating") or 0) / 20))

    full, near = [], []
    for (artist, album), v in albums.items():
        if not v["total"] or v["have"] < MIN_ALBUM_TRACKS:
            continue
        share = v["have"] / v["total"]
        row = {"artist": artist, "album": album, **v,
               "best": max(v["stars"]) if v["stars"] else 0}
        if v["have"] >= v["total"]:
            full.append(row)
        elif share >= NEAR_COMPLETE:
            near.append(row)
    key = lambda r: -r["have"]
    return sorted(full, key=key), sorted(near, key=key), len(best), len(albums)


def render(discs, purchases, full, near, streamed_tracks, streamed_albums):
    lines = [
        "# Finishing his library",
        "",
        f"Generated {date.today()}. Three separate jobs, which the reports do not "
        "distinguish but a person has to.",
        "",
        "| | what it is | how many |",
        "|---|---|---:|",
        f"| Discs to find | he owned the CD, the rip is gone | {len(discs)} albums |",
        f"| Purchases to re-download | from the iTunes Store | {len(purchases)} |",
        f"| Streaming albums to buy | never a file; rented and gone | {len(full) + len(near)} |",
        "",
        "---",
        "",
        "## Discs to find",
        "",
        "He owned these. Find the disc and rip it again.",
        "",
    ]
    for group in discs:
        head = max(group, key=lambda r: int(r["tracks_missing"]))
        total = sum(int(r["tracks_missing"]) for r in group)
        year = f" ({head['year']})" if head["year"] else ""
        note = " · complete disc" if head["complete_disc"] == "True" else ""
        extra = f" · filed {len(group)} ways in iTunes" if len(group) > 1 else ""
        lines.append(f"- [ ] **{total}** — {head['album_artist'] or '(no artist)'} — "
                     f"*{head['album'] or '(no album)'}*{year}{note}{extra}")
        lines.append(f"      `{short_folder(head['itunes_media_dirs'])}`")
    lines.append("")

    lines += ["## Purchases to re-download", "",
              "Bought from the iTunes Store, so they are in his Purchased list.", ""]
    for row in purchases:
        year = f" ({row['year']})" if row["year"] else ""
        lines.append(f"- [ ] **{row['tracks_missing']}** — {row['album_artist'] or '(no artist)'} — "
                     f"*{row['album'] or '(no album)'}*{year}")
    lines.append("")

    lines += [
        "## Streaming albums to buy",
        "",
        f"He streamed {streamed_tracks} tracks across {streamed_albums} albums and rated every "
        "one of them, but they were never files - they went when Apple Music did. Three quarters "
        "are a single track off a record, and those are not worth chasing. These are the ones he "
        "had in full.",
        "",
        f"### Complete ({len(full)})",
        "",
    ]
    for row in full:
        lines.append(f"- [ ] **{row['have']}/{row['total']}** — {row['artist']} — *{row['album']}*"
                     f"{'  · up to ' + str(row['best']) + '★' if row['best'] >= 4 else ''}")
    lines += ["", f"### Most of the album ({len(near)})", ""]
    for row in near:
        lines.append(f"- [ ] **{row['have']}/{row['total']}** — {row['artist']} — *{row['album']}*"
                     f"{'  · up to ' + str(row['best']) + '★' if row['best'] >= 4 else ''}")
    lines += [
        "",
        "> Some of these names do not read like catalogue releases — check whether they are "
        "people he knows before treating them as replaceable.",
        "",
    ]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--report", required=True, help="directory holding the missing_report.py output")
    ap.add_argument("--export", required=True, action="append", help="iTunes XML, newest first")
    ap.add_argument("--out", default="finishing-his-library.md")
    args = ap.parse_args(argv)

    rows = [r for r in csv.DictReader(open(f"{args.report}/albums-to-redigitize.csv"))
            if r["status"] == "whole rip missing" and int(r["tracks_in_rip"]) >= MIN_ALBUM_TRACKS]
    discs = merge_editions([r for r in rows if r["source"] == "cd-rip"])
    discs.sort(key=lambda g: -sum(int(r["tracks_missing"]) for r in g))
    purchases = sorted((r for r in rows if r["source"] in ("itunes-purchase", "drm-purchase")),
                       key=lambda r: -int(r["tracks_missing"]))

    full, near, tracks, albums = load_streaming_albums(args.report, args.export)
    with open(args.out, "w") as fh:
        fh.write(render(discs, purchases, full, near, tracks, albums))
    print(f"wrote {args.out} — {len(discs)} discs, {len(purchases)} purchases, "
          f"{len(full)} complete and {len(near)} near-complete streaming albums")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
