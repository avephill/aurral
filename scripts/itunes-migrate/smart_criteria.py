"""Reads the rules behind an iTunes smart playlist and states them as
Navidrome rules.

iTunes keeps a smart playlist's rules in two base64 blobs in the library XML,
"Smart Info" and "Smart Criteria". Nothing in the export says in words what the
playlist asks for, which is why a migration that only copies track lists turns
a living playlist into a snapshot of one day.

The layout below is the documented one, reverse engineered by others years ago
and stable since: fixed offsets into the two blobs, one record per rule, all
integers big-endian.

    Info blob
      0   live updating
      1   whether the rules below are used at all
      2   whether the playlist is limited
      3   how it is limited (items, minutes, MB, hours, GB)
      7   how tracks are chosen when limited
      8   the limit itself, four bytes
      13  whether that choice means most or least

    Criteria blob
      15  all (0) or any (1)
      139 the first rule; each rule is, counting from its own start:
          +0  which field
          +1  positive or negative
          +4  which comparison
          +54 the text value, every other byte, ending at a zero
          +57 the first number, four bytes; the second is 24 further on
          +65 for dates, the span, stored inverted
          +73 for dates, the seconds in one unit of that span

A text rule ends at its terminating zero and the next begins two bytes later.
A number or date rule is a fixed 67 bytes from the first number. A rule whose
field is zero opens a group: it says how many rules belong to it and whether
they are joined by and or or, and those rules follow it.

iTunes writes nearly every smart playlist the same way: a rule saying the
media kind is music, and a group holding what the person actually asked for.
Navidrome holds only music, so that rule is dropped, and a group whose join
matches its parent's is flattened into it. What is left is usually a plain
list of rules, which is what the editor in Aurral can show.
"""

import base64
import struct
from datetime import datetime, timezone

# Offsets, as described above.
INFO_LIVE_UPDATE = 0
INFO_MATCH_RULES = 1
INFO_LIMIT_ON = 2
INFO_LIMIT_METHOD = 3
INFO_SELECTION_METHOD = 7
INFO_LIMIT_COUNT = 8
INFO_SELECTION_SIGN = 13

CRITERIA_LOGIC_TYPE = 15
CRITERIA_FIRST_RULE = 139
RULE_SIGN = 1
RULE_COMPARISON = 4
RULE_TEXT = 54
RULE_INT_A = 57
RULE_INT_B = 24  # from the first number, not from the rule
RULE_TIME_VALUE = 65
RULE_TIME_UNIT = 73
RULE_INT_LENGTH = 67  # from the first number to the next rule
GROUP_LENGTH = 192

# iTunes counts seconds from 1904; Unix counts from 1970.
ITUNES_EPOCH_OFFSET = -2082844800

SIGN_INT_POSITIVE = 0x00
SIGN_STRING_POSITIVE = 0x01

COMPARE_OTHER = 0x00
COMPARE_IS = 0x01
COMPARE_CONTAINS = 0x02
COMPARE_STARTS = 0x04
COMPARE_ENDS = 0x08
COMPARE_GREATER = 0x10
COMPARE_LESS = 0x40

# iTunes field code to the Navidrome field it becomes. Anything absent is
# reported as unsupported rather than guessed at.
TEXT_FIELDS = {
    0x02: "title",
    0x03: "album",
    0x04: "artist",
    0x47: "albumartist",
    0x08: "genre",
    0x0E: "comment",
    0x09: "filetype",
}
TEXT_FIELDS_UNSUPPORTED = {
    0x12: "Composer",
    0x27: "Grouping",
    0x37: "Category",
    0x36: "Description",
    0x3E: "Show",
    0x4E: "Sort Name",
    0x4F: "Sort Album",
    0x51: "Sort Album Artist",
    0x52: "Sort Composer",
    0x53: "Sort Show",
    0x59: "Video Rating",
}

NUMBER_FIELDS = {
    0x07: "year",
    0x19: "rating",
    0x16: "playcount",
    0x05: "bitrate",
    0x23: "bpm",
    0x0D: "duration",
    0x1F: "compilation",
}
NUMBER_FIELDS_UNSUPPORTED = {
    0x0C: "Size",
    0x0B: "Track Number",
    0x18: "Disc Number",
    0x06: "Sample Rate",
    0x3F: "Season",
    0x44: "Skips",
    0x39: "Podcast",
}

