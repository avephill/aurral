import test from "node:test";
import assert from "node:assert/strict";

import { db } from "../../backend/config/db-sqlite.js";
import { getCanonicalNewlyAvailableAlbums } from "../../backend/services/libraryQueryService.js";
import { rebuildLibraryRollups } from "../../backend/services/libraryRollups.js";
import { selectNewToServerAlbums } from "../../backend/services/userLibraryService.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.js";

const ARTIST_MBID = "0a0a0a0a-1111-4222-8333-444444444444";
const OTHER_MBID = "0b0b0b0b-1111-4222-8333-444444444444";

const seedAlbum = ({ artist, albumKey, title, files }) => {
  const album = upsertLibraryAlbum({
    identityKey: `release-group:${albumKey}`,
    mbid: albumKey,
    releaseGroupMbid: albumKey,
    artistId: artist.id,
    title,
    albumArtist: artist.name,
    releaseDate: "2001-01-01",
    metadata: { id: 10, librarySource: "lidarr" },
    syncSearch: false,
  });
  files.forEach((createdAt, index) => {
    const track = upsertLibraryTrack({
      identityKey: `recording:${albumKey}-${index}`,
      title: `Track ${index + 1}`,
      artistName: artist.name,
      syncSearch: false,
    });
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1, syncSearch: false });
    upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "lidarr",
      path: `/music/${albumKey}/${index + 1}.flac`,
      format: "flac",
      size: 1,
      available: true,
      scanId: 1,
    });
    db.prepare("UPDATE library_media_files SET created_at = ? WHERE path = ?").run(
      createdAt,
      `/music/${albumKey}/${index + 1}.flac`,
    );
  });
  return album;
};

test("getCanonicalNewlyAvailableAlbums orders by first-seen media and respects the window", () => {
  db.exec("DELETE FROM library_media_files; DELETE FROM library_album_tracks; DELETE FROM library_tracks; DELETE FROM library_albums; DELETE FROM library_artists;");
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const artist = upsertLibraryArtist({
    identityKey: `artist:${ARTIST_MBID}`,
    mbid: ARTIST_MBID,
    name: "Fixture Artist",
    metadata: { id: 7, foreignArtistId: ARTIST_MBID, librarySource: "lidarr" },
    syncSearch: false,
  });

  // Old album that got one file re-ripped yesterday: must NOT look new (MIN, not MAX).
  seedAlbum({ artist, albumKey: "aaaaaaaa-0000-4000-8000-000000000001", title: "Old Album", files: [now - 400 * day, now - 1 * day] });
  // Two genuinely new albums, newest first.
  seedAlbum({ artist, albumKey: "aaaaaaaa-0000-4000-8000-000000000002", title: "Last Week", files: [now - 7 * day, now - 6 * day] });
  seedAlbum({ artist, albumKey: "aaaaaaaa-0000-4000-8000-000000000003", title: "Yesterday", files: [now - 1 * day] });

  // The query reads library_album_stats, which indexing rebuilds; seeding the
  // base tables directly has to do the same.
  rebuildLibraryRollups();

  const albums = getCanonicalNewlyAvailableAlbums({ since: now - 90 * day, limit: 10 });
  assert.deepEqual(albums.map((album) => album.albumName), ["Yesterday", "Last Week"]);
  assert.equal(albums[0].foreignArtistId, ARTIST_MBID);
  assert.equal(albums[0].providerArtistId, "7");
  assert.equal(albums[0].trackCount, 1);
  assert.ok(albums[0].firstSeenAt >= now - 1 * day - 1000);

  const limited = getCanonicalNewlyAvailableAlbums({ since: now - 90 * day, limit: 1 });
  assert.deepEqual(limited.map((album) => album.albumName), ["Yesterday"]);
});

test("selectNewToServerAlbums hides the viewer's artists and names the other libraries", () => {
  const tagLabelsById = new Map([[1, "mom"], [2, "avery"], [3, "flac"]]);
  const lidarrArtists = [
    { id: 7, foreignArtistId: ARTIST_MBID, artistName: "Fixture Artist", tags: [2, 3] },
    { id: 8, foreignArtistId: OTHER_MBID, artistName: "Shared Artist", tags: [1, 2] },
  ];
  const albums = [
    { id: "1", albumName: "Avery's CD", artistName: "Fixture Artist", foreignArtistId: ARTIST_MBID },
    { id: "2", albumName: "Shared CD", artistName: "Shared Artist", foreignArtistId: OTHER_MBID },
    { id: "3", albumName: "Not In Lidarr", artistName: "Ghost", foreignArtistId: "ghost" },
  ];
  const usernames = ["mom", "avery"];

  const forMom = selectNewToServerAlbums({
    albums,
    lidarrArtists,
    tagLabelsById,
    usernames,
    viewerUsername: "Mom",
  });
  assert.deepEqual(forMom.map((album) => album.albumName), ["Avery's CD"]);
  assert.deepEqual(forMom[0].libraries, ["avery"]);
  assert.equal(forMom[0].artistMbid, ARTIST_MBID);

  const forAvery = selectNewToServerAlbums({
    albums,
    lidarrArtists,
    tagLabelsById,
    usernames,
    viewerUsername: "avery",
  });
  assert.deepEqual(forAvery, []);

  const forNewcomer = selectNewToServerAlbums({
    albums,
    lidarrArtists,
    tagLabelsById,
    usernames,
    viewerUsername: "dad",
    limit: 1,
  });
  assert.deepEqual(forNewcomer.map((album) => album.albumName), ["Avery's CD"]);
});
