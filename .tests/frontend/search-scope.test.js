import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { searchPathFor, searchScopeFor } from "../../frontend/src/utils/searchScope.js";
import { navigateFromSearchResult } from "../../frontend/src/utils/searchNavigation.js";

// The search box searches whichever part of the app is showing: the library
// from library pages, everything from Discover - as iTunes searched whichever
// source was selected.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const box = read("../../frontend/src/components/GlobalSearch.jsx");
const page = read("../../frontend/src/pages/LibrarySearchPage.jsx");
const app = read("../../frontend/src/App.jsx");

test("Discover pages search everything; the rest search the library", () => {
  for (const path of ["/discover", "/discover/news", "/search", "/artist/abc", "/artist/abc/release/def", "/shows"]) {
    assert.equal(searchScopeFor(path), "discover", path);
  }
  for (const path of ["/", "/library", "/library/tracks", "/library/album/4", "/library/playlists", "/social", "/requests", "/library/search"]) {
    assert.equal(searchScopeFor(path), "library", path);
  }
  assert.equal(searchScopeFor("/settings/users"), "settings");
  // Not fooled by a path that only starts with the same letters.
  assert.equal(searchScopeFor("/searching"), "library");
});

test("Enter goes to the library's results or Discover's", () => {
  assert.equal(searchPathFor("library", " Talk Talk "), "/library/search?q=Talk%20Talk");
  assert.equal(searchPathFor("discover", "Talk Talk"), "/search?q=Talk%20Talk");
});

test("an artist found from the library opens their library page, not Discover's", () => {
  const went = [];
  const navigate = (path) => went.push(path);
  const artist = { type: "artist", source: "library", id: "mbid-1", canonicalArtistId: 42, name: "Talk Talk" };
  navigateFromSearchResult(navigate, artist, { scope: "library" });
  navigateFromSearchResult(navigate, artist, { scope: "discover" });
  assert.deepEqual(went, ["/library/artist/42", "/artist/mbid-1"]);
});

test("the search box says what it searches, and leads out of the library", () => {
  assert.match(box, /searchScopeFor\(location\.pathname\)/);
  assert.match(box, /"Search your library"/);
  assert.match(box, /"Search everything"/);
  assert.match(box, /Search Discover for “\$\{row\.query\}”/);
  assert.match(box, /navigate\(searchPathFor\(scope, trimmed\)\)/);
});

test("looking at their own library, the rest of the server is counted, with a way to it", () => {
  assert.match(box, /inLibrary && libraryScope === "mine"/);
  assert.match(box, /kind: "show-server", key: "show-server", query: trimmed, count: onServer/);
  assert.match(box, /chooseLibraryScope\("server"\)/);
  assert.match(page, /\{plural\(hidden, "more match"\)\} on the server/);
});

test("#word in the library finds their own tag, and its songs", () => {
  assert.match(box, /if \(inLibrary && trimmed\.startsWith\("#"\)\)/);
  assert.match(box, /navigate\(`\/library\/tracks\?tags=\$\{encodeURIComponent\(selection\.tagName\)\}`\)/);
});

test("library results follow the same switch as the Library page, and never dead-end", () => {
  assert.match(page, /useLibraryScope\(user\?\.id\)/);
  assert.match(page, /searchUnified\(query, \{ mode: "library"/);
  assert.match(page, /Search Discover for “\$\{query\}”/);
  assert.match(app, /<Route path="\/library\/search" element=\{<LibrarySearchPage \/>\} \/>/);
});
