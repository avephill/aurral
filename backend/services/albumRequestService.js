import { db } from "../config/db-sqlite.js";
import { getRequestedAlbumAvailability } from "./libraryQueryService.js";
import { logger } from "./logger.js";

/**
 * Who asked for which album, and whether it has actually arrived.
 *
 * Every album request is written here as well as to the activity history,
 * because the history is pruned after 30 days and an unfilled request is
 * exactly the kind that grows old. The report joins each request to the
 * library index to say how much of the album is on disk, which is the answer
 * an admin needs when deciding what to buy or rip.
 */

const REPORT_CACHE_MS = 30_000;

const upsertStmt = db.prepare(`
  INSERT INTO album_requests (
    request_key, user_id, username, lidarr_album_id, album_mbid,
    album_name, artist_name, artist_mbid, first_requested_at, last_requested_at
  ) VALUES (
    @key, @userId, @username, @lidarrAlbumId, @albumMbid,
    @albumName, @artistName, @artistMbid, @at, @at
  )
  ON CONFLICT(request_key, user_id) DO UPDATE SET
    username = COALESCE(excluded.username, album_requests.username),
    lidarr_album_id = COALESCE(excluded.lidarr_album_id, album_requests.lidarr_album_id),
    album_mbid = COALESCE(excluded.album_mbid, album_requests.album_mbid),
    album_name = excluded.album_name,
    artist_name = COALESCE(excluded.artist_name, album_requests.artist_name),
    artist_mbid = COALESCE(excluded.artist_mbid, album_requests.artist_mbid),
    first_requested_at = MIN(album_requests.first_requested_at, excluded.first_requested_at),
    last_requested_at = MAX(album_requests.last_requested_at, excluded.last_requested_at)
`);

const text = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

const positiveInteger = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

// The same album asked for twice by one person is one request. Lidarr's album
// id is the firmest key, then the MusicBrainz id, then the names.
const requestKey = ({ lidarrAlbumId, albumMbid, albumName, artistName }) => {
  if (lidarrAlbumId) return `lidarr:${lidarrAlbumId}`;
  if (albumMbid) return `mbid:${albumMbid}`;
  return `name:${String(artistName || "").toLowerCase()}|${String(albumName || "").toLowerCase()}`;
};

export function recordAlbumRequest({
  user = null,
  userId = user?.id ?? null,
  username = user?.username ?? null,
  lidarrAlbumId = null,
  albumMbid = null,
  albumName,
  artistName = null,
  artistMbid = null,
  at = Date.now(),
} = {}) {
  const row = {
    userId: positiveInteger(userId),
    username: text(username),
    lidarrAlbumId: positiveInteger(lidarrAlbumId),
    albumMbid: text(albumMbid),
    albumName: text(albumName) || "Album",
    artistName: text(artistName),
    artistMbid: text(artistMbid),
    at: Number(at) || Date.now(),
  };
  try {
    upsertStmt.run({ ...row, key: requestKey(row) });
    reportCache = null;
  } catch (error) {
    logger.warn("library", `[Requests] Could not record the request for ${row.albumName}: ${error.message}`);
  }
}

let backfilled = false;

// Requests made before this table existed are still in the activity history
// for up to 30 days. Copy them in once; the upsert makes repeats harmless.
function backfillFromHistory() {
  if (backfilled) return;
  backfilled = true;
  const rows = db.prepare(
    "SELECT metadata, created_at FROM aurral_history WHERE kind = 'album_requested'",
  ).all();
  for (const row of rows) {
    let metadata = {};
    try {
      metadata = JSON.parse(row.metadata || "{}") || {};
    } catch {}
    recordAlbumRequest({
      userId: metadata.userId,
      username: metadata.username,
      lidarrAlbumId: metadata.albumId,
      albumMbid: metadata.albumMbid,
      albumName: metadata.albumName,
      artistName: metadata.artistName,
      artistMbid: metadata.artistMbid,
      at: row.created_at,
    });
  }
}

// What happened in Lidarr most recently for each requested album (Searching,
// Failed and so on), from the activity history while it still has it.
function latestActivityByLidarrAlbumId() {
  const rows = db.prepare(
    `SELECT status, status_label, metadata FROM aurral_history
     WHERE kind = 'album_requested' ORDER BY created_at DESC`,
  ).all();
  const byId = new Map();
  for (const row of rows) {
    let metadata = {};
    try {
      metadata = JSON.parse(row.metadata || "{}") || {};
    } catch {}
    const id = positiveInteger(metadata.albumId);
    if (id && !byId.has(String(id))) {
      byId.set(String(id), { status: row.status, label: row.status_label || null });
    }
  }
  return byId;
}

function availabilityFor(match) {
  if (!match) {
    return { status: "not_indexed", label: "Not in library index", trackCount: 0, availableTrackCount: 0 };
  }
  const { trackCount, availableTrackCount } = match;
  if (trackCount > 0 && availableTrackCount >= trackCount) {
    return { status: "complete", label: "On disk", ...match };
  }
  if (availableTrackCount > 0) {
    return { status: "partial", label: `${availableTrackCount} of ${trackCount} on disk`, ...match };
  }
  return { status: "missing", label: "Not on disk", ...match };
}

let reportCache = null;

/**
 * Recent album requests, newest first, each with who asked, whether they are
 * an admin, and how much of the album is on disk.
 */
export function getAlbumRequestReport({ limit = 500 } = {}) {
  if (reportCache && Date.now() - reportCache.at < REPORT_CACHE_MS) return reportCache.data;
  backfillFromHistory();
  const rows = db.prepare(
    "SELECT * FROM album_requests ORDER BY last_requested_at DESC LIMIT ?",
  ).all(Math.max(1, Math.min(2000, Number(limit) || 500)));
  const roles = new Map(
    db.prepare("SELECT id, role FROM users").all().map((user) => [Number(user.id), user.role]),
  );
  const { byLidarrId, byMbid } = getRequestedAlbumAvailability({
    lidarrAlbumIds: rows.map((row) => row.lidarr_album_id).filter(Boolean),
    mbids: rows.map((row) => row.album_mbid).filter(Boolean),
  });
  const activity = latestActivityByLidarrAlbumId();

  const items = rows.map((row) => {
    const match =
      (row.lidarr_album_id && byLidarrId.get(String(row.lidarr_album_id))) ||
      (row.album_mbid && byMbid.get(String(row.album_mbid))) ||
      null;
    return {
      id: row.id,
      albumName: row.album_name,
      artistName: row.artist_name,
      artistMbid: row.artist_mbid,
      albumMbid: row.album_mbid,
      lidarrAlbumId: row.lidarr_album_id,
      requestedBy: {
        userId: row.user_id,
        username: row.username,
        isAdmin: roles.get(Number(row.user_id)) === "admin",
      },
      firstRequestedAt: row.first_requested_at,
      lastRequestedAt: row.last_requested_at,
      availability: availabilityFor(match),
      activity: (row.lidarr_album_id && activity.get(String(row.lidarr_album_id))) || null,
    };
  });
  const data = { items, generatedAt: Date.now() };
  reportCache = { data, at: Date.now() };
  return data;
}

export function resetAlbumRequestReport() {
  reportCache = null;
  backfilled = false;
}
