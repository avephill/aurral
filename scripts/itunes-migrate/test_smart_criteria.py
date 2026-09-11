"""Tests for the smart playlist reader.

The blobs here are built byte by byte to the layout documented in
smart_criteria.py, so the test says what iTunes writes and the reader has to
agree with it. Run with: python3 -m unittest test_smart_criteria
"""

import struct
import unittest

from smart_criteria import (
    CRITERIA_FIRST_RULE,
    convert_smart_playlist,
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
        match, conditions, unsupported = parse_criteria(blob)
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
        match, conditions, _ = parse_criteria(blob)
        self.assertEqual(match, "any")
        self.assertEqual([condition["field"] for condition in conditions], ["artist", "genre"])
        self.assertEqual(conditions[0]["value"], "Jethro Tull")

    def test_a_negative_text_rule_keeps_its_not(self):
        blob = criteria_blob([
            {"kind": "text", "field": 0x02, "comparison": 0x02, "sign": 3, "value": "live"},
        ])
        _, conditions, _ = parse_criteria(blob)
        self.assertEqual(conditions[0]["operator"], "notContains")

    def test_accents_survive(self):
        blob = criteria_blob([
            {"kind": "text", "field": 0x04, "comparison": 0x01, "value": "Björk"},
        ])
        _, conditions, _ = parse_criteria(blob)
        self.assertEqual(conditions[0]["value"], "Björk")


class NumberRules(unittest.TestCase):
    def test_stars_are_divided_back_down(self):
        # iTunes keeps four stars as eighty.
        blob = criteria_blob([
            {"kind": "int", "field": 0x19, "comparison": 0x10, "intA": 80},
        ])
        _, conditions, _ = parse_criteria(blob)
        self.assertEqual(conditions, [{"field": "rating", "operator": "gt", "value": 4}])

    def test_a_range_becomes_one_between_rule(self):
        blob = criteria_blob([
            {"kind": "int", "field": 0x07, "comparison": 0x00, "intA": 1990, "intB": 1999},
        ])
        _, conditions, _ = parse_criteria(blob)
        self.assertEqual(conditions[0], {
            "field": "year", "operator": "inTheRange", "value": "1990,1999",
        })

    def test_play_count_and_a_following_rule_both_read(self):
        blob = criteria_blob([
            {"kind": "int", "field": 0x16, "comparison": 0x10, "intA": 5},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Jazz"},
        ])
        _, conditions, unsupported = parse_criteria(blob)
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
        _, conditions, _ = parse_criteria(blob)
        self.assertEqual(conditions, [
            {"field": "dateadded", "operator": "inTheLast", "value": 30},
        ])

    def test_weeks_are_turned_into_days(self):
        blob = criteria_blob([
            {"kind": "int", "field": 0x17, "relative": True, "span": 2, "unit": 604800},
        ])
        _, conditions, _ = parse_criteria(blob)
        self.assertEqual(conditions[0]["value"], 14)

    def test_a_real_date_reads_as_a_day(self):
        # 2020-01-01 in iTunes seconds.
        itunes_seconds = 1577836800 + 2082844800
        blob = criteria_blob([
            {"kind": "int", "field": 0x10, "comparison": 0x10, "intA": itunes_seconds},
        ])
        _, conditions, _ = parse_criteria(blob)
        self.assertEqual(conditions[0], {
            "field": "dateadded", "operator": "after", "value": "2020-01-01",
        })


class UnsupportedRules(unittest.TestCase):
    def test_a_field_navidrome_lacks_is_named_rather_than_guessed(self):
        blob = criteria_blob([
            {"kind": "text", "field": 0x12, "comparison": 0x02, "value": "Bach"},
        ])
        _, conditions, unsupported = parse_criteria(blob)
        self.assertEqual(conditions, [])
        self.assertEqual(len(unsupported), 1)
        self.assertIn("Composer", unsupported[0])

    def test_an_unsupported_rule_does_not_swallow_the_next_one(self):
        blob = criteria_blob([
            {"kind": "text", "field": 0x12, "comparison": 0x02, "value": "Bach"},
            {"kind": "text", "field": 0x08, "comparison": 0x01, "value": "Classical"},
        ])
        _, conditions, unsupported = parse_criteria(blob)
        self.assertEqual(len(unsupported), 1)
        self.assertEqual(conditions, [
            {"field": "genre", "operator": "is", "value": "Classical"},
        ])

    def test_a_nested_group_is_reported(self):
        blob = criteria_blob([{"kind": "int", "field": 0x00}])
        _, _, unsupported = parse_criteria(blob)
        self.assertIn("nested group", unsupported[0])


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
