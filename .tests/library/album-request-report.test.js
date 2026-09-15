import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// The admin Requests report: who asked for which album, and how much of it is
// actually on disk, so an admin knows what still has to be bought or ripped.

const [isolatedState, { db }, { userOps }, libraryStore, requests] = await setupIsolatedBackend(
  "album-request-report",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/albumRequestService.js",
);

let dad;
let admin;

test.before(() => {
  resetDatabase(db);
  admin = userOps.getUserById(userOps.createUser("avery", "hash", "admin").id);
  dad = userOps.getUserById(userOps.createUser("dunshill", "hash").id);
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "geese", name: "Geese", metadata: {} });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "getting-killed",
    releaseGroupMbid: "rg-getting-killed",
    artistId: artist.id,
    title: "Getting Killed",
    metadata: { id: 42, librarySource: "lidarr", monitored: true },
  });
  // Two tracks, only the first of them on disk.
  for (const [number, onDisk] of [[1, true], [2, false]]) {
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `getting-killed-${number}`,
      title: `Track ${number}`,
      artistName: "Geese",
    });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: number });
    if (onDisk) {
      libraryStore.upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: "lidarr",
        path: `/data/Music/Library/Geese/Getting Killed/0${number}.flac`,
        format: "flac",
        available: true,
      });
    }
  }
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("a request reports who asked and how much of the album is on disk", () => {
  requests.resetAlbumRequestReport();
  requests.recordAlbumRequest({ user: dad, lidarrAlbumId: 42, albumName: "Getting Killed", artistName: "Geese", at: 1000 });
  requests.recordAlbumRequest({ user: dad, albumMbid: "rg-unknown", albumName: "Unreleased", artistName: "Nobody", at: 2000 });

  const { items } = requests.getAlbumRequestReport();
  assert.equal(items.length, 2);
  assert.equal(items[0].albumName, "Unreleased", "newest first");
  assert.equal(items[0].availability.status, "not_indexed");

  const gettingKilled = items[1];
  assert.equal(gettingKilled.availability.status, "partial");
  assert.equal(gettingKilled.availability.trackCount, 2);
  assert.equal(gettingKilled.availability.availableTrackCount, 1);
  assert.equal(gettingKilled.availability.label, "1 of 2 on disk");
  assert.equal(gettingKilled.requestedBy.username, "dunshill");
  assert.equal(gettingKilled.requestedBy.isAdmin, false);
});

test("asking again is the same request, and an album matches by MusicBrainz id too", () => {
  requests.resetAlbumRequestReport();
  requests.recordAlbumRequest({ user: dad, lidarrAlbumId: 42, albumName: "Getting Killed", at: 5000 });
  requests.recordAlbumRequest({
    user: admin,
    albumMbid: "rg-getting-killed",
    albumName: "Getting Killed",
    artistName: "Geese",
    at: 6000,
  });

  const { items } = requests.getAlbumRequestReport();
  const dadsRequests = items.filter(
    (item) => item.requestedBy.username === "dunshill" && item.albumName === "Getting Killed",
  );
  assert.equal(dadsRequests.length, 1);
  assert.equal(dadsRequests[0].firstRequestedAt, 1000);
  assert.equal(dadsRequests[0].lastRequestedAt, 5000);
  assert.equal(dadsRequests[0].artistName, "Geese", "a later request without the artist keeps the one known");

  const adminsRequest = items.find((item) => item.requestedBy.username === "avery");
  assert.equal(adminsRequest.requestedBy.isAdmin, true);
  assert.equal(adminsRequest.availability.status, "partial");
});

test("requests still in the activity history are copied in, once", () => {
  db.prepare(
    `INSERT INTO aurral_history (id, kind, title, status, metadata, created_at)
     VALUES (?, 'album_requested', ?, 'completed', ?, ?)`,
  ).run(
    "history-old-record",
    "Requested Old Record",
    JSON.stringify({ albumName: "Old Record", artistName: "Someone", albumMbid: "rg-old", userId: dad.id, username: "dunshill" }),
    500,
  );

  requests.resetAlbumRequestReport();
  const first = requests.getAlbumRequestReport().items.filter((item) => item.albumName === "Old Record");
  requests.resetAlbumRequestReport();
  const second = requests.getAlbumRequestReport().items.filter((item) => item.albumName === "Old Record");
  assert.equal(first.length, 1);
  assert.equal(first[0].availability.status, "not_indexed");
  assert.equal(second.length, 1, "copying again adds nothing");
});

test("a dismissed request leaves the report until the same person asks again", () => {
  requests.resetAlbumRequestReport();
  const target = requests.getAlbumRequestReport().items.find((item) => item.albumName === "Unreleased");
  assert.ok(target);

  assert.equal(requests.dismissAlbumRequest(target.id), true);
  assert.ok(!requests.getAlbumRequestReport().items.some((item) => item.id === target.id));

  requests.resetAlbumRequestReport();
  assert.ok(
    !requests.getAlbumRequestReport().items.some((item) => item.id === target.id),
    "copying the history in again does not bring it back",
  );

  requests.recordAlbumRequest({
    user: dad,
    albumMbid: "rg-unknown",
    albumName: "Unreleased",
    artistName: "Nobody",
    at: Date.now() + 1000,
  });
  assert.ok(requests.getAlbumRequestReport().items.some((item) => item.id === target.id));
  assert.equal(requests.dismissAlbumRequest(999999), false);
});
