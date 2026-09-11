#!/usr/bin/env python3
"""Turns the smart playlists in an iTunes export into Navidrome rules.

The playlist migration copies the songs a smart playlist held on export day.
This reads what the playlist was actually asking for, so it can go on asking.

    python3 smart_playlists.py --export "iTunes Library.xml" --out plan.json

Nothing is written to Navidrome here: the output is a plan, and
apply-smart-playlists.mjs applies it from inside the Aurral container, where
both connections to Navidrome already exist. Anything that cannot cross over
is listed with a reason, so a playlist is either converted properly or left
for a person to look at.
"""

import argparse
import json
import plistlib
import sys
from pathlib import Path

from itunes_match import classify_playlist
from smart_criteria import SmartCriteriaError, convert_smart_playlist

# Playlists iTunes keeps for itself, and the whole-library lists that would
# only duplicate what Navidrome already shows.
SKIP_NAMES = {
    "library", "music", "movies", "tv shows", "podcasts", "audiobooks",
    "books", "purchased", "downloaded", "recently added", "recently played",
    "top 25 most played", "90's music", "my top rated", "classical music",
    "music videos", "voice memos",
}


def smart_playlists(export_path):
    with open(export_path, "rb") as handle:
        library = plistlib.load(handle)
    for playlist in library.get("Playlists", []):
        if classify_playlist(playlist) != "smart":
            continue
        yield playlist


def convert_export(export_path, *, skip_common=True):
    results = []
    for playlist in smart_playlists(export_path):
        name = playlist.get("Name") or "Untitled"
        if skip_common and name.strip().lower() in SKIP_NAMES:
            results.append({"name": name, "skipped": "one of iTunes' own lists"})
            continue
        info = playlist.get("Smart Info")
        criteria = playlist.get("Smart Criteria")
        if not info or not criteria:
            results.append({"name": name, "skipped": "no rules in the export"})
            continue
        try:
            converted = convert_smart_playlist(info, criteria)
        except (SmartCriteriaError, IndexError, ValueError) as error:
            results.append({"name": name, "error": str(error)})
            continue
        results.append({
            "name": name,
            "trackCount": len(playlist.get("Playlist Items", []) or []),
            **converted,
        })
    return results


def describe(condition):
    return f"{condition['field']} {condition['operator']} {condition['value']}"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--export", required=True, action="append", help="an iTunes library XML; repeatable, newest first")
    parser.add_argument("--out", help="write the plan here as JSON")
    parser.add_argument("--owner", default="", help="the Navidrome username these playlists belong to")
    parser.add_argument("--all", action="store_true", help="include iTunes' own lists, which are skipped by default")
    parser.add_argument("--quiet", action="store_true", help="only print the counts")
    args = parser.parse_args(argv)

    seen = {}
    for export in args.export:
        if not Path(export).exists():
            parser.error(f"no such export: {export}")
        for result in convert_export(export, skip_common=not args.all):
            # The first export listed wins, as elsewhere in this tool.
            seen.setdefault(result["name"], result)

    results = list(seen.values())
    ready = [result for result in results if result.get("convertible")]
    partial = [result for result in results if result.get("rules") and not result.get("convertible")]
    skipped = [result for result in results if result.get("skipped") or result.get("error")]

    if not args.quiet:
        for result in ready:
            rules = result["rules"]
            print(f"\n  {result['name']}")
            print(f"    match {rules['match']} of: " + "; ".join(describe(c) for c in rules["conditions"]))
            if rules["limit"]:
                print(f"    limit {rules['limit']}, chosen by {rules['sort'] or 'playlist order'} {rules['order']}")
        for result in partial:
            print(f"\n  {result['name']}  (needs a look)")
            for reason in result["unsupported"]:
                print(f"    - {reason}")
            if result["rules"]["conditions"]:
                print("    what did convert: " + "; ".join(describe(c) for c in result["rules"]["conditions"]))
        for result in skipped:
            print(f"\n  {result['name']}  ({result.get('skipped') or result.get('error')})")

    print(
        f"\n{len(results)} smart playlist(s): {len(ready)} ready, "
        f"{len(partial)} need a look, {len(skipped)} skipped"
    )

    if args.out:
        plan = {
            "owner": args.owner,
            "playlists": [
                {"name": result["name"], "rules": result["rules"], "liveUpdating": result.get("liveUpdating", True)}
                for result in ready
            ],
            "needsAttention": [
                {"name": result["name"], "unsupported": result.get("unsupported", []), "rules": result.get("rules")}
                for result in partial
            ],
            "skipped": [
                {"name": result["name"], "reason": result.get("skipped") or result.get("error")}
                for result in skipped
            ],
        }
        Path(args.out).write_text(json.dumps(plan, indent=2), encoding="utf-8")
        print(f"plan written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
