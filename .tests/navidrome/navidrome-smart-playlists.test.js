import assert from "node:assert/strict";
import test from "node:test";

import { importFromRepo } from "../helpers/backendTestHarness.js";

const {
  SmartPlaylistRuleError,
  describeSmartPlaylistFields,
  editorRulesFromPsalter,
  fromNavidromeRules,
  isSmartPlaylistRecord,
  toNavidromeRules,
  toPsalterRules,
  usesTagRule,
} = await importFromRepo("backend/services/navidromeSmartPlaylists.js");

test("an editor's rules become the shape Navidrome evaluates", () => {
  const rules = toNavidromeRules({
    match: "all",
    conditions: [
      { field: "comment", operator: "contains", value: "roadtrip" },
      { field: "rating", operator: "gt", value: "3" },
    ],
    sort: "rating",
    order: "desc",
    limit: 50,
  });

  assert.deepEqual(rules, {
    all: [
      { contains: { comment: "roadtrip" } },
      { gt: { rating: 3 } },
    ],
    sort: "rating",
    order: "desc",
    limit: 50,
  });
});

test("any-of rules, dates and yes-or-no values all survive the crossing", () => {
  const rules = toNavidromeRules({
    match: "any",
    conditions: [
      { field: "loved", operator: "is", value: "yes" },
      { field: "dateadded", operator: "inTheLast", value: "30" },
      { field: "lastplayed", operator: "before", value: "2026-01-31" },
      { field: "year", operator: "inTheRange", value: "1990,1999" },
    ],
  });

  assert.deepEqual(rules.any, [
    { is: { loved: true } },
    { inTheLast: { dateadded: 30 } },
    { before: { lastplayed: "2026-01-31" } },
    { inTheRange: { year: [1990, 1999] } },
  ]);
  assert.equal(rules.sort, undefined, "no sort asked for, none sent");
});

test("a random pick is sent without an order, which Navidrome has no use for", () => {
  const rules = toNavidromeRules({
    match: "all",
    conditions: [{ field: "genre", operator: "is", value: "Jazz" }],
    sort: "random",
    order: "desc",
    limit: 25,
  });
  assert.equal(rules.sort, "random");
  assert.equal(rules.order, undefined);
});

test("a field Navidrome does not know is refused rather than passed on", () => {
  // Navidrome answers an unknown field with an empty playlist and no error,
  // so a typo would otherwise look like a rule that simply matches nothing.
  assert.throws(
    () => toNavidromeRules({ match: "all", conditions: [{ field: "mood", operator: "is", value: "happy" }] }),
    (error) => error instanceof SmartPlaylistRuleError && /Unknown field/.test(error.message),
  );
});

test("an operator that makes no sense for the field is refused", () => {
  assert.throws(
    () => toNavidromeRules({ match: "all", conditions: [{ field: "rating", operator: "startsWith", value: "3" }] }),
    (error) => error instanceof SmartPlaylistRuleError && /cannot be asked/.test(error.message),
  );
});

test("bad values are refused with a message a person can act on", () => {
  const cases = [
    [{ field: "rating", operator: "gt", value: "high" }, /takes a number/],
    [{ field: "dateadded", operator: "after", value: "last tuesday" }, /takes a date/],
    [{ field: "title", operator: "contains", value: "   " }, /needs a value/],
    [{ field: "year", operator: "inTheRange", value: "1990" }, /needs two values/],
    [{ field: "loved", operator: "is", value: "sort of" }, /yes or no/],
  ];
  for (const [condition, message] of cases) {
    assert.throws(
      () => toNavidromeRules({ match: "all", conditions: [condition] }),
      (error) => message.test(error.message),
      `expected ${condition.field} to be refused`,
    );
  }
});

test("empty rules and silly limits are refused", () => {
  assert.throws(() => toNavidromeRules({ match: "all", conditions: [] }), /at least one rule/);
  assert.throws(() => toNavidromeRules({ match: "sometimes", conditions: [] }), /all or any/);
  assert.throws(
    () => toNavidromeRules({
      match: "all",
      conditions: [{ field: "title", operator: "contains", value: "a" }],
      limit: 999999,
    }),
    /Limit must be/,
  );
});

test("rules read back from Navidrome open in the editor unchanged", () => {
  const original = {
    match: "all",
    conditions: [
      { field: "comment", operator: "contains", value: "roadtrip" },
      { field: "year", operator: "inTheRange", value: "1990,1999" },
    ],
    sort: "title",
    order: "asc",
    limit: 100,
  };
  const roundTripped = fromNavidromeRules(toNavidromeRules(original));
  assert.deepEqual(roundTripped, original);
});

test("rules this editor cannot show come back as null rather than being rewritten", () => {
  // A nested group is valid in Navidrome and not offered here.
  assert.equal(fromNavidromeRules({ all: [{ any: [{ is: { genre: "Rock" } }] }] }), null);
  assert.equal(fromNavidromeRules({ all: [{ is: { somethingelse: 1 } }] }), null);
  assert.equal(fromNavidromeRules(null), null);
  assert.equal(fromNavidromeRules({ limit: 10 }), null);
});

test("a playlist counts as smart only when it carries rules", () => {
  assert.equal(isSmartPlaylistRecord({ rules: { all: [] } }), true);
  assert.equal(isSmartPlaylistRecord({ rules: { any: [] } }), true);
  assert.equal(isSmartPlaylistRecord({ rules: null }), false);
  assert.equal(isSmartPlaylistRecord({}), false);
  assert.equal(isSmartPlaylistRecord(null), false);
});