DATE_FIELDS = {
    0x10: "dateadded",
    0x0A: "datemodified",
    0x17: "lastplayed",
}
DATE_FIELDS_UNSUPPORTED = {0x45: "Last Skipped"}

MEDIA_KIND_FIELD = 0x3C
# The media kinds that mean "music". A Navidrome library holds nothing else,
# so a rule asking for one of these says nothing and is dropped.
MEDIA_KINDS_MUSIC = {0x01, 0x1021B1}

GROUP_COUNT = 61      # how many rules belong to a group - relative to its start
GROUP_LOGIC = 68      # whether they are joined by and or or - relative to its start

BOOLEAN_FIELDS = {0x9A: "loved"}
BOOLEAN_FIELDS_UNSUPPORTED = {
    0x25: "Has Artwork",
    0x29: "Purchased",
    0x1D: "Checked",
    0x28: "Playlist",
    0x86: "iCloud Status",
    0x85: "Location",
}

# How iTunes chooses tracks for a limited playlist, and the Navidrome sort that
# says the same thing. The second item is the order when iTunes means "most".
SELECTION_METHODS = {
    0x02: ("random", None),
    0x05: ("title", "asc"),
    0x06: ("album", "asc"),
    0x07: ("artist", "asc"),
    0x09: ("genre", "asc"),
    0x1C: ("rating", "desc"),
    0x01: ("rating", "asc"),
    0x1A: ("lastplayed", "desc"),
    0x19: ("playcount", "desc"),
    0x15: ("dateadded", "desc"),
}

LIMIT_METHODS = {0x01: "minutes", 0x02: "MB", 0x03: "items", 0x04: "hours", 0x05: "GB"}


class SmartCriteriaError(Exception):
    """The blobs are not a shape this reader understands."""


def _uint32(data, offset):
    return struct.unpack(">I", data[offset:offset + 4])[0]


def _itunes_date(value):
    """An iTunes timestamp as a plain date. Navidrome compares by day."""
    seconds = value + ITUNES_EPOCH_OFFSET
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%d")


def _read_text(criteria, start):
    """The text of a rule, and where the next rule begins.

    Characters are two bytes each and the value ends at a zero, so the readable
    half sits on every other byte from the offset given.
    """
    end = start
    while end < len(criteria):
        if criteria[end] == 0 and end != len(criteria) - 1:
            break
        end += 2
    raw = criteria[start - 1:end - 1]
    try:
        text = raw.decode("utf-16-be")
    except UnicodeDecodeError:
        text = bytes(raw[1::2]).decode("latin-1")
    return text.strip("\x00"), end + 2


def parse_info(info):
    """The limit, the sort and whether the rules are used at all."""
    if len(info) < 16:
        raise SmartCriteriaError("Smart Info is too short to read")
    limited = info[INFO_LIMIT_ON] == 1
    method = LIMIT_METHODS.get(info[INFO_LIMIT_METHOD])
    sort, most_order = SELECTION_METHODS.get(info[INFO_SELECTION_METHOD], (None, None))
    # The sign byte flips "most played" into "least played" and so on.
    order = most_order
    if order and info[INFO_SELECTION_SIGN] == 0:
        order = "asc" if most_order == "desc" else "desc"
    return {
        "liveUpdating": info[INFO_LIVE_UPDATE] == 1,
        "usesRules": info[INFO_MATCH_RULES] == 1,
        "limited": limited,
        "limitCount": _uint32(info, INFO_LIMIT_COUNT) if limited else None,
        "limitUnit": method if limited else None,
        "sort": sort,
        "order": order,
    }


def _simplify(node):
    """Fold away the scaffolding iTunes writes around every playlist.

    A group holding one rule, or joined the same way as the group above it,
    says nothing extra, so its rules move up. An empty group disappears.
    """
    conditions = []
    for child in node["conditions"]:
        if "match" not in child:
            conditions.append(child)
            continue
        child = _simplify(child)
        if not child["conditions"]:
            continue
        if len(child["conditions"]) == 1 or child["match"] == node["match"]:
            conditions.extend(child["conditions"])
            continue
        conditions.append(child)
    return {"match": node["match"], "conditions": conditions}


