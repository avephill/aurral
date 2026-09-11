"""Tests for the smart playlist reader.

The blobs here are built byte by byte to the layout documented in
smart_criteria.py, so the test says what iTunes writes and the reader has to
agree with it. Run with: python3 -m unittest test_smart_criteria
"""

import struct
import unittest

from smart_criteria import (
    CRITERIA_FIRST_RULE,
    GROUP_LENGTH,
    convert_smart_playlist,
    is_flat,
    parse_criteria,
    parse_info,
)

RULE_STRIDE = 200  # room for one rule; the reader finds the next by itself


def info_blob(*, live=True, uses_rules=True, limited=False, limit_method=0x03,
              limit_count=0, selection=0x02, sign=1):
    info = bytearray(16)
    info[0] = 1 if live else 0
    info[1] = 1 if uses_rules else 0
    info[2] = 1 if limited else 0
    info[3] = limit_method
    info[7] = selection
    info[8:12] = struct.pack(">I", limit_count)
    info[13] = sign
    return bytes(info)


def criteria_blob(rules, *, match="all"):
    """`rules` are dicts describing one rule each, in the order iTunes writes
    them."""
    data = bytearray(CRITERIA_FIRST_RULE)
    data[15] = 1 if match == "any" else 0
    offset = CRITERIA_FIRST_RULE
    for rule in rules:
        block = bytearray(RULE_STRIDE)
        if rule["kind"] == "group":
            # A group says how many rules follow it and how they are joined.
            block[61:65] = struct.pack(">I", rule["count"])
            block[68] = 1 if rule.get("match", "all") == "any" else 0
            data[offset:offset + GROUP_LENGTH] = block[:GROUP_LENGTH]
            offset += GROUP_LENGTH
            continue
        block[0] = rule["field"]
        block[1] = rule.get("sign", 1 if rule["kind"] == "text" else 0)
        block[4] = rule.get("comparison", 0)
        if rule["kind"] == "text":
            encoded = rule["value"].encode("utf-16-be")
            block[53:53 + len(encoded)] = encoded
            # Two zero bytes stand for the character that ends the value.
            end = 53 + len(encoded)
            block[end:end + 2] = b"\x00\x00"
            # The value ends with a zero character, and the next rule starts
            # two bytes past its low byte.
            used = end + 3
        else:
            block[57:61] = struct.pack(">I", rule.get("intA", 0))
            block[81:85] = struct.pack(">I", rule.get("intB", 0))
            if rule.get("relative"):
                block[3] = 2
                inverted = struct.pack(">I", (rule["span"] - 1) % 2**32)
                block[65:69] = bytes(255 - byte for byte in inverted)
                block[73:77] = struct.pack(">I", rule["unit"])
            used = 57 + 67
        data[offset:offset + used] = block[:used]
        offset += used
    return bytes(data)


class TextRules(unittest.TestCase):
    def test_a_comment_rule_crosses_over_whole(self):
        blob = criteria_blob([
            {"kind": "text", "field": 0x0E, "comparison": 0x02, "value": "roadtrip"},
        ])
        rules, unsupported = parse_criteria(blob)
        match, conditions = rules["match"], rules["conditions"]
        self.assertEqual(match, "all")
        self.assertEqual(conditions, [
            {"field": "comment", "operator": "contains", "value": "roadtrip"},
        ])
        self.assertEqual(unsupported, [])

    def test_several_text_rules_in_a_row(self):
        blob = criteria_blob([
            {"kind": "text", "field": 0x04, "comparison": 0x01, "value": "Jethro Tull"},
            {"kind": "text", "field": 0x08, "comparison": 0x02, "value": "Rock"},
        ], match="any")
        rules, _ = parse_criteria(blob)
        match, conditions = rules["match"], rules["conditions"]
        self.assertEqual(match, "any")
        self.assertEqual([condition["field"] for condition in conditions], ["artist", "genre"])
        self.assertEqual(conditions[0]["value"], "Jethro Tull")

    def test_a_negative_text_rule_keeps_its_not(self):
        blob = criteria_blob([
            {"kind": "text", "field": 0x02, "comparison": 0x02, "sign": 3, "value": "live"},
        ])
        rules, _ = parse_criteria(blob)
        conditions = rules["conditions"]
        self.assertEqual(conditions[0]["operator"], "notContains")

    def test_accents_survive(self):
        blob = criteria_blob([
            {"kind": "text", "field": 0x04, "comparison": 0x01, "value": "Björk"},
        ])
        rules, _ = parse_criteria(blob)
        conditions = rules["conditions"]
        self.assertEqual(conditions[0]["value"], "Björk")


