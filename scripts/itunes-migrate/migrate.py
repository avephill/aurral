"""Migrate an iTunes library into one Navidrome user's account.

Playlists become static snapshots of what the export contained (smart playlists
included: their rules keyed on iTunes-side genres and comments that only partly
survived beets, so the membership list is the faithful thing to carry over).
Song ratings map star for star (iTunes 20..100 -> Navidrome 1..5) and loved
tracks become starred. Everything goes through Navidrome's own APIs
authenticated as the target user, so playlists are owned by them and ratings
land in their annotations; nothing touches the database.

    ND_PASS=... python3 migrate.py --db navidrome.db --url http://127.0.0.1:4532 --user dunshill \\
        "Library.xml" "iTunes Music Library.xml" "iTunes Library.xml"

Without --apply nothing is written: the plan is printed and saved to --out.
Re-running with --apply replaces playlists this tool created earlier (found by
the marker in their comment) and leaves any other playlist of the same name
alone, so it is safe to run again after more of the library has been imported.
"""
import argparse
import csv
import hashlib
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

from itunes_match import is_music, load_itunes, load_navidrome, match_all, summarize, write_unmatched_csv

MARKER = "[itunes-migrate]"
TRACK_BATCH = 1000

# Views of the whole library or of listening history, which Navidrome provides
# itself, plus the "what have I not tagged yet" maintenance lists. Override
# with --all-playlists or --include.
MECHANICAL_PLAYLISTS = {
    "all music",
    "downloaded",
    "most recent music",
    "newest music",
    "the newest music",
    "rated songs",
    "rated songs - unrated",
    "recently played",
    "top 25 most played",
    "rarely listened < 2 times",
    "new music - rarely listened to",
    "songs without a comment",
    "songs with no comments",
    "songs without speed in comment",
    "songs without a rating",
    "songs that have no rating",
}


# --------------------------------------------------------------------------- Navidrome client