def is_flat(rules):
    """True when every rule stands on its own, which is what the editor shows."""
    return all("match" not in condition for condition in rules.get("conditions", []))


def parse_criteria(criteria):
    """Every rule in the blob, as Navidrome would put them.

    Returns (rules, unsupported): rules is {"match", "conditions"}, where a
    condition is either a rule or another such group; unsupported is a list of
    plain sentences about anything that could not cross over.
    """
    if len(criteria) <= CRITERIA_FIRST_RULE:
        raise SmartCriteriaError("Smart Criteria is too short to read")

    root = {"match": "any" if criteria[CRITERIA_LOGIC_TYPE] == 1 else "all", "conditions": []}
    # Each open group, with how many of its rules are still to come. The root
    # runs to the end of the blob, so it counts nothing.
    stack = [{"node": root, "remaining": None}]
    unsupported = []
    offset = CRITERIA_FIRST_RULE

    def member_read():
        """One rule of the innermost group has been read. A group that is now
        complete is itself a rule of the group above it."""
        while len(stack) > 1 and stack[-1]["remaining"] is not None:
            stack[-1]["remaining"] -= 1
            if stack[-1]["remaining"] > 0:
                return
            stack.pop()

    def add(condition):
        stack[-1]["node"]["conditions"].append(condition)
        member_read()

    # A rule needs its header and, unless it is text, its numbers; anything
    # shorter than that at the end of the blob is padding.
    while offset + RULE_INT_A + 4 <= len(criteria):
        field = criteria[offset]
        sign = criteria[offset + RULE_SIGN]
        comparison = criteria[offset + RULE_COMPARISON]
        int_a_at = offset + RULE_INT_A
        negative = sign not in (SIGN_INT_POSITIVE, SIGN_STRING_POSITIVE)

        if field == 0:
            count = _uint32(criteria, offset + GROUP_COUNT)
            group = {
                "match": "any" if criteria[offset + GROUP_LOGIC] == 1 else "all",
                "conditions": [],
            }
            stack[-1]["node"]["conditions"].append(group)
            if count > 0:
                stack.append({"node": group, "remaining": count})
            else:
                member_read()
            offset += GROUP_LENGTH
            continue

        if field == MEDIA_KIND_FIELD:
            kind = _uint32(criteria, int_a_at)
            if kind not in MEDIA_KINDS_MUSIC:
                unsupported.append("a rule about something other than music")
            # Either way the slot is used up.
            member_read()
            offset = int_a_at + RULE_INT_LENGTH
            continue

        if field in TEXT_FIELDS:
            value, offset = _read_text(criteria, offset + RULE_TEXT)
            name = TEXT_FIELDS[field]
            operator = {
                COMPARE_IS: "isNot" if negative else "is",
                COMPARE_CONTAINS: "notContains" if negative else "contains",
                COMPARE_STARTS: "startsWith",
                COMPARE_ENDS: "endsWith",
            }.get(comparison)
            if operator:
                add({"field": name, "operator": operator, "value": value})
            else:
                unsupported.append(f"{name} with a comparison this reader does not know")
                member_read()
            continue

        if field in NUMBER_FIELDS:
            name = NUMBER_FIELDS[field]
            number_a = _uint32(criteria, int_a_at)
            number_b = _uint32(criteria, int_a_at + RULE_INT_B)
            if name == "rating":
                # iTunes keeps five stars as a hundred.
                number_a //= 20
                number_b //= 20
            if comparison == COMPARE_IS:
                add({"field": name, "operator": "isNot" if negative else "is", "value": number_a})
            elif comparison == COMPARE_GREATER:
                add({"field": name, "operator": "gt", "value": number_a})
            elif comparison == COMPARE_LESS:
                add({"field": name, "operator": "lt", "value": number_a})
            elif comparison == COMPARE_OTHER:
                add({"field": name, "operator": "inTheRange", "value": f"{number_a},{number_b}"})
            else:
                unsupported.append(f"{name} with a comparison this reader does not know")
                member_read()
            offset = int_a_at + RULE_INT_LENGTH
            continue

        if field in DATE_FIELDS:
            name = DATE_FIELDS[field]
            # A relative span, "in the last two weeks", is flagged by the byte
            # two past the sign; otherwise the rule holds real dates.
            if criteria[offset + RULE_SIGN + 2] == 2:
                inverted = criteria[offset + RULE_TIME_VALUE:offset + RULE_TIME_VALUE + 4]
                span = (struct.unpack(">I", bytes(255 - byte for byte in inverted))[0] + 1) % 2**32
                unit_seconds = _uint32(criteria, offset + RULE_TIME_UNIT)
                days = max(1, round(span * unit_seconds / 86400))
                add({
                    "field": name,
                    "operator": "notInTheLast" if negative else "inTheLast",
                    "value": days,
                })
            else:
                date_a = _itunes_date(_uint32(criteria, int_a_at))
                date_b = _itunes_date(_uint32(criteria, int_a_at + RULE_INT_B))
                if comparison == COMPARE_GREATER:
                    add({"field": name, "operator": "after", "value": date_a})
                elif comparison == COMPARE_LESS:
                    add({"field": name, "operator": "before", "value": date_a})
                elif comparison in (COMPARE_IS, COMPARE_OTHER):
                    add({"field": name, "operator": "inTheRange", "value": f"{date_a},{date_b}"})
                else:
                    unsupported.append(f"{name} with a comparison this reader does not know")
                    member_read()
            offset = int_a_at + RULE_INT_LENGTH
            continue

        if field in BOOLEAN_FIELDS:
            add({
                "field": BOOLEAN_FIELDS[field],
                "operator": "is",
                "value": _uint32(criteria, int_a_at) == 1,
            })
            offset = int_a_at + RULE_INT_LENGTH
            continue

        label = (
            TEXT_FIELDS_UNSUPPORTED.get(field)
            or NUMBER_FIELDS_UNSUPPORTED.get(field)
            or DATE_FIELDS_UNSUPPORTED.get(field)
            or BOOLEAN_FIELDS_UNSUPPORTED.get(field)
        )
        unsupported.append(
            f"{label}, which Navidrome has no rule for" if label
            else f"an iTunes field this reader does not know (code {field:#04x})"
        )
        member_read()
        # Text fields end at their value; everything else is a fixed length. An
        # unknown field is assumed to be the latter, which is the common case.
        if field in TEXT_FIELDS_UNSUPPORTED:
            _, offset = _read_text(criteria, offset + RULE_TEXT)
        else:
            offset = int_a_at + RULE_INT_LENGTH

    rules = _simplify(root)
    # A playlist whose rules all sit in one group reads better without it.
    while len(rules["conditions"]) == 1 and "match" in rules["conditions"][0]:
        rules = rules["conditions"][0]
    return rules, unsupported


