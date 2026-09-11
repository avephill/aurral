#!/usr/bin/env python3
"""Turns the re-digitize list into a checklist a person can work through.

missing_report.py writes albums-to-redigitize.csv, one row per folder iTunes
ripped a disc into. This picks out the rips that are missing *entirely* - the
ones where nothing of the album reached the server - and groups them by what
actually has to be done, because the three groups need different things:

  a CD rip      find the disc and rip it again
  a purchase    re-download it from the Purchased list
  a DRM purchase  nothing can import it; it has to be bought again unplayable-free

    python3 lost_albums.py --report DIR [--out DIR/lost-albums.md]

DIR is the directory holding albums-to-redigitize.csv. Re-run it after importing
music and the list shrinks; it is regenerated from the report, never edited by
hand, so ticked boxes do not survive a regeneration - the point is that a ticked
box should have disappeared from the list instead.
"""

import argparse
import csv
import os
from datetime import date

# The one part of an iTunes Location that stayed constant across every export.
MEDIA_PREFIX = "iTunes Media/Music/"

GROUPS = [
    ("cd-rip", "Discs to find and rip again", "The only copy was a CD rip, and it is gone from the server."),
    ("itunes-purchase", "Purchases to re-download", "Bought from the iTunes Store, so it can be downloaded again from Purchased."),
    ("drm-purchase", "Protected purchases", "Protected AAC. Nothing can import these; they would have to be replaced."),
]


def short_folder(dirs):
    """The 'Artist/Album' tail of the iTunes media path, which is what the rsync
    lists in stage_missing.py are relative to. The library nests the same tree
    twice, so the last occurrence of the prefix is the one that counts."""
    first = (dirs or "").split(" | ")[0]
    index = first.rfind(MEDIA_PREFIX)
    return first[index + len(MEDIA_PREFIX):] if index >= 0 else first


def load(report_dir):
    path = os.path.join(report_dir, "albums-to-redigitize.csv")
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def entry(r):
    """One checklist line, plus the folder its files came from."""
    notes = []
    if r["complete_disc"] == "True":
        notes.append("complete disc")
    elif r["tracks_on_disc"]:
        notes.append(f"{r['tracks_in_rip']} of {r['tracks_on_disc']} on the disc")
    if r["compilation"] == "True":
        notes.append(f"compilation, {r['artists_on_it']} artists")
    if r["source"] == "drm-purchase":
        notes.append("**protected, cannot be imported**")
    elif r["source"] == "itunes-purchase":
        notes.append("purchase")
    year = f" ({r['year']})" if r["year"] else ""
    tail = f" — {', '.join(notes)}" if notes else ""
    return [
        f"- [ ] **{r['tracks_missing']}** — {r['album_artist'] or '(no artist)'} — "
        f"*{r['album'] or '(no album)'}*{year}{tail}",
        f"      `{short_folder(r['itunes_media_dirs'])}`",
    ]


def render(rows, *, include_partial=False):
    whole = [r for r in rows if r["status"] == "whole rip missing"]
    partial = [r for r in rows if r["status"] != "whole rip missing"]

    # A folder iTunes only ever held one or two tracks in is a stray purchase,
    # not a lost album, and mixing the two makes the list look three times the
    # work it is - you would go hunting for a Daft Punk album to replace one
    # bought single.
    albums = sorted(
        (r for r in whole if int(r["tracks_in_rip"]) >= 3),
        key=lambda r: (-int(r["tracks_missing"]), (r["album_artist"] or "").lower()),
    )
    strays = sorted(whole, key=lambda r: (r["album_artist"] or "").lower())
    strays = [r for r in strays if int(r["tracks_in_rip"]) < 3]

    lines = [
        "# Albums to track down",
        "",
        f"Generated {date.today()} from `albums-to-redigitize.csv`.",
        "",
        f"**{len(albums)} albums, {sum(int(r['tracks_missing']) for r in albums)} tracks** "
        "reached the server not at all. Plus "
        f"{len(strays)} stray one- or two-track folders ({sum(int(r['tracks_missing']) for r in strays)} tracks), "
        "listed at the end - those are single purchases, not lost albums.",
        "",
        f"{len(partial)} further albums arrived only partly. That is a different job, usually a "
        "matcher miss rather than missing music, and it lives in the CSV.",
        "",
    ]

    for source, title, blurb in GROUPS:
        group = [r for r in albums if r["source"] == source]
        if not group:
            continue
        count = sum(int(r["tracks_missing"]) for r in group)
        lines += [f"## {title}", "", f"{blurb} {len(group)} albums, {count} tracks.", ""]
        for r in group:
            lines += entry(r)
        lines.append("")

    if strays:
        lines += [
            "## Stray tracks",
            "",
            f"{len(strays)} folders iTunes only held one or two tracks in. Most are single "
            "purchases; re-download rather than go looking for a disc.",
            "",
        ]
        for r in strays:
            lines += entry(r)
        lines.append("")

    if include_partial and partial:
        lines += ["## Arrived only partly", "", f"{len(partial)} albums.", ""]
        for r in sorted(partial, key=lambda r: -int(r["tracks_missing"])):
            year = f" ({r['year']})" if r["year"] else ""
            lines.append(
                f"- [ ] **{r['tracks_missing']}** — {r['album_artist'] or '(no artist)'} — "
                f"*{r['album'] or '(no album)'}*{year} — {r['status']}"
            )
        lines.append("")

    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--report", required=True, help="directory holding albums-to-redigitize.csv")
    ap.add_argument("--out", help="where to write the checklist (default: <report>/lost-albums.md)")
    ap.add_argument("--include-partial", action="store_true", help="also list the rips that arrived only partly")
    args = ap.parse_args(argv)

    rows = load(args.report)
    text = render(rows, include_partial=args.include_partial)
    out = args.out or os.path.join(args.report, "lost-albums.md")
    with open(out, "w") as fh:
        fh.write(text)
    whole = [r for r in rows if r["status"] == "whole rip missing"]
    albums = sum(1 for r in whole if int(r["tracks_in_rip"]) >= 3)
    print(f"wrote {out} — {albums} albums and {len(whole) - albums} stray tracks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
