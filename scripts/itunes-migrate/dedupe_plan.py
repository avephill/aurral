#!/usr/bin/env python3
"""Proposes which duplicate files to consolidate, and writes nothing.

Two files are the same recording when MusicBrainz says so. Whether that is a
duplicate depends on where they sit: the same recording on a studio album and
on a compilation is two different release groups and both are wanted, while the
same recording twice inside one release group is a copy of itself.

    python3 dedupe_plan.py --db navidrome.db --out dedupe-plan.md [--csv plan.csv]

The plan is a proposal. Nothing is deleted here, and consolidating properly is
more than deleting: the losing files carry ratings, stars, play counts and
playlist entries that have to move to the survivor first, or they are lost.
"""

import argparse
import csv
import sqlite3
from collections import defaultdict

# Lossless first, then the better lossy. A survivor is chosen on quality, and
# everything attached to the losers is meant to move to it.
FORMAT_RANK = {"flac": 3, "alac": 3, "wav": 3, "m4a": 2, "aac": 2, "ogg": 1, "opus": 1, "mp3": 1, "wma": 0}


def load(db, library_id):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    # Aggregated once and joined, rather than a subquery per row: the per-row
    # form takes minutes over 53,000 files.
    rows = con.execute(
        """
        WITH pl AS (
            SELECT media_file_id AS id, COUNT(*) AS n FROM playlist_tracks GROUP BY media_file_id
        ), ann AS (
            SELECT item_id AS id, COUNT(*) AS n FROM annotation
            WHERE item_type = 'media_file' AND (rating > 0 OR starred = 1 OR play_count > 0)
            GROUP BY item_id
        )
        SELECT m.id, m.path, m.title, m.artist, m.album, m.suffix, m.bit_rate, m.size,
               m.mbz_recording_id AS rec, m.mbz_release_group_id AS rg,
               COALESCE(pl.n, 0) AS in_playlists, COALESCE(ann.n, 0) AS marks
        FROM media_file m
        LEFT JOIN pl  ON pl.id  = m.id
        LEFT JOIN ann ON ann.id = m.id
        WHERE m.library_id = ? AND m.missing = 0
          AND m.mbz_recording_id <> '' AND m.mbz_release_group_id <> ''
        """,
        (library_id,),
    ).fetchall()
    con.close()
    return rows


def folder_of(path):
    parts = str(path or "").split("/")
    return "/".join(parts[:-1]) if len(parts) > 1 else ""


def looped(path):
    """A path that walks through the same folder name twice came out of a
    symlink loop, not off a disc.

    /music/Library/Searows/Searows once pointed back at its own parent, and
    Navidrome indexed the album underneath it over and over at increasing
    depth. Those rows look exactly like duplicates - identical recording,
    identical release group - and on 2026-09-11 they made up 767 of 1,633
    proposed deletions. Worse, 45 of them had been chosen as the copy to
    *keep*, which would have deleted the real file and left a phantom.
    """
    segments = str(path or "").split("/")[:-1]
    return len(segments) != len(set(segments))


def rank(row):
    """Best first."""
    return (
        FORMAT_RANK.get((row["suffix"] or "").lower(), 0),
        row["bit_rate"] or 0,
        row["size"] or 0,
        row["id"],          # stable when everything else ties
    )


def build(rows):
    groups = defaultdict(list)
    skipped_loops = 0
    for row in rows:
        if looped(row["path"]):
            skipped_loops += 1
            continue
        groups[(row["rec"], row["rg"])].append(row)
    if skipped_loops:
        print(f"ignored {skipped_loops} file(s) on symlink-loop paths; "
              "fix the loop and rescan, or this is hiding real files")

    across, within = [], []
    for (rec, rg), members in groups.items():
        if len(members) < 2:
            continue
        members.sort(key=rank, reverse=True)
        keep, drop = members[0], members[1:]
        entry = {
            "rec": rec, "rg": rg, "keep": keep, "drop": drop,
            "marks": sum(d["marks"] for d in drop),
            "playlists": sum(d["in_playlists"] for d in drop),
            "mixed": len({(m["suffix"] or "").lower() for m in members}) > 1,
        }
        # A copy in another folder is a second import of the album. A second
        # copy inside one folder is more likely a hidden or bonus track that
        # MusicBrainz maps onto the same recording, and wants a person to look.
        if all(folder_of(d["path"]) != folder_of(keep["path"]) for d in drop):
            across.append(entry)
        else:
            within.append(entry)
    return across, within


