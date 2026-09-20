import test from "node:test";
import assert from "node:assert/strict";

import {
  isStudioRelease,
  matchesReleaseGroupSearch,
  matchesReleaseGroupTab,
} from "../../frontend/src/pages/ArtistDetails/releaseFilters.js";

const release = (primaryType, secondaryTypes = [], title = "Release") => ({
  title,
  "primary-type": primaryType,
  "secondary-types": secondaryTypes,
});

test("studio only hides anything MusicBrainz gave a secondary type", () => {
  const studioAlbum = release("Album");
  const liveAlbum = release("Album", ["Live"]);
  const demoAlbum = release("Album", ["Demo"]);
  const studioEp = release("EP");
  const liveEp = release("EP", ["Live"]);

  assert.equal(isStudioRelease(studioAlbum), true);
  assert.equal(isStudioRelease(demoAlbum), false);

  assert.equal(matchesReleaseGroupTab(studioAlbum, "albums"), true);
  assert.equal(matchesReleaseGroupTab(studioAlbum, "albums", true), true);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "all"), true);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "all", true), false);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "albums"), true);
  assert.equal(matchesReleaseGroupTab(liveAlbum, "albums", true), false);
  assert.equal(matchesReleaseGroupTab(demoAlbum, "albums", true), false);
  assert.equal(matchesReleaseGroupTab(studioEp, "singles", true), true);
  assert.equal(matchesReleaseGroupTab(liveEp, "singles"), true);
  assert.equal(matchesReleaseGroupTab(liveEp, "singles", true), false);
});

// The tab is defined by a secondary type, so studio-only has to leave it alone
// rather than empty it.
test("the compilations tab ignores studio only", () => {
  const liveCompilation = release("Album", ["Compilation", "Live"]);
  const studioAlbum = release("Album");

  assert.equal(matchesReleaseGroupTab(liveCompilation, "compilations"), true);
  assert.equal(matchesReleaseGroupTab(liveCompilation, "compilations", true), true);
  assert.equal(matchesReleaseGroupTab(studioAlbum, "compilations", true), false);
});

test("release search matches titles without case or surrounding whitespace", () => {
  const item = release("Album", [], "Live at Leeds");

  assert.equal(matchesReleaseGroupSearch(item, "  LEEDS "), true);
  assert.equal(matchesReleaseGroupSearch(item, "studio"), false);
});
