#!/usr/bin/env python3
"""Tests for how migrate.py reads its own state across a Navidrome id change.

    python3 -m pytest test_migrate.py
"""
import json
import os
import tempfile
import unittest

from migrate import apply_playlists, canonical_id, load_state


class CanonicalId(unittest.TestCase):
    def test_legacy_hex_becomes_base62(self):
        self.assertEqual(canonical_id("0" * 31 + "1"), "0" * 21 + "1")
        self.assertEqual(canonical_id("f" * 32), "7N42dgm5tFLK9N8MT7fHC7")

    def test_matches_an_id_navidrome_0_64_actually_issued(self):
        # Read from a real library after the upgrade, not derived from the code.
        self.assertEqual(canonical_id("20551900fb189dd66fc36fb67b5d497c"), "0Z0DWkO4cF4MmDtGa04P8w")

    def test_new_ids_and_non_ids_pass_through(self):
        for value in ("ZAceDvGPkb6rqIqoXHsU2I", "74ExSV0vxKToi5U2TucAZn", "", None, 3):
            self.assertEqual(canonical_id(value), value)
        # Uppercase hex was never an id Navidrome issued; leave it alone.
        self.assertEqual(canonical_id("A" * 32), "A" * 32)


class LoadState(unittest.TestCase):
    def test_state_written_before_the_upgrade_reads_in_new_ids(self):
        old, new = "20551900fb189dd66fc36fb67b5d497c", "0Z0DWkO4cF4MmDtGa04P8w"
        raw = {"playlists": {"Mix": [old, "ZAceDvGPkb6rqIqoXHsU2I"]},
               "ratings": {old: 4}, "album_ratings": {"74ExSV0vxKToi5U2TucAZn": 3},
               "loved": [old]}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "applied.json")
            with open(path, "w") as fh:
                json.dump(raw, fh)
            state = load_state(path)
        self.assertEqual(state["playlists"], {"Mix": [new, "ZAceDvGPkb6rqIqoXHsU2I"]})
        self.assertEqual(state["ratings"], {new: 4})
        self.assertEqual(state["album_ratings"], {"74ExSV0vxKToi5U2TucAZn": 3})
        self.assertEqual(state["loved"], [new])


class FakeNavidrome:
    """Just enough of the client for apply_playlists: one owned playlist, whose
    live contents are served through getPlaylist."""
    user_id = "me"

    def __init__(self, live_tracks):
        self.live_tracks = live_tracks
        self.calls = []

    def native(self, method, path, body=None):
        self.calls.append((method, path))
        if method == "GET":
            return [{"id": "pl1", "name": "Mix", "ownerId": "me", "songCount": len(self.live_tracks),
                     "comment": "[itunes-migrate] smart playlist from iTunes export"}]
        if method == "POST" and path == "/api/playlist":
            return {"id": "pl2"}
        return None

    def subsonic(self, endpoint, **params):
        self.calls.append(("SUBSONIC", endpoint))
        return {"playlist": {"entry": [{"id": i} for i in self.live_tracks]}}

    def writes(self):
        return [c for c in self.calls if c[0] in ("DELETE", "POST")]


def entry(resolved):
    return {"name": "Mix", "resolved": resolved, "kind": "smart", "total": len(resolved), "exported": None}


class ApplyPlaylists(unittest.TestCase):
    def test_unchanged_plan_is_left_alone(self):
        nd = FakeNavidrome(["a", "b"])
        apply_playlists(nd, [entry(["a", "b"])], False, {"playlists": {"Mix": ["a", "b"]}})
        self.assertEqual(nd.writes(), [])

    def test_stale_state_does_not_rewrite_a_playlist_navidrome_already_has(self):
        # The state still names ids that no longer exist, but the playlist in
        # Navidrome already holds exactly what the plan wants.
        nd = FakeNavidrome(["a", "b"])
        apply_playlists(nd, [entry(["a", "b"])], False, {"playlists": {"Mix": ["gone1", "gone2"]}})
        self.assertEqual(nd.writes(), [])

    def test_a_changed_plan_still_replaces_the_playlist(self):
        nd = FakeNavidrome(["a", "b"])
        apply_playlists(nd, [entry(["a", "c"])], False, {"playlists": {"Mix": ["a", "b"]}})
        self.assertIn(("DELETE", "/api/playlist/pl1"), nd.writes())
        self.assertIn(("POST", "/api/playlist"), nd.writes())


if __name__ == "__main__":
    unittest.main()