test("the catalogue offers an operator set for every field it lists", () => {
  const { fields, sortFields } = describeSmartPlaylistFields();
  assert.ok(fields.length > 15);
  for (const field of fields) {
    assert.ok(field.operators.length, `${field.name} has operators`);
    for (const operator of field.operators) assert.ok(operator.label, `${operator.name} has a label`);
    // A tag is had or not had; there is nothing to sort by.
    if (field.type !== "tag") assert.ok(sortFields.includes(field.name), `${field.name} can be sorted by`);
  }
  assert.ok(sortFields.includes("random"));
});

test("a group of rules crosses over whole, the way iTunes wrote it", () => {
  // "rated above three, and either jazz or blues"
  const rules = toNavidromeRules({
    match: "all",
    conditions: [
      { field: "rating", operator: "gt", value: 3 },
      {
        match: "any",
        conditions: [
          { field: "genre", operator: "is", value: "Jazz" },
          { field: "genre", operator: "is", value: "Blues" },
        ],
      },
    ],
  });

  assert.deepEqual(rules, {
    all: [
      { gt: { rating: 3 } },
      { any: [{ is: { genre: "Jazz" } }, { is: { genre: "Blues" } }] },
    ],
  });
});

test("a bad rule inside a group is refused like any other", () => {
  assert.throws(
    () => toNavidromeRules({
      match: "all",
      conditions: [{ match: "any", conditions: [{ field: "mood", operator: "is", value: "up" }] }],
    }),
    /Unknown field/,
  );
  assert.throws(
    () => toNavidromeRules({ match: "all", conditions: [{ match: "any", conditions: [] }] }),
    /group needs at least one rule/,
  );
});

test("rules nested past all reason are refused rather than sent", () => {
  let nested = { field: "title", operator: "contains", value: "a" };
  for (let depth = 0; depth < 6; depth += 1) nested = { match: "all", conditions: [nested] };
  assert.throws(() => toNavidromeRules({ match: "all", conditions: [nested] }), /nested too deeply/);
});

test("a playlist that keeps a group cannot be opened in the editor", () => {
  const withGroup = toNavidromeRules({
    match: "all",
    conditions: [
      { field: "rating", operator: "gt", value: 3 },
      { match: "any", conditions: [{ field: "genre", operator: "is", value: "Jazz" }, { field: "genre", operator: "is", value: "Blues" }] },
    ],
  });
  assert.equal(fromNavidromeRules(withGroup), null, "the editor says so rather than flattening it");
});

// A rule about one of the person's tags. Navidrome cannot read those, so a
// playlist with one is Psalter's to keep, over the fields Psalter can judge.

test("the editor is offered a tag rule, and told what can go with it", () => {
  const { fields, keptByPsalter } = describeSmartPlaylistFields();
  const tag = fields.find((field) => field.name === "tag");
  assert.equal(tag.type, "tag");
  assert.deepEqual(tag.operators.map((operator) => operator.name), ["has", "hasNot"]);
  assert.ok(keptByPsalter.fields.includes("tag") && keptByPsalter.fields.includes("rating"));
  assert.ok(!keptByPsalter.fields.includes("bpm"), "only what Psalter can judge");
});

test("a tag rule makes the playlist Psalter's, and Navidrome never sees one", () => {
  const rules = {
    match: "all",
    conditions: [
      { field: "tag", operator: "has", value: " Sunday " },
      { field: "rating", operator: "gt", value: "3" },
    ],
    sort: "rating",
    order: "desc",
    limit: "25",
  };
  assert.equal(usesTagRule(rules), true);
  assert.equal(usesTagRule({ conditions: [{ field: "rating", operator: "gt", value: 3 }] }), false);
  assert.deepEqual(toPsalterRules(rules), {
    match: "all",
    conditions: [
      { field: "tag", operator: "has", value: "sunday" },
      { field: "rating", operator: "gt", value: 3 },
    ],
    sort: "rating",
    order: "desc",
    limit: 25,
  });
  assert.throws(() => toNavidromeRules(rules), /Unknown field: tag/);
});

test("a tag rule refuses what Psalter cannot judge, with a reason", () => {
  assert.throws(
    () => toPsalterRules({ conditions: [{ field: "tag", operator: "has", value: "x" }, { field: "bpm", operator: "gt", value: 100 }] }),
    (error) => error instanceof SmartPlaylistRuleError && /Beats per minute cannot be used with a tag rule/.test(error.message),
  );
  assert.throws(() => toPsalterRules({ conditions: [{ field: "tag", operator: "contains", value: "x" }] }), /Tag cannot be asked/);
  assert.throws(() => toPsalterRules({ conditions: [{ field: "tag", operator: "has", value: " " }] }), /Tag needs a value/);
  assert.throws(() => toPsalterRules({ conditions: [{ field: "tag", operator: "has", value: "x" }], sort: "random" }), /Cannot sort by random/);
});

test("kept rules open in the editor, unless they hold a group it cannot show", () => {
  const rules = { match: "any", conditions: [{ field: "tag", operator: "has", value: "sunday" }, { field: "year", operator: "inTheRange", value: [1970, 1979] }], limit: 10 };
  assert.deepEqual(editorRulesFromPsalter(rules), {
    match: "any",
    conditions: [
      { field: "tag", operator: "has", value: "sunday" },
      { field: "year", operator: "inTheRange", value: "1970,1979" },
    ],
    sort: "",
    order: "asc",
    limit: 10,
  });
  assert.equal(editorRulesFromPsalter({ match: "all", conditions: [{ match: "any", conditions: [] }] }), null);
  // The converted iTunes playlists read "comment"; the editor does not offer it with a tag rule.
  assert.equal(editorRulesFromPsalter({ match: "all", conditions: [{ field: "comment", operator: "contains", value: "x" }] }), null);
});
