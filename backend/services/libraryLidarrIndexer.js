import fs from "fs/promises";
import path from "path";
import { db } from "../config/db-sqlite.js";
import {
  buildFallbackIdentityKey,
  buildIdentityKey,
  getAvailableLibraryMediaPaths,
  linkLibraryAlbumTrack,
  markLibraryMediaFilesUnavailable,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
  withLibraryScan,
} from "./libraryMediaStore.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import { mapWithConcurrency } from "./discovery/helpers.js";
import { rebuildLibraryRollupsForArtists } from "./libraryRollups.js";
import { logger } from "./logger.js";

const text = (value) => String(value || "").trim();

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    text(value),
  );

function buildFileIndex(files) {
  const index = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    if (file?.id != null) index.set(`file:${file.id}`, file);
    for (const trackId of Array.isArray(file?.trackIds) ? file.trackIds : []) {
      index.set(`track:${trackId}`, file);
    }
  }
  return index;
}

function buildBulkAlbumTrackData(albums, tracks, files) {
  const tracksByAlbumId = new Map();
  const albumIdsByTrackId = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (track?.albumId == null) continue;
    const albumId = String(track.albumId);
    const albumTracks = tracksByAlbumId.get(albumId) || [];
    albumTracks.push(track);
    tracksByAlbumId.set(albumId, albumTracks);
    const trackAlbums = albumIdsByTrackId.get(String(track.id)) || new Set();
    trackAlbums.add(albumId);
    albumIdsByTrackId.set(String(track.id), trackAlbums);
  }

  const filesByAlbumId = new Map();
  const addFile = (albumId, file) => {
    const key = String(albumId);
    const albumFiles = filesByAlbumId.get(key) || new Map();
    const fileKey = file?.id != null ? `id:${file.id}` : `path:${file?.path || ""}`;
    albumFiles.set(fileKey, file);
    filesByAlbumId.set(key, albumFiles);
  };
  for (const file of Array.isArray(files) ? files : []) {
    const albumIds = new Set();
    if (file?.albumId != null) albumIds.add(String(file.albumId));
    for (const trackId of [file?.trackId, ...(Array.isArray(file?.trackIds) ? file.trackIds : [])]) {
      for (const albumId of albumIdsByTrackId.get(String(trackId)) || []) albumIds.add(albumId);
    }
    for (const albumId of albumIds) addFile(albumId, file);
  }

  return (Array.isArray(albums) ? albums : []).map((album) => {
    const albumId = String(album?.id);
    return {
      albumId,
      tracks: tracksByAlbumId.get(albumId) || [],
      files: [...(filesByAlbumId.get(albumId)?.values() || [])],
    };
  });
}

// How the index reads Lidarr. It runs in the background, where a slow answer
// is fine and a failed one throws the whole scan away: with the client's 30s
// interactive timeout and twelve artists asked for at once, one heavy artist's
// track list timing out twice aborted every index for weeks. So give these
// reads minutes rather than seconds, and ask for fewer at a time.
export const LIDARR_INDEX_READ = Object.freeze({
  forceRefresh: true,
  throwOnError: true,
  timeoutMs: 5 * 60 * 1000,
  concurrency: 4,
});

