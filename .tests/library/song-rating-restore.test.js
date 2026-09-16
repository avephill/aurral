import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

process.env.AURRAL_NAVIDROME_MUSIC_ROOT = "/data/Music/Library";

// Ratings a person gave songs in iTunes that never reached Navidrome are
// written back, but only where Navidrome holds no rating of their own.

const [isolatedState, { db }, { userOps }, libraryStore, records, restore] = await setupIsolatedBackend(
  "song-rating-restore",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/songRecordService.js",
  "backend/services/songRatingRestore.js",
);

const trackIds = {};

test.before(() => {
  resetDatabase(db);
  userOps.createUser("dunshill", "hash");
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "artist", name: "Neko Case", metadata: {} });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "album", artistId: artist.id, title: "Blacklisted", metadata: {},
  });
  for (const name of ["unrated", "already", "disagrees", "guessed", "gone"]) {
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `recording:${name}`, title: name, artistName: "Neko Case", metadata: {},
    });
    trackIds[name] = track.id;
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, discNumber: 1, trackNumber: 1 });
    // "gone" is indexed but its file is no longer on disk.
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "lidarr",
      path: `/data/Music/Library/Neko Case/Blacklisted/${name}.flac`,
      durationMs: 200_000,
      available: name !== "gone",
    });
  }

  records.importSongRecordBundle({
    format: "psalter-itunes-library",
    owner: "dunshill",
    records: ["unrated", "already", "disagrees", "guessed", "gone"].map((name) => ({
      key: `meta:neko|blacklisted|${name}|200`,
      title: name,
      artist: "Neko Case",
      album: "Blacklisted",
      durationMs: 200_000,
      rating: name === "disagrees" ? 3 : 5,
    })),
  });
  // Link each record to its track, the "guessed" one as a match to check.
  for (const [name, trackId] of Object.entries(trackIds)) {
    const recordId = db.prepare("SELECT id FROM song_records WHERE title = ?").get(name).id;
    db.prepare(`INSERT INTO song_record_links (record_id, track_id, method, status, updated_at)
                VALUES (?, ?, 'test', ?, ?)
                ON CONFLICT (record_id) DO UPDATE SET track_id = excluded.track_id, status = excluded.status`)
      .run(recordId, trackId, name === "guessed" ? "review" : "linked", Date.now());
  }
});

test.after(() => cleanupIsolatedState(isolatedState));

// What Navidrome holds for him today: one song already rated, one rated
// differently from iTunes.
const live = () => new Map([[trackIds.already, 5], [trackIds.disagrees, 4]]);

test("the plan fills blanks, reports disagreements, and flags guessed links", async () => {
  const plan = await restore.planRatingRestore({ owner: "dunshill", ratings: live() });
  const titles = (list) => list.map((entry) => entry.title).sort();
  // "gone" has no file on the server, so there is nothing to rate.
  assert.deepEqual(titles(plan.missing), ["guessed", "unrated"]);
  assert.deepEqual(titles(plan.different), ["disagrees"]);
  assert.equal(plan.different[0].navidromeRating, 4);
  assert.equal(plan.different[0].itunesRating, 3);
  assert.equal(plan.unsureCount, 1);
});

test("applying writes only the certain blanks, as that person", async () => {
  const calls = [];
  const result = await restore.applyRatingRestore({
    owner: "dunshill",
    ratings: live(),
    write: async (user, ref, rating) => calls.push({ user: user.username, ...ref, rating }),
  });
  assert.equal(result.written, 1);
  assert.equal(result.skippedUnsure, 1);
  assert.deepEqual(calls, [{ user: "dunshill", trackId: trackIds.unrated, rating: 5 }]);
});

test("a rating Navidrome already holds is never overwritten", async () => {
  const calls = [];
  await restore.applyRatingRestore({
    owner: "dunshill",
    ratings: live(),
    includeUnsure: true,
    write: async (_user, ref, rating) => calls.push({ ...ref, rating }),
  });
  const touched = calls.map((call) => call.trackId);
  assert.ok(!touched.includes(trackIds.already));
  assert.ok(!touched.includes(trackIds.disagrees));
  assert.equal(touched.length, 2);
});

// A rating that reached the shared library's copy but not his own leaves the
// song looking unrated in his library view. Reading per song cannot see it;
// comparing the copies can.
test("an uneven rating is evened out across the copies he can see", async () => {
  const perCopy = { "song-main": 4, "song-his": 0 };
  const writes = [];
  const client = {
    user: "dunshill",
    async getSong(id) {
      if (!(id in perCopy)) throw Object.assign(new Error("data not found"), { code: 70 });
      return { id, userRating: perCopy[id] };
    },
    async setRating(id, rating) {
      writes.push({ id, rating });
      perCopy[id] = rating;
    },
  };
  const RELATIVE = "Neko Case/Blacklisted/unrated.flac";
  const adminClient = {
    async findSongsByPath(path) {
      if (path !== RELATIVE) return [];
      return [
        { id: "song-main", path: RELATIVE, libraryId: 1 },
        { id: "song-avery", path: RELATIVE, libraryId: 4 },
        { id: "song-his", path: RELATIVE, libraryId: 5 },
      ];
    },
  };

  const preview = await restore.repairSplitRatings({
    owner: "dunshill", trackIds: [trackIds.unrated], client, adminClient, dryRun: true,
  });
  assert.deepEqual(preview.failures, []);
  assert.equal(preview.uneven, 1);
  assert.equal(preview.written, 0);
  assert.deepEqual(writes, []);

  const result = await restore.repairSplitRatings({
    owner: "dunshill", trackIds: [trackIds.unrated], client, adminClient,
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.written, 1);
  // His copy gets the rating the shared copy already had; Avery's copy is not his to fix.
  assert.deepEqual(writes, [{ id: "song-his", rating: 4 }]);

  // Running again finds nothing left to do.
  const again = await restore.repairSplitRatings({
    owner: "dunshill", trackIds: [trackIds.unrated], client, adminClient,
  });
  assert.equal(again.uneven, 0);
});
