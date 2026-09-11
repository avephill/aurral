#!/usr/bin/env python3
"""Tests for the leftover pass that finishes off part-matched albums.

    python3 -m pytest test_itunes_match.py
"""
import re
import unittest

from itunes_match import claim_album_leftovers, norm, norm_album, norm_artist, norm_bare, norm_loose


def nav_row(track_id, title, artist, album, duration, *, album_id="alb", comment=""):
    """A Navidrome row shaped the way load_navidrome shapes one."""
    return {
        "id": track_id,
        "path": f"{artist}/{album}/{title}.mp3",
        "title": title,
        "artist": artist,
        "album": album,
        "album_id": album_id,
        "duration": float(duration),
        "compilation": False,
        "n_title": norm(title),
        "l_title": norm_loose(title),
        "b_title": norm_bare(title),
        "segments": [norm(s) for s in re.split(r"\s+/\s+", title) if s] if " / " in title else [],
        "n_artist": norm_artist(artist),
        "n_album_artist": norm_artist(artist),
        "n_album": norm_album(album),
        "n_comment": norm(comment),
    }


def itunes_track(name, artist, album, seconds):
    return {"Name": name, "Artist": artist, "Album Artist": artist, "Album": album,
            "Total Time": int(seconds * 1000)}


class Leftovers(unittest.TestCase):
    def run_pass(self, itunes, results, nav):
        claim_album_leftovers(itunes, results, nav)
        return results

    def test_a_typo_is_placed_once_the_album_is_anchored(self):
        nav = [
            nav_row("n1", "Opening", "Zucchero", "Sugar", 100),
            nav_row("n2", "Diamante", "Zucchero", "Sugar", 240),
        ]
        itunes = {
            "p1": itunes_track("Opening", "Zucchero", "Sugar", 100),
            "p2": itunes_track("Diamond (Diamante)", "Zucchero", "Sugar", 240),
        }
        results = {"p1": {"nav_id": "n1", "tier": "T1", "ambiguous": False},
                   "p2": {"nav_id": None, "tier": "unmatched", "ambiguous": False}}
        self.run_pass(itunes, results, nav)
        self.assertEqual(results["p2"]["nav_id"], "n2")
        self.assertIn("T11", results["p2"]["tier"])

    def test_the_same_length_is_not_enough_on_its_own(self):
        # Two tracks on one record often run the same seconds. Without the
        # title agreeing this would file one as the other.
        nav = [
            nav_row("n1", "Hungry Freaks", "Frank Zappa", "Freak Out", 200),
            nav_row("n2", "How Could I Be Such a Fool", "Frank Zappa", "Freak Out", 133),
        ]
        itunes = {
            "p1": itunes_track("Hungry Freaks", "Frank Zappa", "Freak Out", 200),
            "p2": itunes_track("The Black Page #1 (Piano Version)", "Frank Zappa", "Freak Out", 133),
        }
        results = {"p1": {"nav_id": "n1", "tier": "T1", "ambiguous": False},
                   "p2": {"nav_id": None, "tier": "unmatched", "ambiguous": False}}
        self.run_pass(itunes, results, nav)
        self.assertIsNone(results["p2"]["nav_id"])

    def test_numbered_tracks_are_left_alone_when_the_numbers_disagree(self):
        nav = [
            nav_row("n1", "Track 01", "Tom Waits", "The Application", 100),
            nav_row("n2", "Track 09", "Tom Waits", "The Application", 150),
        ]
        itunes = {
            "p1": itunes_track("Track 01", "Tom Waits", "The Application", 100),
            "p2": itunes_track("Track 17", "Tom Waits", "The Application", 150),
        }
        results = {"p1": {"nav_id": "n1", "tier": "T1", "ambiguous": False},
                   "p2": {"nav_id": None, "tier": "unmatched", "ambiguous": False}}
        self.run_pass(itunes, results, nav)
        self.assertIsNone(results["p2"]["nav_id"], "Track 17 is not Track 09")

    def test_a_compilation_title_carrying_its_artist_is_read_as_the_title(self):
        nav = [
            nav_row("n1", "Sous le ciel", "Various", "French Cafe", 100),
            nav_row("n2", "La Fée Clochette", "Various", "French Cafe", 153),
        ]
        itunes = {
            "p1": itunes_track("Sous le ciel", "Various", "French Cafe", 100),
            "p2": itunes_track("Fée Clochette - Coralie Clément ", "Various", "French Cafe", 153),
        }
        results = {"p1": {"nav_id": "n1", "tier": "T1", "ambiguous": False},
                   "p2": {"nav_id": None, "tier": "unmatched", "ambiguous": False}}
        self.run_pass(itunes, results, nav)
        self.assertEqual(results["p2"]["nav_id"], "n2")

    def test_one_free_slot_goes_to_the_better_reading(self):
        nav = [
            nav_row("n1", "Anchor", "Band", "Record", 100),
            nav_row("n2", "La Llorona", "Band", "Record", 200),
        ]
        itunes = {
            "p1": itunes_track("Anchor", "Band", "Record", 100),
            "p2": itunes_track("Liorona", "Band", "Record", 200),
            "p3": itunes_track("La Llorona", "Band", "Record", 200),
        }
        results = {"p1": {"nav_id": "n1", "tier": "T1", "ambiguous": False},
                   "p2": {"nav_id": None, "tier": "unmatched", "ambiguous": False},
                   "p3": {"nav_id": None, "tier": "unmatched", "ambiguous": False}}
        self.run_pass(itunes, results, nav)
        self.assertEqual(results["p3"]["nav_id"], "n2", "the exact title takes the slot")
        self.assertIsNone(results["p2"]["nav_id"], "the slot is not handed out twice")

    def test_an_album_with_nothing_matched_is_not_guessed_at(self):
        # Nothing anchors it to a Navidrome album, so there is no small pool to
        # choose from and the whole premise of the pass is absent.
        nav = [nav_row("n1", "Diamante", "Zucchero", "Sugar", 240)]
        itunes = {"p1": itunes_track("Diamond (Diamante)", "Zucchero", "Sugar", 240)}
        results = {"p1": {"nav_id": None, "tier": "unmatched", "ambiguous": False}}
        self.run_pass(itunes, results, nav)
        self.assertIsNone(results["p1"]["nav_id"])

    def test_a_slot_already_claimed_elsewhere_is_not_reused(self):
        nav = [
            nav_row("n1", "Anchor", "Band", "Record", 100),
            nav_row("n2", "Diamante", "Band", "Record", 240),
        ]
        itunes = {
            "p1": itunes_track("Anchor", "Band", "Record", 100),
            "p2": itunes_track("Diamond (Diamante)", "Band", "Record", 240),
        }
        results = {"p1": {"nav_id": "n1", "tier": "T1", "ambiguous": False},
                   "p2": {"nav_id": None, "tier": "unmatched", "ambiguous": False},
                   "p9": {"nav_id": "n2", "tier": "T1", "ambiguous": False}}
        self.run_pass(itunes, results, nav)
        self.assertIsNone(results["p2"]["nav_id"])

    def test_a_length_that_disagrees_rules_a_slot_out(self):
        nav = [
            nav_row("n1", "Anchor", "Band", "Record", 100),
            nav_row("n2", "Diamante", "Band", "Record", 400),
        ]
        itunes = {
            "p1": itunes_track("Anchor", "Band", "Record", 100),
            "p2": itunes_track("Diamond (Diamante)", "Band", "Record", 240),
        }
        results = {"p1": {"nav_id": "n1", "tier": "T1", "ambiguous": False},
                   "p2": {"nav_id": None, "tier": "unmatched", "ambiguous": False}}
        self.run_pass(itunes, results, nav)
        self.assertIsNone(results["p2"]["nav_id"])


if __name__ == "__main__":
    unittest.main()