async function loadAlbumTrackData(client, albums, artistIds) {
  const loadPerAlbumTrackData = () =>
    mapWithConcurrency(albums, 4, async (album) => {
      if (!album?.id) return { albumId: null, tracks: [], files: [] };
      const [tracks, files] = await Promise.all([
        client.getTracksByAlbumId(album.id),
        client.getTrackFilesByAlbumId(album.id),
      ]);
      return {
        albumId: String(album.id),
        tracks: Array.isArray(tracks) ? tracks : [],
        files: Array.isArray(files) ? files : [],
      };
    });

  if (
    typeof client.getAllTracks === "function" &&
    (typeof client.getTrackFilesByIds === "function" ||
      typeof client.getAllTrackFiles === "function")
  ) {
    let tracks;
    let files;
    if (typeof client.getTrackFilesByIds === "function") {
      tracks = await client.getAllTracks({ artistIds, ...LIDARR_INDEX_READ });
      files = await client.getTrackFilesByIds(
        tracks.map((track) => track?.trackFileId),
        LIDARR_INDEX_READ,
      ).catch((error) => {
        if (typeof client.getAllTrackFiles !== "function") throw error;
        return client.getAllTrackFiles({ artistIds, ...LIDARR_INDEX_READ });
      });
    } else {
      [tracks, files] = await Promise.all([
        client.getAllTracks({ artistIds, ...LIDARR_INDEX_READ }),
        client.getAllTrackFiles({ artistIds, ...LIDARR_INDEX_READ }),
      ]);
    }
    return buildBulkAlbumTrackData(albums, tracks, files);
  }

  return loadPerAlbumTrackData();
}

function resolveTrackFile(track, fileIndex, album) {
  if (track?.albumId != null && String(track.albumId) !== String(album?.id)) return null;
  const file =
    fileIndex.get(`file:${track?.trackFileId}`) ||
    fileIndex.get(`track:${track?.id}`) ||
    track?.trackFile ||
    track?.file ||
    null;
  if (file?.albumId != null && String(file.albumId) !== String(album?.id)) return null;
  const externalPath =
    track?.path ||
    file?.path ||
    (file?.relativePath && album?.path ? path.join(album.path, file.relativePath) : null);
  if (!externalPath) return null;
  return {
    externalPath,
    localPath: resolveLocalPath(externalPath, getPathMappings("lidarr")),
    file,
  };
}

