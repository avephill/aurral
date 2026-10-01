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
const picker = read("../../frontend/src/components/PeoplePicker.jsx");
const socialPage = read("../../frontend/src/pages/SocialPage.jsx");

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
  assert.match(modal, /Nobody chosen, so this goes to everyone\./);
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

test("who to send to is typed, not hunted for in a row of checkboxes", () => {
  assert.match(modal, /<PeoplePicker/);
  assert.match(picker, /people-picker__chip/);
  assert.match(picker, /event\.key === "ArrowDown"/, "the list is keyboard-navigable");
  assert.match(picker, /event\.key === "Backspace" && !query && value\.length/, "backspace takes the last name back");
});

test("every form on the Social page names people the same way", () => {
  // Recommending, sharing, and starting one together.
  assert.equal(socialPage.match(/<PeoplePicker/g)?.length, 3);
  assert.doesNotMatch(socialPage, /function PeoplePicker/, "no second copy of it");
});

test("recommendations arrive with artwork and somewhere to go", () => {
  const service = read("../../backend/services/socialService.js");
  assert.match(service, /coverUrl: context\.coverUrl,/);
  assert.match(service, /albumId: context\.albumId,/);
  assert.match(socialPage, /social__shelf/);
  assert.match(socialPage, /\/library\/album\/\$\{encodeURIComponent\(entry\.albumId\)\}/);
});

test("both shelves are the same card, so a recommendation looks the same either way", () => {
  assert.equal(socialPage.match(/<RecommendationCard/g)?.length, 2, "received and sent");
  assert.match(socialPage, /You recommended/);
  assert.match(socialPage, /label: "Take this back"/);
  assert.match(socialPage, /label: "Hide this from your page"/);
});

test("a card says whether it is an album or a song", () => {
  assert.match(socialPage, /entry\.kind === "album" \? "Album" : "Song"/);
});

test("a recommendation offers the library the album page offers", () => {
  assert.match(socialPage, /addArtistToMyLibrary\(entry\.artistMbid\)/);
  assert.match(socialPage, /heldArtistMbids\.has\(entry\.artistMbid\)/);
});

test("the share actions say what they do to the copy", () => {
  // "Refresh" and "Remove" read as reloading a page and deleting a playlist.
  assert.match(socialPage, /Get the latest/);
  assert.match(socialPage, /Keep it, stop updating/);
  assert.match(socialPage, /Send changes now/);
  assert.doesNotMatch(socialPage, /btn-xs" onClick=\{\(\) => resync/);
});

test("a copy says it is a copy, and what happens to changes made in it", () => {
  assert.match(socialPage, /kept in step with theirs/);
  assert.match(socialPage, /replaced next time they change the original/);
});

test("the sharer is not told what the other person did with it", () => {
  // Whether they added it, turned it down or threw their copy away is theirs.
  assert.doesNotMatch(socialPage, /removed their copy/);
  assert.doesNotMatch(socialPage, /waiting for \$\{share\.recipient\}/);
  assert.match(socialPage, /<div className="social__muted">shared with \{share\.recipient\}<\/div>/);
});
