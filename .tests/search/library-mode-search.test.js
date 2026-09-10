import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, libraryStore, search] = await setupIsolatedBackend(
  "library-mode-search",
  "backend/config/db-sqlite.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/unifiedSearchService.js",
);

test.before(() => {
  resetDatabase(db);
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "jpegmafia",
    mbid: "11111111-1111-4111-8111-111111111111",
    name: "JPEGMAFIA",
    metadata: {},
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "all-my-heroes",
    releaseGroupMbid: "22222222-2222-4222-8222-222222222222",
    artistId: artist.id,
    title: "All My Heroes Are Cornballs",
    albumArtist: artist.name,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "jesus-forgive-me",
    title: "Jesus Forgive Me, I Am a Thot",
    artistName: artist.name,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "lidarr",
    path: "/data/Music/Library/JPEGMAFIA/All My Heroes Are Cornballs/01 Jesus Forgive Me, I Am a Thot.flac",
    format: "flac",
    available: true,
  });
  const other = libraryStore.upsertLibraryArtist({ identityKey: "other", name: "Other Artist", metadata: {} });
  const otherAlbum = libraryStore.upsertLibraryAlbum({ identityKey: "other-album", artistId: other.id, title: "Unrelated", albumArtist: other.name });
  const otherTrack = libraryStore.upsertLibraryTrack({ identityKey: "other-track", title: "Nothing Here", artistName: other.name });
  libraryStore.linkLibraryAlbumTrack({ albumId: otherAlbum.id, trackId: otherTrack.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({ trackId: otherTrack.id, albumId: otherAlbum.id, source: "lidarr", path: "/data/Music/Library/Other/Unrelated/01 Nothing Here.flac", format: "flac", available: true });
  search.clearSearchContextCache();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("library mode answers from the canonical index with artists, albums and tracks", async () => {
  const result = await search.searchUnified("JPEG", { mode: "library", limit: 5 });
  assert.equal(result.mode, "library");
  assert.deepEqual(result.catalog, { artists: [], albums: [], tracks: [] });
  assert.equal(result.top, null);
  assert.deepEqual(result.library.artists.map((artist) => artist.name), ["JPEGMAFIA"]);
  assert.equal(result.library.artists[0].id, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(result.library.albums.map((album) => album.title), ["All My Heroes Are Cornballs"]);
  assert.ok(result.library.albums[0].canonicalAlbumId);
  assert.equal(result.library.albums[0].artistName, "JPEGMAFIA");
  assert.deepEqual(result.library.tracks.map((track) => track.title), ["Jesus Forgive Me, I Am a Thot"]);
  assert.match(result.library.tracks[0].streamPath, /^\/library\/canonical-stream\//);
});

test("library mode matches a spaced query against a run-together name", async () => {
  const result = await search.searchUnified("jpeg mafia", { mode: "library", limit: 5 });
  assert.deepEqual(result.library.artists.map((artist) => artist.name), ["JPEGMAFIA"]);
});

test("library mode returns nothing for a name that is not in the library", async () => {
  const result = await search.searchUnified("Radiohead", { mode: "library", limit: 5 });
  assert.equal(result.library.artists.length, 0);
  assert.equal(result.library.albums.length, 0);
  assert.equal(result.library.tracks.length, 0);
});
