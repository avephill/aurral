import { db } from "../config/db-sqlite.js";
import { getRequestedAlbumAvailability } from "./libraryQueryService.js";
import { logger } from "./logger.js";

/**
 * Who asked for which album, and whether it has actually arrived.
 *
 * Every album request is written here as well as to the activity history,
 * because the history is pruned after 30 days and an unfilled request is
 * exactly the kind that grows old. The report says how much of each album is
 * on disk. Lidarr is asked first, since it is what actually holds the files;
 * Psalter's library index only catches up at the next scan, and an album
 * added to Lidarr since then is not in it at all. The index answers when
 * Lidarr cannot.
 */

const REPORT_CACHE_MS = 30_000;
const LIDARR_CONCURRENCY = 4;

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

// ---------------------------------------------------------------- how many a day

// Each album asked for sends the downloaders looking and costs disk, so a
// person may ask for so many in a day. An admin sets the number per person;
// unset means this default. Admins have no limit.
export const DEFAULT_DAILY_ALBUM_REQUESTS = 3;
// Stored in users.album_request_limit to mean no limit for that person.
export const NO_ALBUM_REQUEST_LIMIT = -1;
// A rolling day, so a limit does not reset at a midnight nobody agreed on.
const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many albums this person may ask for in a day; null for no limit. */
export function dailyAlbumRequestLimit(user) {
  if (!user) return 0;
  if (user.role === "admin") return null;
  const row = db.prepare("SELECT album_request_limit FROM users WHERE id = ?").get(Number(user.id));
  const value = row?.album_request_limit;
  if (value === null || value === undefined) return DEFAULT_DAILY_ALBUM_REQUESTS;
  return value < 0 ? null : value;
}

/**
 * Where someone stands: their limit, how many they have asked for in the last
 * day, how many are left, and when the next one frees up if none are. A
 * request counts from when the album was first asked for, so asking again for
 * the same one - after a failed download, say - costs nothing.
 */
export function albumRequestAllowance(user, now = Date.now()) {
  const limit = dailyAlbumRequestLimit(user);
  if (limit === null) return { limit: null, used: 0, remaining: null, nextAt: null };
  const times = db.prepare(`
    SELECT first_requested_at AS at FROM album_requests
    WHERE user_id = ? AND first_requested_at > ? ORDER BY first_requested_at ASC
  `).all(Number(user.id), now - REQUEST_WINDOW_MS).map((row) => row.at);
  const used = times.length;
  const remaining = Math.max(0, limit - used);
  // One frees up when enough of the oldest have left the day to bring the
  // count under the limit. With a limit of none, nothing ever frees up.
  const nextAt = remaining === 0 && limit > 0 ? times[used - limit] + REQUEST_WINDOW_MS : null;
  return { limit, used, remaining, nextAt };
}

