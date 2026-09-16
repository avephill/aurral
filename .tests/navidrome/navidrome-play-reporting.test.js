import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// A play in Aurral's own player is told to Navidrome as that person, so its
// play counts and history are right in every other client too. One copy only:
// the same file is a separate song in each personal library.

process.env.AURRAL_NAVIDROME_USER_AUTH = "reverse-proxy";
process.env.AURRAL_NAVIDROME_USER_HEADER = "X-Authentik-Username";
process.env.AURRAL_NAVIDROME_MUSIC_ROOT = "/data/Music/Library";

const RELATIVE = "Neko Case/Blacklisted/01 Things That Scare Me.flac";

const [isolatedState, { db }, { userOps }, libraryStore, annotations] = await setupIsolatedBackend(
  "navidrome-play-reporting",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/navidromeAnnotations.js",
);

let trackId;

test.before(() => {
  resetDatabase(db);
  userOps.createUser("dunshill", "hash");
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "neko", name: "Neko Case", metadata: {} });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "blacklisted",
    artistId: artist.id,
    title: "Blacklisted",
    metadata: {},
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "recording:things",
    title: "Things That Scare Me",
    artistName: "Neko Case",
    metadata: {},
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, discNumber: 1, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "lidarr",
    path: `/data/Music/Library/${RELATIVE}`,
    durationMs: 200_000,
    available: true,
  });
  trackId = track.id;
});

test.after(() => cleanupIsolatedState(isolatedState));

// The file is in the shared library and symlinked into his own, so Navidrome
// holds two songs for it.
const fakeAdmin = () => ({
  async findSongsByPath(path) {
    return path === RELATIVE
      ? [{ id: "song-main", path: RELATIVE, libraryId: 1 }, { id: "song-his", path: RELATIVE, libraryId: 5 }]
      : [];
  },
});

const fakeUser = () => {
  const calls = [];
  return {
    calls,
    user: "dunshill",
    async scrobble(id, options) {
      calls.push({ id, ...options });
    },
  };
};

test("a play is reported once, against the person's own copy", async () => {
  const client = fakeUser();
  const result = await annotations.reportPlayToNavidrome(
    { username: "dunshill" },
    { trackId },
    { client, adminClient: fakeAdmin(), preferLibraryId: 5, playedAt: 1_700_000_000_000 },
  );
  assert.equal(result.reported, true);
  assert.equal(result.songId, "song-his");
  assert.deepEqual(client.calls, [{ id: "song-his", time: 1_700_000_000_000 }]);
});

test("without a personal library the shared copy is used", async () => {
  const client = fakeUser();
  const result = await annotations.reportPlayToNavidrome(
    { username: "dunshill" },
    { trackId },
    { client, adminClient: fakeAdmin(), preferLibraryId: null },
  );
  assert.equal(result.songId, "song-main");
  assert.equal(client.calls.length, 1);
});

test("a track Navidrome does not know is left alone, not an error", async () => {
  const client = fakeUser();
  const result = await annotations.reportPlayToNavidrome(
    { username: "dunshill" },
    { trackId: 987654 },
    { client, adminClient: fakeAdmin(), preferLibraryId: 5 },
  );
  assert.equal(result.reported, false);
  assert.match(result.reason, /not a library track|has not indexed/);
  assert.deepEqual(client.calls, []);
});

// A file symlinked into several personal libraries is a separate song in each,
// and Navidrome refuses an id belonging to a library this person cannot see.
// That must not stop the copies they do have: a rating written to the shared
// library but not to their own disappears from their view.
test("a copy in someone else's library does not stop the rating", async () => {
  const accepted = [];
  const client = {
    user: "dunshill",
    async setRating(id, value) {
      // "song-avery" lives only in Avery's personal library.
      if (id === "song-avery") throw Object.assign(new Error("data not found"), { code: 70 });
      accepted.push({ id, value });
    },
    async getSong(id) {
      return { id, userRating: 4, starred: false };
    },
  };
  const result = await annotations.setTrackRating({ username: "dunshill" }, { trackId }, 4, {
    client,
    adminClient: {
      async findSongsByPath() {
        return [
          { id: "song-main", path: RELATIVE, libraryId: 1 },
          { id: "song-avery", path: RELATIVE, libraryId: 4 },
          { id: "song-his", path: RELATIVE, libraryId: 5 },
        ];
      },
    },
  });
  assert.equal(result.rating, 4);
  assert.deepEqual(accepted.map((call) => call.id).sort(), ["song-his", "song-main"]);
});