class NumberRules(unittest.TestCase):
    def test_stars_are_divided_back_down(self):
        # iTunes keeps four stars as eighty.
        blob = criteria_blob([
            {"kind": "int", "field": 0x19, "comparison": 0x10, "intA": 80},
        ])
        rules, _ = parse_criteria(blob)
        conditions = rules["conditions"]
        self.assertEqual(conditions, [{"field": "rating", "operator": "gt", "value": 4}])

    def test_a_range_becomes_one_between_rule(self):
        blob = criteria_blob([
            {"kind": "int", "field": 0x07, "comparison": 0x00, "intA": 1990, "intB": 1999},
        ])
        rules, _ = parse_criteria(blob)
        conditions = rules["conditions"]
        self.assertEqual(conditions[0], {
            "field": "year", "operator": "inTheRange", "value": "1990,1999",
        })

    def test_play_count_and_a_following_rule_both_read(self):
        blob = criteria_blob([
            {"kind": "int", "field": 0x16, "comparison": 0x10, "intA": 5},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Jazz"},
        ])
        rules, unsupported = parse_criteria(blob)
        conditions = rules["conditions"]
        self.assertEqual(unsupported, [])
        self.assertEqual(conditions, [
            {"field": "playcount", "operator": "gt", "value": 5},
            {"field": "genre", "operator": "is", "value": "Jazz"},
        ])


class DateRules(unittest.TestCase):
    def test_added_in_the_last_month(self):
        blob = criteria_blob([
            {"kind": "int", "field": 0x10, "relative": True, "span": 30, "unit": 86400},
        ])
        rules, _ = parse_criteria(blob)
        conditions = rules["conditions"]
        self.assertEqual(conditions, [
            {"field": "dateadded", "operator": "inTheLast", "value": 30},
        ])

    def test_weeks_are_turned_into_days(self):
        blob = criteria_blob([
            {"kind": "int", "field": 0x17, "relative": True, "span": 2, "unit": 604800},
        ])
        rules, _ = parse_criteria(blob)
        conditions = rules["conditions"]
        self.assertEqual(conditions[0]["value"], 14)

    def test_a_real_date_reads_as_a_day(self):
        # 2020-01-01 in iTunes seconds.
        itunes_seconds = 1577836800 + 2082844800
        blob = criteria_blob([
            {"kind": "int", "field": 0x10, "comparison": 0x10, "intA": itunes_seconds},
        ])
        rules, _ = parse_criteria(blob)
        conditions = rules["conditions"]
        self.assertEqual(conditions[0], {
            "field": "dateadded", "operator": "after", "value": "2020-01-01",
        })