async function readFileStats(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function upsertLidarrArtist(artist, syncSearch) {
  const artistProviderId = text(artist.foreignArtistId);
  const artistName = text(artist.artistName || artist.name) || "Unknown Artist";
  const artistKey =
    (artistProviderId &&
      buildIdentityKey(isUuid(artistProviderId) ? "mbid" : "lidarr-artist", artistProviderId)) ||
    buildFallbackIdentityKey("lidarr-artist", artist.id, artistName);
  return upsertLibraryArtist({
    identityKey: artistKey,
    mbid: isUuid(artistProviderId) ? artistProviderId : null,
    name: artistName,
    sortName: artist.sortName || null,
    metadata: { ...artist, librarySource: "lidarr" },
    syncSearch,
  });
}

// One Lidarr album, its tracks and those of its files that could be read.
// The caller opens the transaction. Shared by the full scan and by indexing a
// single album, so both write exactly the same rows.
function writeLidarrAlbum({ album, artist, artistRecord, tracks, indexedFiles, scanId, syncSearch }) {
  const seenPaths = [];
  let filesIndexed = 0;
  const artistName = text(artist.artistName || artist.name) || "Unknown Artist";
  const albumProviderId = text(album.foreignAlbumId);
  const albumKey =
    (albumProviderId &&
      buildIdentityKey(
        isUuid(albumProviderId) ? "release-group" : "lidarr-album",
        albumProviderId,
      )) ||
    buildFallbackIdentityKey("lidarr-album", album.id, album.title);
  const albumRecord = upsertLibraryAlbum({
    identityKey: albumKey,
    mbid: isUuid(albumProviderId) ? albumProviderId : null,
    releaseGroupMbid: isUuid(albumProviderId) ? albumProviderId : null,
    artistId: artistRecord.id,
    title: text(album.title) || "Unknown Album",
    albumArtist: artistName,
    releaseDate: album.releaseDate || null,
    metadata: { ...album, librarySource: "lidarr" },
    syncSearch,
  });
  for (const track of tracks || []) {
    const trackProviderId = text(track.foreignRecordingId || track.foreignTrackId);
    const trackKey =
      (trackProviderId &&
        buildIdentityKey(isUuid(trackProviderId) ? "recording" : "lidarr-track", trackProviderId)) ||
      buildFallbackIdentityKey("lidarr-track", albumRecord.id, track.id, track.title);
    const trackRecord = upsertLibraryTrack({
      identityKey: trackKey,
      mbid: isUuid(trackProviderId) ? trackProviderId : null,
      title: text(track.title || track.trackTitle) || "Unknown Track",
      artistName,
      metadata: track,
      syncSearch,
    });
    const trackNumber = Number(track.trackNumber || track.absoluteTrackNumber) || 0;
    linkLibraryAlbumTrack({
      albumId: albumRecord.id,
      trackId: trackRecord.id,
      discNumber: Number(track.mediumNumber || track.discNumber) || 1,
      trackNumber,
      syncSearch,
    });

    const indexedFile = indexedFiles.get(track);
    if (!indexedFile) continue;
    const { resolvedFile, stat } = indexedFile;
    upsertLibraryMediaFile({
      trackId: trackRecord.id,
      albumId: albumRecord.id,
      source: "lidarr",
      path: resolvedFile.localPath,
      format: path.extname(resolvedFile.localPath).slice(1).toLowerCase(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      durationMs: track.duration || resolvedFile.file?.duration || null,
      quality: resolvedFile.file?.mediaInfo || track.mediaInfo || null,
      available: true,
      scanId,
    });
    seenPaths.push(resolvedFile.localPath);
    filesIndexed += 1;
  }
  return { filesIndexed, seenPaths, albumRecord };
}

const asList = (value) =>
  Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : [];

const uniqueIds = (values) => [...new Set((Array.isArray(values) ? values : [])
  .map(Number)
  .filter((value) => Number.isSafeInteger(value) && value > 0))];

// Paths of an indexed album's Lidarr files that are currently available.
const availableLidarrAlbumPaths = (albumRecordId) =>
  db.prepare(
    `SELECT path FROM library_media_files
     WHERE source = 'lidarr' AND available = 1 AND album_id = ?`,
  ).all(albumRecordId).map((row) => row.path);

// Available files of albums or artists Lidarr no longer has, found by the
// Lidarr ids kept in their metadata, with the artists they belong to.
function availablePathsForRemoved({ albumIds, artistIds }) {
  if (!albumIds.length && !artistIds.length) return { paths: [], artistRecordIds: [] };
  const rows = db.prepare(
    `SELECT media.path AS path, album.artist_id AS artist_id
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     JOIN library_media_files AS media
       ON media.album_id = album.id AND media.source = 'lidarr' AND media.available = 1
     WHERE (json_extract(album.metadata_json, '$.librarySource') = 'lidarr'
            AND CAST(json_extract(album.metadata_json, '$.id') AS INTEGER)
              IN (SELECT CAST(value AS INTEGER) FROM json_each(?)))
        OR (json_extract(artist.metadata_json, '$.librarySource') = 'lidarr'
            AND CAST(json_extract(artist.metadata_json, '$.id') AS INTEGER)
              IN (SELECT CAST(value AS INTEGER) FROM json_each(?)))`,
  ).all(JSON.stringify(albumIds), JSON.stringify(artistIds));
  return {
    paths: rows.map((row) => row.path),
    artistRecordIds: [...new Set(rows.map((row) => row.artist_id))],
  };
}

/**
 * Index a few Lidarr albums, or every album of a few artists, without a full
 * scan: what a Lidarr webhook calls for.
 *
 * Every read goes to Lidarr directly and any error is thrown, so a failed read
 * is retried later rather than taken for an album with no files (the client's
 * per-album helpers answer an error with an empty list). An album or artist
 * Lidarr no longer has, which it answers with a 404, has its files marked
 * unavailable, as does any file an album used to list and no longer does.
 */
export async function indexLidarrAlbums({ client, albumIds = [], artistIds = [], syncSearch = true } = {}) {
  if (!client || typeof client.isConfigured !== "function" || !client.isConfigured()) {
    throw new Error("Lidarr is not configured");
  }
  const read = { forceRefresh: true, timeoutMs: LIDARR_INDEX_READ.timeoutMs };
  const albums = new Map();
  const goneAlbumIds = [];
  const goneArtistIds = [];

  for (const artistId of uniqueIds(artistIds)) {
    const artist = await client.request(`/artist/${artistId}`, "GET", null, false, read);
    if (!artist) {
      goneArtistIds.push(artistId);
      continue;
    }
    for (const album of asList(await client.request(`/album?artistId=${artistId}`, "GET", null, false, read))) {
      if (album?.id != null) albums.set(String(album.id), album);
    }
  }
  for (const albumId of uniqueIds(albumIds)) {
    if (albums.has(String(albumId))) continue;
    const album = await client.request(`/album/${albumId}`, "GET", null, false, read);
    if (album?.id != null) albums.set(String(album.id), album);
    else goneAlbumIds.push(albumId);
  }

  const artistById = new Map();
  for (const album of albums.values()) {
    const key = String(album.artistId);
    if (artistById.has(key)) continue;
    const artist = await client.request(`/artist/${album.artistId}`, "GET", null, false, read);
    if (artist) artistById.set(key, artist);
  }

  const trackData = new Map();
  for (const album of albums.values()) {
    const [tracks, files] = await Promise.all([
      client.request(`/track?albumId=${album.id}`, "GET", null, false, read),
      client.request(`/trackfile?albumId=${album.id}`, "GET", null, false, read),
    ]);
    trackData.set(String(album.id), { tracks: asList(tracks), fileIndex: buildFileIndex(asList(files)) });
  }

  const touchedArtistIds = new Set();
  const scan = await withLibraryScan("lidarr-webhook", null, async (scanId) => {
    const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0, albums: albums.size, removedFiles: 0 };
    const indexedFiles = new Map();
    for (const album of albums.values()) {
      const { tracks, fileIndex } = trackData.get(String(album.id));
      for (const track of tracks) {
        const resolvedFile = resolveTrackFile(track, fileIndex, album);
        if (!resolvedFile) continue;
        result.filesSeen += 1;
        const stat = await readFileStats(resolvedFile.localPath);
        if (!stat) {
          result.filesFailed += 1;
          continue;
        }
        indexedFiles.set(track, { resolvedFile, stat });
      }
    }

    for (const album of albums.values()) {
      const artist = artistById.get(String(album.artistId));
      if (!artist) {
        result.filesFailed += 1;
        continue;
      }
      const batch = db.transaction(() => {
        const artistRecord = upsertLidarrArtist(artist, syncSearch);
        return {
          ...writeLidarrAlbum({
            album,
            artist,
            artistRecord,
            tracks: trackData.get(String(album.id)).tracks,
            indexedFiles,
            scanId,
            syncSearch,
          }),
          artistRecordId: artistRecord.id,
        };
      })();
      result.filesIndexed += batch.filesIndexed;
      touchedArtistIds.add(batch.artistRecordId);
      const seen = new Set(batch.seenPaths);
      result.removedFiles += markLibraryMediaFilesUnavailable(
        "lidarr",
        availableLidarrAlbumPaths(batch.albumRecord.id).filter((filePath) => !seen.has(filePath)),
      );
      await new Promise((resolve) => setImmediate(resolve));
    }

    const removed = availablePathsForRemoved({ albumIds: goneAlbumIds, artistIds: goneArtistIds });
    for (const artistRecordId of removed.artistRecordIds) touchedArtistIds.add(artistRecordId);
    result.removedFiles += markLibraryMediaFilesUnavailable("lidarr", removed.paths);
    return result;
  });

  if (touchedArtistIds.size) rebuildLibraryRollupsForArtists([...touchedArtistIds]);
  return { ...scan, goneAlbumIds, goneArtistIds, touchedArtistIds: [...touchedArtistIds] };
}

export async function indexLidarrLibrary({ client, syncSearch = true } = {}) {
  // Both skips below are easy to hit and impossible to see from outside: no
  // scan run is recorded, the job reports success, and the library silently
  // keeps whatever it had. Say which one happened.
  if (!client || typeof client.isConfigured !== "function" || !client.isConfigured()) {
    logger.warn("library", "[LidarrIndex] Skipped: Lidarr is not configured for this process");
    return { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  }

  // The album list is one response covering every album Lidarr knows, so it
  // gets the index's timeout too rather than the interactive default.
  const indexRead = { forceRefresh: true, timeoutMs: LIDARR_INDEX_READ.timeoutMs };
  const [artists, albums, rootFolders] = await Promise.all([
    client.request("/artist", "GET", null, false, indexRead),
    client.getAllAlbums(indexRead),
    client.getRootFolders(),
  ]);
  if (
    Array.isArray(artists) &&
    artists.length === 0 &&
    Array.isArray(albums) &&
    albums.length === 0
  ) {
    logger.warn(
      "library",
      "[LidarrIndex] Skipped: Lidarr returned no artists and no albums."
        + " An open circuit breaker answers this way too, so the library is left as it was.",
    );
    return { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  }
  logger.info(
    "library",
    `[LidarrIndex] Indexing ${Array.isArray(artists) ? artists.length : 0} artists`
      + ` and ${Array.isArray(albums) ? albums.length : 0} albums`,
  );
  const artistById = new Map((Array.isArray(artists) ? artists : []).map((item) => [String(item.id), item]));
  const albumTrackData = await loadAlbumTrackData(
    client,
    albums,
    (Array.isArray(artists) ? artists : []).map((artist) => artist?.id),
  );
  const tracksByAlbumId = new Map();
  const filesByAlbumId = new Map();
  for (const albumData of albumTrackData) {
    if (albumData.albumId) tracksByAlbumId.set(albumData.albumId, albumData.tracks);
    if (albumData.albumId) filesByAlbumId.set(albumData.albumId, buildFileIndex(albumData.files));
  }
  const rootPath = (Array.isArray(rootFolders) ? rootFolders : [])
    .map((folder) => text(folder?.path))
    .filter(Boolean)
    .join(";") || null;
  const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  const tracksEnumerated = albumTrackData.some((albumData) => albumData.tracks.length > 0);

  return withLibraryScan("lidarr", rootPath, async (scanId) => {
    const indexedFiles = new Map();
    const unseenPaths = getAvailableLibraryMediaPaths("lidarr");
    for (const album of Array.isArray(albums) ? albums : []) {
      for (const track of tracksByAlbumId.get(String(album?.id)) || []) {
        const resolvedFile = resolveTrackFile(
          track,
          filesByAlbumId.get(String(album?.id)) || new Map(),
          album,
        );
        if (!resolvedFile) continue;
        result.filesSeen += 1;
        const stat = await readFileStats(resolvedFile.localPath);
        if (!stat) {
          result.filesFailed += 1;
          continue;
        }
        indexedFiles.set(track, { resolvedFile, stat });
      }
    }

    const artistRecordsById = db.transaction(() => {
      const records = new Map();
      for (const artist of artistById.values()) {
        records.set(String(artist.id), upsertLidarrArtist(artist, syncSearch));
      }
      return records;
    })();

    for (const album of Array.isArray(albums) ? albums : []) {
      const artist = artistById.get(String(album?.artistId));
      if (!artist || !album?.id) {
        result.filesFailed += 1;
        continue;
      }
      const batch = db.transaction(() => writeLidarrAlbum({
        album,
        artist,
        artistRecord: artistRecordsById.get(String(artist.id)),
        tracks: tracksByAlbumId.get(String(album.id)) || [],
        indexedFiles,
        scanId,
        syncSearch,
      }))();
      result.filesIndexed += batch.filesIndexed;
      for (const filePath of batch.seenPaths) unseenPaths.delete(filePath);
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (result.filesFailed === 0 && (result.filesIndexed > 0 || tracksEnumerated)) {
      markLibraryMediaFilesUnavailable("lidarr", unseenPaths);
    }
    return result;
  });
}

export { buildFileIndex, resolveTrackFile };