def convert_smart_playlist(info_blob, criteria_blob):
    """Both blobs to one answer: the rules Aurral would save, and what did not
    come across.

    `info_blob` and `criteria_blob` are the raw bytes from the library XML, or
    the base64 text of them.
    """
    info = base64.b64decode(info_blob) if isinstance(info_blob, str) else bytes(info_blob)
    criteria = base64.b64decode(criteria_blob) if isinstance(criteria_blob, str) else bytes(criteria_blob)

    details = parse_info(info)
    parsed, unsupported = parse_criteria(criteria)

    if not details["usesRules"]:
        unsupported.append("the playlist takes everything, with no rules to match")

    limit = None
    if details["limited"]:
        if details["limitUnit"] == "items":
            limit = details["limitCount"]
        else:
            unsupported.append(
                f"a limit measured in {details['limitUnit']}, which Navidrome cannot express"
            )

    rules = {
        "match": parsed["match"],
        "conditions": parsed["conditions"],
        "sort": details["sort"] or "",
        "order": details["order"] or "asc",
        "limit": limit,
    }
    return {
        "rules": rules,
        "unsupported": unsupported,
        "liveUpdating": details["liveUpdating"],
        "convertible": bool(parsed["conditions"]) and not unsupported,
        # Navidrome can hold a group inside a group; Aurral's editor shows
        # only a plain list, so a playlist that keeps one is applied but
        # cannot be opened there.
        "editable": is_flat(rules),
    }