class UnsupportedRules(unittest.TestCase):
    def test_a_field_navidrome_lacks_is_named_rather_than_guessed(self):
        blob = criteria_blob([
            {"kind": "text", "field": 0x12, "comparison": 0x02, "value": "Bach"},
        ])
        rules, unsupported = parse_criteria(blob)
        conditions = rules["conditions"]
        self.assertEqual(conditions, [])
        self.assertEqual(len(unsupported), 1)
        self.assertIn("Composer", unsupported[0])

    def test_an_unsupported_rule_does_not_swallow_the_next_one(self):
        blob = criteria_blob([
            {"kind": "text", "field": 0x12, "comparison": 0x02, "value": "Bach"},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Classical"},
        ])
        rules, unsupported = parse_criteria(blob)
        conditions = rules["conditions"]
        self.assertEqual(len(unsupported), 1)
        self.assertEqual(conditions, [
            {"field": "genre", "operator": "is", "value": "Classical"},
        ])

    def test_asking_for_something_that_is_not_music_is_reported(self):
        blob = criteria_blob([{"kind": "int", "field": 0x3C, "comparison": 0x01, "intA": 0x02}])
        _, unsupported = parse_criteria(blob)
        self.assertIn("films", unsupported[0])

    def test_the_wrapper_itunes_writes_on_every_music_playlist_falls_away(self):
        # The real shape: "(media kind is music, or is a music video) and
        # (what the person asked for)".
        blob = criteria_blob([
            {"kind": "group", "count": 2, "match": "any"},
            {"kind": "int", "field": 0x3C, "comparison": 0x01, "intA": 0x01},
            {"kind": "int", "field": 0x3C, "comparison": 0x01, "intA": 0x20},
            {"kind": "group", "count": 2, "match": "all"},
            {"kind": "text", "field": 0x0E, "comparison": 0x02, "value": "roadtrip"},
            {"kind": "int", "field": 0x19, "comparison": 0x10, "intA": 60},
        ])
        rules, unsupported = parse_criteria(blob)
        self.assertEqual(unsupported, [])
        self.assertTrue(is_flat(rules))
        self.assertEqual(rules["conditions"], [
            {"field": "comment", "operator": "contains", "value": "roadtrip"},
            {"field": "rating", "operator": "gt", "value": 3},
        ])

    def test_a_playlist_of_podcasts_is_reported_not_silently_turned_into_music(self):
        blob = criteria_blob([
            {"kind": "group", "count": 1, "match": "any"},
            {"kind": "int", "field": 0x3C, "comparison": 0x01, "intA": 0x04},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Talk"},
        ])
        _, unsupported = parse_criteria(blob)
        self.assertIn("podcasts", unsupported[0])

    def test_the_pair_itunes_writes_on_every_music_playlist_says_nothing(self):
        # "the media kind is music" and "it is not a music video", which is
        # what iTunes puts on all of them.
        blob = criteria_blob([
            {"kind": "int", "field": 0x3C, "comparison": 0x01, "intA": 0x01},
            {"kind": "int", "field": 0x3C, "comparison": 0x01, "sign": 2, "intA": 0x20},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Folk"},
        ])
        rules, unsupported = parse_criteria(blob)
        self.assertEqual(unsupported, [])
        self.assertEqual(rules["conditions"], [{"field": "genre", "operator": "is", "value": "Folk"}])

    def test_excluding_music_itself_is_reported(self):
        blob = criteria_blob([{"kind": "int", "field": 0x3C, "comparison": 0x01, "sign": 2, "intA": 0x01}])
        _, unsupported = parse_criteria(blob)
        self.assertEqual(len(unsupported), 1)


class Groups(unittest.TestCase):
    """iTunes wraps nearly every playlist the same way: a rule saying the media
    kind is music, then a group holding what the person actually asked for."""

    def test_the_usual_itunes_wrapping_falls_away(self):
        blob = criteria_blob([
            {"kind": "int", "field": 0x3C, "comparison": 0x01, "intA": 0x01},
            {"kind": "group", "count": 2, "match": "all"},
            {"kind": "text", "field": 0x0E, "comparison": 0x02, "value": "roadtrip"},
            {"kind": "int", "field": 0x19, "comparison": 0x10, "intA": 60},
        ])
        rules, unsupported = parse_criteria(blob)
        self.assertEqual(unsupported, [])
        self.assertTrue(is_flat(rules))
        self.assertEqual(rules["conditions"], [
            {"field": "comment", "operator": "contains", "value": "roadtrip"},
            {"field": "rating", "operator": "gt", "value": 3},
        ])

    def test_a_group_joined_the_other_way_is_kept(self):
        blob = criteria_blob([
            {"kind": "int", "field": 0x19, "comparison": 0x10, "intA": 60},
            {"kind": "group", "count": 2, "match": "any"},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Jazz"},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Blues"},
        ])
        rules, unsupported = parse_criteria(blob)
        self.assertEqual(unsupported, [])
        self.assertFalse(is_flat(rules), "the either-or has to stay a group")
        self.assertEqual(rules["match"], "all")
        self.assertEqual(rules["conditions"][0], {"field": "rating", "operator": "gt", "value": 3})
        self.assertEqual(rules["conditions"][1], {
            "match": "any",
            "conditions": [
                {"field": "genre", "operator": "is", "value": "Jazz"},
                {"field": "genre", "operator": "is", "value": "Blues"},
            ],
        })

    def test_a_group_holding_one_rule_is_not_worth_keeping(self):
        blob = criteria_blob([
            {"kind": "group", "count": 1, "match": "any"},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Folk"},
        ])
        rules, _ = parse_criteria(blob)
        self.assertTrue(is_flat(rules))
        self.assertEqual(rules["conditions"], [{"field": "genre", "operator": "is", "value": "Folk"}])

    def test_rules_after_a_group_belong_to_the_playlist_again(self):
        blob = criteria_blob([
            {"kind": "group", "count": 2, "match": "any"},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Jazz"},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Blues"},
            {"kind": "int", "field": 0x19, "comparison": 0x10, "intA": 80},
        ])
        rules, _ = parse_criteria(blob)
        self.assertEqual(rules["match"], "all")
        self.assertEqual(rules["conditions"][-1], {"field": "rating", "operator": "gt", "value": 4})
        self.assertEqual(rules["conditions"][0]["match"], "any")


