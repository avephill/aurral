"""Turn missing-tracks.csv into rsync file lists for copying the originals out of
iTunes Media, split by where they should land:

  artists.list       Music/<Artist>/<Album>/<file>  -> Lidarr import (artist must exist in Lidarr)
  compilations.list  Compilations/<Album>/<file>    -> the unmanaged folder Navidrome scans
  drm.list           Protected AAC (.m4p), listed only; nothing can import them

Paths are relative to the 'iTunes Media/Music' folder, which is the one part of
a Location that stayed constant across every export:

  rsync -av --files-from=artists.list "<iTunes root>/iTunes Media/Music/" <staging dir>/

If rsync reports files missing, the 2019 exports also knew a nested copy of the
tree at 'iTunes Media/Music/iTunes Media/Music/'; run the same command from there.

    python3 stage_missing.py --report DIR   (DIR holds missing-tracks.csv; lists are written beside it)
"""
import argparse
import csv
import os
from collections import Counter


def tail(path):
    parts = path.rstrip("/").split("/")
    return "/".join(parts[-3:]) if len(parts) >= 3 else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--report", default=".", help="directory containing missing-tracks.csv")
    args = ap.parse_args()

    lists = {"artists": [], "compilations": [], "drm": []}
    folders = {"artists": set(), "compilations": set(), "drm": set()}
    seen = set()
    skipped = Counter()
    with open(os.path.join(args.report, "missing-tracks.csv"), newline="") as fh:
        for row in csv.DictReader(fh):
            if row["bucket"] == "apple-music-stream" or not row["itunes_path"]:
                skipped["never a file"] += 1
                continue
            rel = tail(row["itunes_path"])
            if not rel or rel in seen:
                continue
            seen.add(rel)
            if row["kind"] == "Protected AAC audio file" or rel.lower().endswith(".m4p"):
                group = "drm"
            elif rel.startswith("Compilations/"):
                group = "compilations"
            else:
                group = "artists"
            lists[group].append(rel)
            folders[group].add(rel.rsplit("/", 1)[0])

    for group, rels in lists.items():
        with open(os.path.join(args.report, f"{group}.list"), "w") as fh:
            fh.write("\n".join(sorted(rels)) + ("\n" if rels else ""))
        print(f"{group:13s} {len(rels):5d} files in {len(folders[group]):4d} folders -> {group}.list")
    if skipped:
        print("skipped:", dict(skipped))


if __name__ == "__main__":
    main()
