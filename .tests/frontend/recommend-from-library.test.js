import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Recommending something you are already looking at, rather than searching for
// it again on the Social page.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../../frontend/src/pages/LibraryPage.jsx");
const modal = read("../../frontend/src/components/RecommendModal.jsx");
const client = read("../../frontend/src/utils/api/endpoints/social.js");
const releasePage = read("../../frontend/src/pages/ArtistDetails/ReleasePage.jsx");
const trackList = read(
  "../../frontend/src/pages/ArtistDetails/components/ArtistDetailsReleaseTrackList.jsx",
);
const trackMenu = read("../../frontend/src/pages/ArtistDetails/components/TrackPlaylistMenu.jsx");

test("an album in the library can be recommended from its own page", () => {
  assert.match(page, /openRecommend\("album", libraryAlbum/);
  assert.match(page, /native-library-detail__recommend/);
});

test("and from the album's own menu", () => {
  assert.match(page, /id: "recommend",[\s\S]{0,200}openRecommend\("album", libraryAlbum/);
});

test("a song is recommended from the menu beside it", () => {
  assert.match(page, /id: "recommend",[\s\S]{0,200}openRecommend\("track", track/);
});

test("the target is the canonical library row, which is what the recommendation stores", () => {
  assert.match(page, /if \(!entity\?\.id\) return;/);
  assert.match(page, /id: entity\.id,/);
});

test("the modal is mounted where the other library modals are", () => {
  assert.match(page, /<RecommendModal target=\{recommending\} onClose=/);
});

test("it sends what the endpoint expects", () => {
  assert.match(modal, /sendRecommendation\(\{[\s\S]{0,160}kind: target\.kind,[\s\S]{0,160}targetId: target\.id,/);
  assert.match(client, /postData\("\/social\/recommendations", \{ kind, targetId, note, recipients \}\)/);
});

test("choosing nobody means everybody, and the button says so", () => {
  assert.match(modal, /With nobody chosen it goes to everyone/);
  assert.match(modal, /recipients\.length \? "Send" : "Send to everyone"/);
});

test("a release the server holds can be recommended from the release page", () => {
  assert.match(releasePage, /libraryInfo\?\.canonicalAlbumId \? \(/);
  assert.match(releasePage, /kind: "album",[\s\S]{0,80}id: libraryInfo\.canonicalAlbumId,/);
  assert.match(releasePage, /<RecommendModal target=\{recommending\}/);
});

test("its songs are recommendable only when the server actually holds them", () => {
  assert.match(trackList, /onRecommendTrack && isOwned/);
  assert.match(releasePage, /canonical\?\.trackId[\s\S]{0,120}kind: "track",/);
});

test("the shared track menu grew a recommend entry", () => {
  assert.match(trackMenu, /onRecommend \? \(/);
  assert.match(trackMenu, /Recommend to\.\.\./);
});