class Navidrome:
    def __init__(self, url, user, password):
        self.url = url.rstrip("/")
        self.user = user
        self.password = password
        self.token = None
        self.user_id = None

    def _login(self):
        req = urllib.request.Request(
            f"{self.url}/auth/login",
            data=json.dumps({"username": self.user, "password": self.password}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
        self.token = data.get("token")
        self.user_id = data.get("id")
        if not self.token:
            raise RuntimeError("Navidrome login returned no token")

    def native(self, method, path, body=None):
        if not self.token:
            self._login()
        for attempt in range(2):
            req = urllib.request.Request(
                f"{self.url}{path}",
                data=json.dumps(body).encode() if body is not None else None,
                method=method,
                headers={"Content-Type": "application/json", "X-ND-Authorization": f"Bearer {self.token}"},
            )
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    refreshed = r.headers.get("x-nd-authorization")
                    if refreshed:
                        self.token = refreshed.removeprefix("Bearer ").strip()
                    raw = r.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 0:
                    self._login()
                    continue
                raise RuntimeError(f"{method} {path} -> {e.code}: {e.read()[:300]!r}") from e
        raise RuntimeError(f"{method} {path}: authentication kept failing")

    def subsonic(self, endpoint, **params):
        salt = secrets.token_hex(8)
        auth = {
            "u": self.user,
            "t": hashlib.md5((self.password + salt).encode()).hexdigest(),
            "s": salt,
            "v": "1.16.1",
            "c": "itunes-migrate",
            "f": "json",
        }
        query = urllib.parse.urlencode({**auth, **params}, doseq=True)
        with urllib.request.urlopen(f"{self.url}/rest/{endpoint}?{query}", timeout=60) as r:
            data = json.load(r)["subsonic-response"]
        if data.get("status") != "ok":
            raise RuntimeError(f"{endpoint}: {data.get('error')}")
        return data


# --------------------------------------------------------------------------- planning

def dedupe(seq):
    seen = set()
    out = []
    for x in seq:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def select_playlists(playlists, itunes, results, args):
    include = [re.compile(p, re.I) for p in args.include]
    exclude = [re.compile(p, re.I) for p in args.exclude]
    library_size = sum(1 for r in results.values() if r["nav_id"])
    newest_export = max((pl["exported"] for pl in playlists.values() if pl["exported"]), default=None)
    chosen, skipped = [], []
    seen_shapes = {}
    for pl in playlists.values():
        name = pl["name"] or ""
        key = name.strip().lower()
        items = [pid for pid in pl["items"] if pid in itunes]
        resolved = dedupe(results[pid]["nav_id"] for pid in items)
        reason = None
        if any(p.search(name) for p in include):
            pass
        elif any(p.search(name) for p in exclude):
            reason = "excluded by --exclude"
        elif not args.all_playlists and pl["kind"] == "smart" and key in MECHANICAL_PLAYLISTS:
            reason = "mechanical view of the library or listening history"
        elif not args.all_playlists and pl["kind"] == "smart" and len(resolved) > 0.8 * library_size:
            reason = f"covers {len(resolved) / library_size:.0%} of the library"
        if not reason and not resolved:
            reason = "no resolvable tracks"
        # The same rule exported twice under 'Alternative - Folk' and 'Alternative Folk'
        # differs only in sort order.
        shape = (re.sub(r"[^a-z0-9]", "", key), frozenset(resolved))
        if not reason and shape in seen_shapes:
            reason = f"same name and tracks as {seen_shapes[shape]!r}"
        entry = {
            "name": name,
            "kind": pl["kind"],
            "exported": pl["exported"],
            "only_in_older_export": bool(pl["exported"] and newest_export and pl["exported"] < newest_export),
            "total": len(items),
            "resolved": resolved,
        }
        if reason:
            if (name, reason) not in skipped:
                skipped.append((name, reason))
        else:
            seen_shapes[shape] = name
            chosen.append(entry)
    chosen.sort(key=lambda e: e["name"].lower())
    return chosen, skipped


def stars(rating):
    """iTunes stores 20 per star; this library has no half stars."""
    return min(5, max(1, round(rating / 20)))


def plan_ratings(itunes, results, nav):
    album_of = {r["id"]: r["album_id"] for r in nav}
    ratings = {}
    loved = set()
    album_votes = {}
    for pid, t in itunes.items():
        nav_id = results[pid]["nav_id"]
        if not nav_id:
            continue
        rating = t.get("Rating") or 0
        if rating and not t.get("Rating Computed"):
            ratings[nav_id] = max(ratings.get(nav_id, 0), stars(rating))
        if t.get("Loved"):
            loved.add(nav_id)
        # iTunes stamps the album rating on every track; 'Computed' means it was
        # derived from track ratings rather than set by hand.
        album_rating = t.get("Album Rating") or 0
        if album_rating and not t.get("Album Rating Computed") and album_of.get(nav_id):
            album_votes.setdefault(album_of[nav_id], Counter())[stars(album_rating)] += 1
    # Tracks from one iTunes album can land on two Navidrome albums (or vice versa); majority wins.
    album_ratings = {album_id: votes.most_common(1)[0][0] for album_id, votes in album_votes.items()}
    return ratings, sorted(loved), album_ratings


def print_plan(chosen, skipped, ratings, loved, album_ratings):
    print("\nplaylists to create:")
    for e in chosen:
        note = "   (only in an older export: renamed or deleted later)" if e["only_in_older_export"] else ""
        print(f"  {e['kind']:5s}  {len(e['resolved']):6d}/{e['total']:<6d}  {e['name']}{note}")
    print(f"  {len(chosen)} playlists, {sum(len(e['resolved']) for e in chosen)} entries")
    if skipped:
        print("\nplaylists skipped:")
        for name, reason in skipped:
            print(f"  {name!r}: {reason}")
    hist = Counter(ratings.values())
    print(f"\nsong ratings to set: {len(ratings)}  " + "  ".join(f"{s}★={hist.get(s, 0)}" for s in range(1, 6)))
    hist = Counter(album_ratings.values())
    print(f"album ratings to set: {len(album_ratings)}  " + "  ".join(f"{s}★={hist.get(s, 0)}" for s in range(1, 6)))
    print(f"tracks to star (iTunes 'Loved'): {len(loved)}")


# --------------------------------------------------------------------------- applying

def apply_playlists(nd, chosen, public, replace_existing=False, delete_file_backed=False):
    existing = nd.native("GET", "/api/playlist?_end=2000") or []
    mine = [pl for pl in existing if pl.get("ownerId") == nd.user_id]

    if delete_file_backed:
        # Navidrome re-imports an .m3u it can still see on the next scan, so the
        # files themselves must already be out of the library tree.
        for pl in mine:
            if pl.get("path"):
                nd.native("DELETE", f"/api/playlist/{pl['id']}")
                print(f"  deleted file-backed {pl['name']!r} ({pl.get('songCount')} songs, {pl['path']})")
        mine = [pl for pl in mine if not pl.get("path")]

    mine_by_name = {}
    for pl in mine:
        mine_by_name.setdefault(pl["name"], []).append(pl)

    for e in chosen:
        for pl in mine_by_name.get(e["name"], []):
            if replace_existing or (pl.get("comment") or "").startswith(MARKER):
                nd.native("DELETE", f"/api/playlist/{pl['id']}")
                print(f"  replaced existing {e['name']!r} ({pl.get('songCount')} songs)")
            else:
                print(f"  skipping {e['name']!r}: a playlist of that name exists and was not created by this tool")
                e["skipped"] = True
        if e.get("skipped"):
            continue
        exported = e["exported"].strftime("%Y-%m-%d") if e["exported"] else "unknown date"
        comment = f"{MARKER} {e['kind']} playlist from iTunes export {exported}; {len(e['resolved'])}/{e['total']} tracks matched"
        created = nd.native("POST", "/api/playlist", {"name": e["name"], "comment": comment, "public": bool(public)})
        playlist_id = created.get("id") if isinstance(created, dict) else None
        if not playlist_id:
            raise RuntimeError(f"creating {e['name']!r} returned no id: {created!r}")
        ids = e["resolved"]
        for start in range(0, len(ids), TRACK_BATCH):
            nd.native("POST", f"/api/playlist/{playlist_id}/tracks", {"ids": ids[start : start + TRACK_BATCH]})
        print(f"  created {e['name']!r} with {len(ids)} tracks")


def apply_ratings(nd, ratings, loved, album_ratings):
    for label, table in (("songs", ratings), ("albums", album_ratings)):
        done = 0
        for item_id, value in table.items():
            nd.subsonic("setRating", id=item_id, rating=value)
            done += 1
            if done % 1000 == 0:
                print(f"  rated {done}/{len(table)} {label}", flush=True)
        print(f"  rated {done}/{len(table)} {label}")
    if loved:
        nd.subsonic("star", id=loved)
        print(f"  starred {len(loved)}")


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("exports", nargs="+", help="iTunes XML exports, newest first")
    ap.add_argument("--db", required=True, help="path to navidrome.db (opened read-only, for matching)")
    ap.add_argument("--library-id", type=int, default=1, help="Navidrome library whose songs playlists should reference")
    ap.add_argument("--url", default="http://127.0.0.1:4533", help="Navidrome base URL")
    ap.add_argument("--user", required=True, help="Navidrome user to migrate into; password from ND_PASS")
    ap.add_argument("--out", default=".", help="directory for plan.json, match.json and unmatched.csv")
    ap.add_argument("--apply", action="store_true", help="write to Navidrome (default is a dry run)")
    ap.add_argument("--public", action="store_true", help="create playlists as public")
    ap.add_argument("--replace-existing", action="store_true", help="also replace same-named playlists this tool did not create")
    ap.add_argument("--delete-file-backed", action="store_true", help="first delete every .m3u-backed playlist the user owns (move the files out of the library first)")
    ap.add_argument("--all-playlists", action="store_true", help="include the mechanical library/history views too")
    ap.add_argument("--include", action="append", default=[], help="regex: always include playlists matching this")
    ap.add_argument("--exclude", action="append", default=[], help="regex: skip playlists matching this")
    ap.add_argument("--skip-playlists", action="store_true")
    ap.add_argument("--skip-ratings", action="store_true")
    ap.add_argument("--skip-album-ratings", action="store_true")
    args = ap.parse_args()

    tracks, playlists = load_itunes(args.exports)
    itunes = {pid: t for pid, t in tracks.items() if is_music(t)}
    nav = load_navidrome(args.db, args.library_id)
    results = match_all(itunes, nav)
    print(summarize(itunes, results, playlists))
    os.makedirs(args.out, exist_ok=True)
    with open(f"{args.out}/match.json", "w") as fh:
        json.dump(results, fh)
    write_unmatched_csv(f"{args.out}/unmatched.csv", itunes, results)

    chosen, skipped = select_playlists(playlists, itunes, results, args)
    ratings, loved, album_ratings = plan_ratings(itunes, results, nav)
    if args.skip_album_ratings:
        album_ratings = {}
    print_plan(chosen, skipped, ratings, loved, album_ratings)
    with open(f"{args.out}/plan.json", "w") as fh:
        json.dump(
            {
                "playlists": [{**e, "exported": str(e["exported"])} for e in chosen],
                "skipped": skipped,
                "ratings": ratings,
                "album_ratings": album_ratings,
                "loved": loved,
            },
            fh,
        )
    print(f"\nwrote {args.out}/plan.json, match.json, unmatched.csv")

    if not args.apply:
        print("\ndry run: nothing written to Navidrome (pass --apply)")
        return

    password = os.environ.get("ND_PASS")
    if not password:
        sys.exit("ND_PASS must hold the Navidrome password for --user")
    nd = Navidrome(args.url, args.user, password)
    nd._login()
    print(f"\nlogged in as {args.user} ({nd.user_id})")
    if not args.skip_playlists:
        print("playlists:")
        apply_playlists(nd, chosen, args.public, args.replace_existing, args.delete_file_backed)
    if not args.skip_ratings:
        print("ratings:")
        apply_ratings(nd, ratings, loved, album_ratings)
    print("done")


if __name__ == "__main__":
    main()
