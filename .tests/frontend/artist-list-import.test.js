import test from "node:test";
import assert from "node:assert/strict";

import {
  matchArtistList,
  normalizeArtistName,
  parseArtistList,
} from "../../frontend/src/utils/artistListImport.js";

const CATALOG = [
  { mbid: "beatles", artistName: "The Beatles", sortName: "Beatles, The", inLibrary: false },
  { mbid: "sigur", artistName: "Sigur Rós", sortName: "Sigur Rós", inLibrary: true },
  { mbid: "radiohead", artistName: "Radiohead", sortName: "Radiohead", inLibrary: false },
  { mbid: "fleetwood", artistName: "Fleetwood Mac", sortName: "Fleetwood Mac", inLibrary: false },
  { mbid: "nirvana", artistName: "Nirvana", sortName: "Nirvana", inLibrary: false },
  { mbid: "nirvana-uk", artistName: "Nirvana", sortName: "Nirvana", inLibrary: false },
];

test("normalizeArtistName folds accents, ampersands and punctuation", () => {
  assert.equal(normalizeArtistName("Sigur Rós"), "sigur ros");
  assert.equal(normalizeArtistName("Mötley Crüe"), "motley crue");
  assert.equal(normalizeArtistName("Sløtface"), "slotface");
  assert.equal(normalizeArtistName("Earth, Wind & Fire"), "earth wind and fire");
});

test("parseArtistList strips list decoration, headings and extra columns", () => {
  const entries = parseArtistList(
    [
      "Artist",
      "1. Radiohead",
      "- Nirvana",
      "## Favourites",
      '"Fleetwood Mac"',
      "",
      "Sigur Ros\t1998\trock",
    ].join("\n"),
  );
  assert.deepEqual(
    entries.map((entry) => entry.input),
    ["Radiohead", "Nirvana", "Fleetwood Mac", "Sigur Ros"],
  );
});

test("parseArtistList collapses repeats of the same artist into one row", () => {
  const entries = parseArtistList("beatles\nThe Beatles\nBEATLES");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].occurrences, 3);
});

test("matchArtistList separates exact matches, near misses and misses", () => {
  const rows = matchArtistList(
    ["the beatles", "Fleetwod Mac", "Radio Head", "Some Band Nobody Has"].join("\n"),
    CATALOG,
  );
  const byInput = new Map(rows.map((row) => [row.input, row]));

  const exact = byInput.get("the beatles");
  assert.equal(exact.status, "exact");
  assert.equal(exact.selected, "beatles");

  // A single typo is confident enough to preselect.
  const typo = byInput.get("Fleetwod Mac");
  assert.equal(typo.status, "close");
  assert.equal(typo.selected, "fleetwood");

  // A split word is close enough to suggest but wants a human look first.
  const spaced = byInput.get("Radio Head");
  assert.equal(spaced.status, "close");
  assert.equal(spaced.candidates[0].mbid, "radiohead");

  const missing = byInput.get("Some Band Nobody Has");
  assert.equal(missing.status, "none");
  assert.equal(missing.selected, "");
  assert.deepEqual(missing.candidates, []);
});

test("matchArtistList flags a name two catalog artists share", () => {
  const [row] = matchArtistList("Nirvana", CATALOG);
  assert.equal(row.status, "ambiguous");
  assert.equal(row.candidates.length, 2);
});

test("matchArtistList reports matches already in the user's library", () => {
  const [row] = matchArtistList("Sigur Ros", CATALOG);
  assert.equal(row.status, "exact");
  assert.equal(row.candidates[0].inLibrary, true);
});
