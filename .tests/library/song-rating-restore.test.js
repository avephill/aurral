import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

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