class InfoBlock(unittest.TestCase):
    def test_a_limit_in_items_with_a_sort(self):
        details = parse_info(info_blob(limited=True, limit_count=25, selection=0x1C, sign=1))
        self.assertEqual(details["limitCount"], 25)
        self.assertEqual(details["limitUnit"], "items")
        self.assertEqual((details["sort"], details["order"]), ("rating", "desc"))

    def test_the_sign_byte_turns_most_into_least(self):
        details = parse_info(info_blob(limited=True, limit_count=10, selection=0x19, sign=0))
        self.assertEqual((details["sort"], details["order"]), ("playcount", "asc"))

    def test_random_has_no_order(self):
        details = parse_info(info_blob(selection=0x02))
        self.assertEqual(details["sort"], "random")
        self.assertIsNone(details["order"])


class WholePlaylists(unittest.TestCase):
    def test_rules_limit_and_sort_arrive_together(self):
        result = convert_smart_playlist(
            info_blob(limited=True, limit_count=25, selection=0x1C, sign=1),
            criteria_blob([
                {"kind": "text", "field": 0x0E, "comparison": 0x02, "value": "roadtrip"},
                {"kind": "int", "field": 0x19, "comparison": 0x10, "intA": 60},
            ]),
        )
        self.assertTrue(result["convertible"])
        self.assertTrue(result["liveUpdating"])
        self.assertEqual(result["rules"], {
            "match": "all",
            "conditions": [
                {"field": "comment", "operator": "contains", "value": "roadtrip"},
                {"field": "rating", "operator": "gt", "value": 3},
            ],
            "sort": "rating",
            "order": "desc",
            "limit": 25,
        })

    def test_an_unlimited_playlist_carries_no_sort(self):
        # iTunes keeps a selection method whether or not the playlist is
        # limited, and unlimited it means nothing. Navidrome would take it
        # literally and shuffle the whole list on every read.
        result = convert_smart_playlist(
            info_blob(limited=False, selection=0x02),
            criteria_blob([{"kind": "text", "field": 0x0E, "comparison": 0x02, "value": "Mellow"}]),
        )
        self.assertTrue(result["convertible"])
        self.assertIsNone(result["rules"]["limit"])
        self.assertEqual(result["rules"]["sort"], "")
        self.assertEqual(result["rules"]["order"], "asc")

    def test_a_limit_in_minutes_is_reported_not_invented(self):
        result = convert_smart_playlist(
            info_blob(limited=True, limit_method=0x01, limit_count=60),
            criteria_blob([{"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Jazz"}]),
        )
        self.assertFalse(result["convertible"])
        self.assertIsNone(result["rules"]["limit"])
        self.assertIn("minutes", result["unsupported"][0])
        # The rules themselves still came across, so it can be fixed by hand.
        self.assertEqual(len(result["rules"]["conditions"]), 1)

    def test_base64_text_is_accepted_as_well_as_bytes(self):
        import base64
        info = info_blob()
        criteria = criteria_blob([{"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Folk"}])
        result = convert_smart_playlist(
            base64.b64encode(info).decode(),
            base64.b64encode(criteria).decode(),
        )
        self.assertEqual(result["rules"]["conditions"][0]["value"], "Folk")


if __name__ == "__main__":
    unittest.main()
