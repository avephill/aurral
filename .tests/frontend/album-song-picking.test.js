import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Choosing several of an album's songs and adding them to a playlist at once.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../../frontend/src/pages/LibraryPage.jsx");
const menu = read("../../frontend/src/pages/ArtistDetails/components/TrackPlaylistMenu.jsx");

test("the album menu starts choosing, with every playable song ticked", () => {
  assert.match(page, /label: "Add songs to a playlist\.\.\."/);
  assert.match(page, /label: "Add songs to a playlist\.\.\.",[\s\S]{0,80}startPicking\(libraryAlbum, albumTracks, "playlist"\)/);
  assert.match(
    page,
    /setPicking\(\{\s*albumId: album\.id,\s*purpose,\s*ids: new Set\(albumTracks\.filter\(\(track\) => firstAvailableFile\(track\)\)/,
  );
});

test("a song that is not on the server cannot be ticked", () => {
  assert.match(page, /className="native-library-track__pick"[\s\S]{0,120}disabled=\{!file\}/);
});

test("songs already in the playlist are not added twice", () => {
  assert.match(page, /addSharedPlaylistTracks\(target\?\.playlistId, \{ tracks: payloads, skipExisting: true \}\)/);
  assert.match(page, /already in it/);
});

test("the playlist menu opens upwards when there is no room below", () => {
  assert.match(menu, /\{ bottom: window\.innerHeight - rect\.top \+ 8, left \}/);
});

// The same choosing, for tags.

const tagsModal = read("../../frontend/src/components/TagsModal.jsx");

test("the album menu can start choosing songs to tag", () => {
  assert.match(page, /label: "Tag songs\.\.\.",[\s\S]{0,80}startPicking\(libraryAlbum, albumTracks, "tags"\)/);
  assert.match(page, /forTags \? \(/);
  assert.match(page, /kind: "tracks",\s*ids: chosen\.map\(\(track\) => track\.id\)/);
});

test("several songs get each tag added, and keep what they had", () => {
  assert.match(tagsModal, /for \(const tag of adding\) await applyTag\(\{ trackIds: subject\.ids, tag \}\)/);
  assert.match(tagsModal, /Tags they have already are kept\./);
  // Nothing is read for several songs: there is no one set of tags to show.
  assert.match(tagsModal, /isMany\s*\? Promise\.resolve\(\{ tags: \[\] \}\)/);
});
