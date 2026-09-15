import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// Indexing single albums, as a Lidarr webhook asks for, instead of the whole
// library. A failed Lidarr read must never be taken for an album with no files.

const [isolatedState, { db }, indexer] = await setupIsolatedBackend(
  "lidarr-album-index",
  "backend/config/db-sqlite.js",
  "backend/services/libraryLidarrIndexer.js",
);

const ALBUM_MBID = "55555555-5555-4555-8555-555555555555";

let root;
let fileOne;
let fileTwo;

test.before(async () => {
  resetDatabase(db);
  root = await mkdtemp(path.join(tmpdir(), "psalter-album-index-"));
  await mkdir(path.join(root, "Artist", "Album"), { recursive: true });
  fileOne = path.join(root, "Artist", "Album", "01 One.flac");
  fileTwo = path.join(root, "Artist", "Album", "02 Two.flac");
  await writeFile(fileOne, "one");
  await writeFile(fileTwo, "two");
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

const artist = { id: 7, artistName: "Artist", foreignArtistId: "44444444-4444-4444-8444-444444444444" };
const album = { id: 8, artistId: 7, title: "Album", foreignAlbumId: ALBUM_MBID, path: "" };
const tracks = [
  { id: 91, albumId: 8, title: "One", trackNumber: 1, trackFileId: 101 },
  { id: 92, albumId: 8, title: "Two", trackNumber: 2, trackFileId: 102 },
];

function lidarr({ files, albumGone = false, failFiles = false } = {}) {
  const asked = [];
  return {
    asked,
    isConfigured: () => true,
    request: async (endpoint) => {
      asked.push(endpoint);
      if (endpoint === "/artist/7") return artist;
      if (endpoint === "/album/8") return albumGone ? null : album;
      if (endpoint === "/track?albumId=8") return tracks;
      if (endpoint === "/trackfile?albumId=8") {
        if (failFiles) throw new Error("Lidarr API error: 503 - unavailable");
        return files;
      }
      if (endpoint === "/album?artistId=7") return [album];
      throw new Error(`unexpected ${endpoint}`);
    },
  };
}

const albumRecordId = () =>
  db.prepare("SELECT id FROM library_albums WHERE release_group_mbid = ?").get(ALBUM_MBID)?.id;

const availablePaths = () =>
  db.prepare("SELECT path FROM library_media_files WHERE source = 'lidarr' AND available = 1 ORDER BY path")
    .all()
    .map((row) => row.path);

// Built when a test runs: the temporary files only exist after test.before.
const bothFiles = () => [
  { id: 101, path: fileOne, trackIds: [91] },
  { id: 102, path: fileTwo, trackIds: [92] },
];

test("an album is indexed on its own, with its readable files and its rollups", async () => {
  const result = await indexer.indexLidarrAlbums({ client: lidarr({ files: bothFiles() }), albumIds: [8], syncSearch: false });
  assert.equal(result.filesIndexed, 2);
  assert.deepEqual(availablePaths(), [fileOne, fileTwo]);
  assert.ok(db.prepare("SELECT 1 FROM library_album_stats WHERE album_id = ?").get(albumRecordId()));
  assert.equal(
    db.prepare("SELECT album_count FROM library_artist_stats").get()?.album_count,
    1,
    "the artist's rollup is rebuilt too",
  );
});

test("a Lidarr error is thrown, and the files it could not confirm stay available", async () => {
  await assert.rejects(
    indexer.indexLidarrAlbums({ client: lidarr({ files: bothFiles(), failFiles: true }), albumIds: [8], syncSearch: false }),
    /503/,
  );
  assert.deepEqual(availablePaths(), [fileOne, fileTwo]);
});

test("a file Lidarr no longer lists for the album is marked unavailable", async () => {
  const result = await indexer.indexLidarrAlbums({
    client: lidarr({ files: [bothFiles()[0]] }),
    albumIds: [8],
    syncSearch: false,
  });
  assert.equal(result.removedFiles, 1);
  assert.deepEqual(availablePaths(), [fileOne]);
});

test("an artist's albums are indexed through the artist", async () => {
  const client = lidarr({ files: bothFiles() });
  const result = await indexer.indexLidarrAlbums({ client, artistIds: [7], syncSearch: false });
  assert.ok(client.asked.includes("/album?artistId=7"));
  assert.equal(result.filesIndexed, 2);
  assert.deepEqual(availablePaths(), [fileOne, fileTwo]);
});

test("an album Lidarr no longer has loses its files, and its album rollup", async () => {
  const result = await indexer.indexLidarrAlbums({
    client: lidarr({ files: bothFiles(), albumGone: true }),
    albumIds: [8],
    syncSearch: false,
  });
  assert.deepEqual(result.goneAlbumIds, [8]);
  assert.equal(result.removedFiles, 2);
  assert.deepEqual(availablePaths(), []);
  assert.equal(db.prepare("SELECT 1 FROM library_album_stats WHERE album_id = ?").get(albumRecordId()), undefined);
});