def render(across, within):
    def total(entries, field):
        return sum(len(e["drop"]) if field == "files" else e[field] for e in entries)

    lines = [
        "# Duplicate files that could be consolidated",
        "",
        "Two files are the same recording when MusicBrainz says so; they are a duplicate "
        "only when they also share a release group. The same recording on a studio album "
        "and on a compilation is two release groups, and both are kept.",
        "",
        "**Nothing here has been deleted.** The losing files carry ratings, stars, play "
        "counts and playlist entries; those have to be moved to the survivor first or they "
        "go with the file.",
        "",
        "| | groups | files freed | marks to move | playlist entries to repoint |",
        "|---|---:|---:|---:|---:|",
        f"| Duplicate album folders | {len(across)} | {total(across, 'files')} | "
        f"{total(across, 'marks')} | {total(across, 'playlists')} |",
        f"| Two copies inside one folder | {len(within)} | {total(within, 'files')} | "
        f"{total(within, 'marks')} | {total(within, 'playlists')} |",
        "",
    ]

    for title, entries, blurb in (
        ("Duplicate album folders", across,
         "The album was imported twice under slightly different names. The better copy is kept."),
        ("Two copies inside one folder", within,
         "Both copies sit in the same folder, so one may be a hidden or bonus track that "
         "MusicBrainz maps onto the same recording. Worth an eye before removing."),
    ):
        if not entries:
            continue
        entries.sort(key=lambda e: (-e["marks"], -e["playlists"]))
        lines += [f"## {title}", "", blurb, ""]
        for e in entries[:400]:
            keep = e["keep"]
            note = []
            if e["mixed"]:
                note.append("**mixed formats**")
            if e["marks"]:
                note.append(f"{e['marks']} ratings/plays to move")
            if e["playlists"]:
                note.append(f"{e['playlists']} playlist entries")
            lines.append(
                f"- **{keep['artist']} — {keep['title']}**{'  · ' + ', '.join(note) if note else ''}"
            )
            lines.append(f"    - keep `{keep['path']}` ({keep['suffix']}, {keep['bit_rate']}kbps)")
            for d in e["drop"]:
                lines.append(f"    - drop `{d['path']}` ({d['suffix']}, {d['bit_rate']}kbps)")
        if len(entries) > 400:
            lines.append(f"\n_...and {len(entries) - 400} more; the CSV has all of them._")
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True)
    ap.add_argument("--library-id", type=int, default=1)
    ap.add_argument("--out", default="dedupe-plan.md")
    ap.add_argument("--csv")
    args = ap.parse_args(argv)

    across, within = build(load(args.db, args.library_id))
    with open(args.out, "w") as fh:
        fh.write(render(across, within))

    if args.csv:
        with open(args.csv, "w", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(["kind", "recording", "release_group", "action", "file_id", "path",
                             "suffix", "bit_rate", "size", "marks", "in_playlists"])
            for kind, entries in (("album-folder", across), ("same-folder", within)):
                for e in entries:
                    for action, row in [("keep", e["keep"])] + [("drop", d) for d in e["drop"]]:
                        writer.writerow([kind, e["rec"], e["rg"], action, row["id"], row["path"],
                                         row["suffix"], row["bit_rate"], row["size"],
                                         row["marks"], row["in_playlists"]])

    freed = sum(len(e["drop"]) for e in across) + sum(len(e["drop"]) for e in within)
    print(f"wrote {args.out} — {len(across) + len(within)} groups, {freed} files could be freed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
