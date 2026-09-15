import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// The Tracks page sorts on the server, by the column clicked: album, time or
// the person's own rating, as well as name and artist.

const [isolatedState, { db }, libraryStore, queries] = await setupIsolatedBackend(
  "track-page-sorting",
  "backend/config/db-sqlite.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryQueryService.js",
);

const ids = {};

test.before(() => {
  resetDatabase(db);
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "artist", name: "Artist", metadata: {} });
  const zulu = libraryStore.upsertLibraryAlbum({ identityKey: "zulu", artistId: artist.id, title: "Zulu" });
  const alpha = libraryStore.upsertLibraryAlbum({ identityKey: "alpha", artistId: artist.id, title: "Alpha" });
  const add = (key, title, album, number, durationMs) => {
    const track = libraryStore.upsertLibraryTrack({ identityKey: key, title, artistName: "Artist" });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: number });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "lidarr",
      path: `/music/${key}.flac`,
      durationMs,
      available: true,
    });
    ids[key] = track.id;
  };
  add("short", "Beta Short", zulu, 1, 60_000);
  add("long", "Alpha Long", zulu, 2, 600_000);
  add("middle", "Gamma Middle", alpha, 1, 200_000);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

const order = (options) =>
  queries
    .getCanonicalLibraryPage({ kind: "tracks", pageSize: 10, ...options })
    .items.map((track) => track.title);

test("tracks sort by album, then disc and track number", () => {
  assert.deepEqual(order({ sort: "album" }), ["Gamma Middle", "Beta Short", "Alpha Long"]);
  assert.deepEqual(order({ sort: "album", direction: "desc" }), ["Beta Short", "Alpha Long", "Gamma Middle"]);
});

test("tracks sort by time", () => {
  assert.deepEqual(order({ sort: "duration" }), ["Beta Short", "Gamma Middle", "Alpha Long"]);
  assert.deepEqual(order({ sort: "duration", direction: "desc" }), ["Alpha Long", "Gamma Middle", "Beta Short"]);
});

test("tracks sort by the person's rating, unrated last", () => {
  const trackRatings = { [ids.middle]: 5, [ids.short]: 3 };
  assert.deepEqual(
    order({ sort: "rating", direction: "desc", trackRatings }),
    ["Gamma Middle", "Beta Short", "Alpha Long"],
  );
  assert.deepEqual(
    order({ sort: "rating", direction: "desc", trackRatings, query: "a" }),
    ["Gamma Middle", "Beta Short", "Alpha Long"],
    "still right alongside a search, whose placeholder comes first",
  );
  assert.equal(
    queries.getCanonicalLibraryPage({ kind: "tracks", pageSize: 10, sort: "rating", trackRatings }).total,
    3,
    "the ratings join does not change the count",
  );
});
