import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Choosing several of an album's songs and adding them to a playlist at once.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../../frontend/src/pages/LibraryPage.jsx");
const menu = read("../../frontend/src/pages/ArtistDetails/components/TrackPlaylistMenu.jsx");

test("the album menu starts choosing, with every playable song ticked", () => {
  assert.match(page, /label: "Add songs to a playlist\.\.\."/);
  assert.match(
    page,
    /setPicking\(\{\s*albumId: libraryAlbum\.id,\s*ids: new Set\(\s*albumTracks\.filter\(\(track\) => firstAvailableFile\(track\)\)/,
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