function alreadyRequested(user, { albumMbid = null, lidarrAlbumId = null } = {}) {
  const mbid = text(albumMbid);
  const lidarrId = positiveInteger(lidarrAlbumId);
  if (!mbid && !lidarrId) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM album_requests WHERE user_id = ?
      AND ((? IS NOT NULL AND album_mbid = ?) OR (? IS NOT NULL AND lidarr_album_id = ?))
    LIMIT 1
  `).get(Number(user?.id), mbid, mbid, lidarrId, lidarrId));
}

const inWords = (ms) => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
};

/**
 * Refuse a request that would go over the person's limit. The error carries
 * status 429, a sentence to show them, and when they can ask again.
 */
export function assertAlbumRequestAllowed(user, album = {}, now = Date.now()) {
  if (alreadyRequested(user, album)) return null;
  const allowance = albumRequestAllowance(user, now);
  if (allowance.limit === null || allowance.remaining > 0) return allowance;
  const error = new Error(
    allowance.limit === 0
      ? "Asking for albums is switched off for your account."
      : `You can ask for ${allowance.limit} album${allowance.limit === 1 ? "" : "s"} a day, and you have. ` +
        `You can ask for another in about ${inWords(allowance.nextAt - now)}.`,
  );
  error.statusCode = 429;
  error.code = "album-request-limit";
  error.allowance = allowance;
  throw error;
}

/** The body to answer a refused request with. */
export function albumRequestLimitResponse(error) {
  return {
    error: error.message,
    message: error.message,
    code: error.code,
    allowance: error.allowance,
  };
}

/**
 * Hide a request from the report without touching Lidarr. If the same person
 * asks for the album again later, the request comes back.
 */
export function dismissAlbumRequest(id) {
  const requestId = positiveInteger(id);
  if (!requestId) return false;
  const result = db.prepare("UPDATE album_requests SET dismissed_at = ? WHERE id = ?").run(Date.now(), requestId);
  reportCache = null;
  return result.changes > 0;
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
    return { status: "not_indexed", label: "Not found", trackCount: 0, availableTrackCount: 0 };
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

// Lidarr's own count of files for each album, read a few at a time. A request
// Lidarr cannot answer for (album removed, Lidarr down) is simply left out,
// and the library index answers for it instead.
async function lidarrAvailability(lidarrClient, rows) {
  const byRowId = new Map();
  if (!rows.length || !lidarrClient?.isConfigured?.()) return byRowId;
  const queue = [...rows];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const album = row.lidarr_album_id
          ? await lidarrClient.getAlbum(row.lidarr_album_id)
          : row.album_mbid
            ? await lidarrClient.getAlbumByMbid(row.album_mbid, { forceRefresh: true })
            : null;
        const statistics = album?.statistics;
        if (!album || !statistics) continue;
        byRowId.set(row.id, {
          source: "lidarr",
          trackCount: Number(statistics.trackCount) || 0,
          availableTrackCount: Number(statistics.trackFileCount) || 0,
          monitored: album.monitored === true,
        });
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIDARR_CONCURRENCY, queue.length) }, worker));
  return byRowId;
}

let reportCache = null;

/**
 * Recent album requests, newest first, each with who asked, whether they are
 * an admin, and how much of the album is on disk. `refresh` skips the kept
 * copy, for the Refresh button.
 */
export async function getAlbumRequestReport({ limit = 500, refresh = false, lidarrClient = null } = {}) {
  if (!refresh && reportCache && Date.now() - reportCache.at < REPORT_CACHE_MS) return reportCache.data;
  backfillFromHistory();
  const rows = db.prepare(
    `SELECT * FROM album_requests
     WHERE dismissed_at IS NULL OR last_requested_at > dismissed_at
     ORDER BY last_requested_at DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(2000, Number(limit) || 500)));
  const roles = new Map(
    db.prepare("SELECT id, role FROM users").all().map((user) => [Number(user.id), user.role]),
  );
  const { byLidarrId, byMbid } = getRequestedAlbumAvailability({
    lidarrAlbumIds: rows.map((row) => row.lidarr_album_id).filter(Boolean),
    mbids: rows.map((row) => row.album_mbid).filter(Boolean),
  });
  const indexMatch = (row) =>
    (row.lidarr_album_id && byLidarrId.get(String(row.lidarr_album_id))) ||
    (row.album_mbid && byMbid.get(String(row.album_mbid))) ||
    null;
  // Albums the index already shows complete are done; ask Lidarr about the rest.
  const fromLidarr = await lidarrAvailability(
    lidarrClient,
    rows.filter((row) => availabilityFor(indexMatch(row)).status !== "complete"),
  );
  const activity = latestActivityByLidarrAlbumId();

  const items = rows.map((row) => {
    const availability = availabilityFor(fromLidarr.get(row.id) || indexMatch(row));
    const lastActivity = (row.lidarr_album_id && activity.get(String(row.lidarr_album_id))) || null;
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
      availability,
      // The history's "Searching" goes stale once files arrive; the files win.
      activity: availability.status === "complete"
        ? { status: "completed", label: "Downloaded" }
        : lastActivity,
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
