import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, libraryStore, rollups, queries] = await setupIsolatedBackend(
  "library-rollups",
  "backend/config/db-sqlite.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryRollups.js",
  "backend/services/libraryQueryService.js",
);

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

const ARTIST_MBID = "11111111-2222-4333-8444-555555555555";

const seed = ({ available = 1, size = 1000 } = {}) => {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `artist:${ARTIST_MBID}`,
    mbid: ARTIST_MBID,
    name: "Rollup Artist",
    metadata: { id: 3, foreignArtistId: ARTIST_MBID, librarySource: "lidarr" },
    syncSearch: false,
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "release-group:rollup-album",
    mbid: "aaaaaaaa-0000-4000-8000-00000000abcd",
    releaseGroupMbid: "aaaaaaaa-0000-4000-8000-00000000abcd",
    artistId: artist.id,
    title: "Rollup Album",
    albumArtist: artist.name,
    syncSearch: false,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "track:rollup-1",
    title: "Rollup Track",
    artistName: artist.name,
    syncSearch: false,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, syncSearch: false });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "lidarr",
    path: `/music/rollup-${size}.flac`,
    format: "flac",
    size,
    available: available === 1,
    scanId: 1,
  });
  return { artist, album, track };
};

test("rollups carry the counts the artist projection reports", () => {
  const { artist } = seed({ size: 4096 });
  rollups.rebuildLibraryRollups();

  const stats = db
    .prepare("SELECT * FROM library_artist_stats WHERE artist_id = ?")
    .get(artist.id);
  assert.equal(stats.album_count, 1);
  assert.equal(stats.track_count, 1);
  assert.equal(stats.size_on_disk, 4096);
  assert.equal(stats.available, 1);

  const [projected] = queries.getCanonicalArtistProjection({ mbids: [ARTIST_MBID] });
  assert.equal(projected.statistics.albumCount, 1);
  assert.equal(projected.statistics.trackCount, 1);
  assert.equal(projected.statistics.sizeOnDisk, 4096);
  assert.equal(projected.available, true);
  assert.deepEqual(projected.sources, ["lidarr"]);
});

test("an artist with nothing indexed still projects, with zeroed counts", () => {
  db.exec("DELETE FROM library_media_files; DELETE FROM library_album_tracks;");
  db.exec("DELETE FROM library_tracks; DELETE FROM library_albums; DELETE FROM library_artists;");
  const bare = libraryStore.upsertLibraryArtist({
    identityKey: "artist:bare",
    mbid: "99999999-2222-4333-8444-555555555555",
    name: "Bare Artist",
    syncSearch: false,
  });
  rollups.rebuildLibraryRollups();

  const stats = db.prepare("SELECT * FROM library_artist_stats WHERE artist_id = ?").get(bare.id);
  assert.equal(stats.album_count, 0);
  assert.equal(stats.available, 0);

  const [projected] = queries.getCanonicalArtistProjection({
    mbids: ["99999999-2222-4333-8444-555555555555"],
  });
  assert.equal(projected.statistics.albumCount, 0);
  assert.equal(projected.statistics.sizeOnDisk, 0);
  assert.equal(projected.available, false);
});

test("rebuilding replaces rather than accumulates rows", () => {
  db.exec("DELETE FROM library_media_files; DELETE FROM library_album_tracks;");
  db.exec("DELETE FROM library_tracks; DELETE FROM library_albums; DELETE FROM library_artists;");
  seed({ size: 2048 });
  rollups.rebuildLibraryRollups();
  rollups.rebuildLibraryRollups();

  const artistRows = db.prepare("SELECT COUNT(*) AS c FROM library_artist_stats").get().c;
  const albumRows = db.prepare("SELECT COUNT(*) AS c FROM library_album_stats").get().c;
  assert.equal(artistRows, 1);
  assert.equal(albumRows, 1);
});

test("unavailable media leaves the album out of the newly-available rollup", () => {
  db.exec("DELETE FROM library_media_files; DELETE FROM library_album_tracks;");
  db.exec("DELETE FROM library_tracks; DELETE FROM library_albums; DELETE FROM library_artists;");
  seed({ available: 0 });
  rollups.rebuildLibraryRollups();

  // An album nobody can play was never in the "new to server" results, and the
  // rollup has to preserve that rather than surface it with a null timestamp.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM library_album_stats").get().c, 0);
  assert.equal(
    queries.getCanonicalNewlyAvailableAlbums({ since: 0, limit: 10 }).length,
    0,
  );
});

test("ensureLibraryRollups builds once and then leaves them alone", () => {
  db.exec("DELETE FROM library_media_files; DELETE FROM library_album_tracks;");
  db.exec("DELETE FROM library_tracks; DELETE FROM library_albums; DELETE FROM library_artists;");
  seed();
  db.exec("DELETE FROM library_artist_stats; DELETE FROM library_album_stats;");

  assert.equal(rollups.ensureLibraryRollups(), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM library_artist_stats").get().c, 1);
  // Already present, so it must not pay for a rebuild on every boot.
  assert.equal(rollups.ensureLibraryRollups(), false);
});
