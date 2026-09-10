import test from "node:test";
import assert from "node:assert/strict";

import { searchLocalFromData } from "../../backend/services/unifiedSearchService.js";

const artists = [
  { name: "JPEGMAFIA", mbid: "11111111-1111-4111-8111-111111111111" },
  { name: "Show Me the Body", mbid: "22222222-2222-4222-8222-222222222222" },
  { name: "Mafia Mike", mbid: "33333333-3333-4333-8333-333333333333" },
];

test("a spaced query still finds a run-together library artist name", () => {
  const { artists: found } = searchLocalFromData("jpeg mafia", { artists }, 5);
  assert.deepEqual(found.map((artist) => artist.name), ["JPEGMAFIA"]);
});

test("a run-together query still finds a spaced library artist name", () => {
  const { artists: found } = searchLocalFromData("showmethebody", { artists }, 5);
  assert.deepEqual(found.map((artist) => artist.name), ["Show Me the Body"]);
});

test("exact and contained matches still rank above squashed ones", () => {
  const { artists: found } = searchLocalFromData("mafia", { artists }, 5);
  assert.deepEqual(found.map((artist) => artist.name), ["Mafia Mike", "JPEGMAFIA"]);
});

test("very short queries do not match through squashing", () => {
  const { artists: found } = searchLocalFromData("ma fi", { artists }, 5);
  // "mafi" squashed would be inside both names; the spaced form matches nothing,
  // and a four-letter squash is allowed, so both come back.
  assert.equal(found.length, 2);
  const { artists: none } = searchLocalFromData("j p", { artists }, 5);
  assert.equal(none.length, 0);
});
