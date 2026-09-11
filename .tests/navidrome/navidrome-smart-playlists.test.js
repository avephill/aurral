import assert from "node:assert/strict";
import test from "node:test";

import { importFromRepo } from "../helpers/backendTestHarness.js";

const {
  SmartPlaylistRuleError,
  describeSmartPlaylistFields,
  fromNavidromeRules,
  isSmartPlaylistRecord,
  toNavidromeRules,
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
    assert.ok(sortFields.includes(field.name), `${field.name} can be sorted by`);
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
