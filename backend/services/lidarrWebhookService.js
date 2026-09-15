import { db } from "../config/db-sqlite.js";
import { logger } from "./logger.js";

/**
 * Lidarr webhook events: written down first, acted on after.
 *
 * The library relies on these events to pick up what Lidarr imports, renames
 * and deletes, so none may be lost. The webhook handler only records the
 * event; this module indexes the albums or artists it names, and a failure
 * (Lidarr down, a timeout) leaves the event pending with a later retry time
 * instead of dropping it. Events waiting when the server stops are picked up
 * when it starts again.
 */

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 5000;
const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const SWEEP_MS = 60_000;
const BATCH = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const positiveId = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

/**
 * What an event asks the library to re-read, or null when it asks for nothing.
 * Deletions are re-read too: Lidarr then answers that the album or artist is
 * gone, and its files are marked unavailable.
 */
export function planLidarrWebhookEvent(eventType, payload = {}) {
  const type = String(eventType || "").trim().toLowerCase();
  const artist = payload?.artist || payload?.Artist || {};
  const album = payload?.album || payload?.Album || {};
  const artistId = positiveId(artist.id ?? artist.Id);
  const albumId = positiveId(album.id ?? album.Id);
  const plan = { albumIds: [], artistIds: [] };
  switch (type) {
    case "download":
      if (albumId) plan.albumIds.push(albumId);
      else if (artistId) plan.artistIds.push(artistId);
      break;
    case "albumdelete":
      if (albumId) plan.albumIds.push(albumId);
      break;
    case "rename":
    case "retag":
    case "artistadd":
    case "artistdelete":
      if (artistId) plan.artistIds.push(artistId);
      break;
    // Written by the history check below, for albums the webhook missed.
    case "catchup":
      for (const id of Array.isArray(payload?.albumIds) ? payload.albumIds : []) {
        if (positiveId(id)) plan.albumIds.push(positiveId(id));
      }
      break;
    default:
      return null;
  }
  return plan.albumIds.length || plan.artistIds.length ? plan : null;
}

export function recordLidarrWebhookEvent(body = {}, { now = Date.now() } = {}) {
  const eventType = String(body?.eventType || body?.EventType || "").trim() || "Unknown";
  const plan = planLidarrWebhookEvent(eventType, body);
  const result = db.prepare(
    `INSERT INTO lidarr_webhook_events (event_type, received_at, payload, status, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ).run(eventType, now, JSON.stringify(body ?? {}), plan ? "pending" : "ignored", plan ? now : null);
  db.prepare("DELETE FROM lidarr_webhook_events WHERE received_at < ?").run(now - RETENTION_MS);
  db.prepare(
    `DELETE FROM lidarr_webhook_events
     WHERE id <= (SELECT id FROM lidarr_webhook_events ORDER BY id DESC LIMIT 1 OFFSET ?)`,
  ).run(MAX_ROWS);
  return { id: Number(result.lastInsertRowid), plan };
}

async function defaultIndexAlbums(plan) {
  const [{ lidarrClient }, { indexLidarrAlbums }] = await Promise.all([
    import("./lidarrClient.js"),
    import("./libraryLidarrIndexer.js"),
  ]);
  return indexLidarrAlbums({ client: lidarrClient, ...plan });
}

// After an album is indexed, the pages built on the library need to know:
// kept homes and the Requests report are stale, and open pages refresh.
async function defaultAfterIndex(outcome) {
  if (!outcome?.changed && !outcome?.removedFiles) return;
  const [{ invalidateLibraryHome }, { resetAlbumRequestReport }, { websocketService }] = await Promise.all([
    import("./libraryHomeService.js"),
    import("./albumRequestService.js"),
    import("./websocketService.js"),
  ]);
  invalidateLibraryHome();
  resetAlbumRequestReport();
  websocketService.broadcast("library", { type: "library_scan_completed" });
  // A ripped or bought album may be songs someone's old library was waiting
  // for; linking them brings their tags and playlists along.
  const { scheduleSongRecordRelink } = await import("./songRecordService.js");
  scheduleSongRecordRelink();
}

let running = null;
let again = false;

async function drain({ indexAlbums, afterIndex, now }) {
  const due = db.prepare(
    `SELECT * FROM lidarr_webhook_events
     WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY id LIMIT ?`,
  ).all(now(), BATCH);
  for (const row of due) {
    let payload = {};
    try {
      payload = JSON.parse(row.payload || "{}") || {};
    } catch {}
    const plan = planLidarrWebhookEvent(row.event_type, payload);
    if (!plan) {
      db.prepare("UPDATE lidarr_webhook_events SET status = 'ignored', processed_at = ? WHERE id = ?")
        .run(now(), row.id);
      continue;
    }
    try {
      const outcome = await indexAlbums(plan);
      await afterIndex?.(outcome, row);
      db.prepare(
        `UPDATE lidarr_webhook_events
         SET status = 'done', attempts = attempts + 1, processed_at = ?, error = NULL
         WHERE id = ?`,
      ).run(now(), row.id);
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const retryAt = now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
      db.prepare(
        `UPDATE lidarr_webhook_events
         SET status = ?, attempts = ?, next_attempt_at = ?, error = ?
         WHERE id = ?`,
      ).run(failed ? "failed" : "pending", attempts, failed ? null : retryAt, String(error?.message || error), row.id);
      logger.warn(
        "library",
        `[LidarrWebhook] ${row.event_type} event ${row.id} ${failed ? "gave up after " + attempts + " attempts" : "will retry"}: ${error?.message || error}`,
      );
    }
  }
  if (due.length === BATCH) again = true;
}

/**
 * Act on every event that is due. Only one pass runs at a time; a call made
 * during a pass makes that pass go round once more.
 */
export function processLidarrWebhookEvents({
  indexAlbums = defaultIndexAlbums,
  afterIndex = defaultAfterIndex,
  now = Date.now,
} = {}) {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await drain({ indexAlbums, afterIndex, now });
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

// ---------------------------------------------------------------------------
// The check behind the webhook: every 15 minutes, ask Lidarr's history what
// changed since the last check. Albums the webhook already reported were
// indexed then; any it did not are queued here as a CatchUp event, through
// the same retrying queue, and counted, because a webhook that misses events
// needs fixing and should be seen.
// ---------------------------------------------------------------------------

const CATCH_UP_MS = 15 * 60 * 1000;
// Recent history is left to the next check, so an event whose webhook is still
// on its way is not counted as missed.
const CATCH_UP_GRACE_MS = 2 * 60 * 1000;
const CATCH_UP_STATE_KEY = "lidarrWebhookCatchUp";
const CATCH_UP_TIMEOUT_MS = 2 * 60 * 1000;

// Lidarr history event types that change which files an album has, by name
// and by number (EntityHistoryEventType).
const FILE_CHANGING_HISTORY_EVENTS = new Set([
  "artistfolderimported", "2",
  "trackfileimported", "3",
  "trackfiledeleted", "5",
  "trackfilerenamed", "6",
  "albumimportincomplete", "7",
  "downloadimported", "8",
  "trackfileretagged", "9",
]);

function readCatchUpState() {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CATCH_UP_STATE_KEY);
  try {
    return JSON.parse(row?.value || "null");
  } catch {
    return null;
  }
}

function writeCatchUpState(state) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(CATCH_UP_STATE_KEY, JSON.stringify(state));
}

// Albums and artists the webhook named between two times.
function webhookCoverage(from, to) {
  const albumIds = new Set();
  const artistIds = new Set();
  const rows = db.prepare(
    "SELECT event_type, payload FROM lidarr_webhook_events WHERE received_at >= ? AND received_at <= ?",
  ).all(from, to);
  for (const row of rows) {
    let payload = {};
    try {
      payload = JSON.parse(row.payload || "{}") || {};
    } catch {}
    const plan = planLidarrWebhookEvent(row.event_type, payload);
    for (const id of plan?.albumIds || []) albumIds.add(id);
    for (const id of plan?.artistIds || []) artistIds.add(id);
  }
  return { albumIds, artistIds };
}

/**
 * One history check. The first ever run only sets the starting point, since
 * the nightly full scan covers everything before it. A failed history read
 * throws and leaves the starting point where it was, so the next check covers
 * the same span.
 */
export async function catchUpFromLidarrHistory({ client, now = Date.now() } = {}) {
  const state = readCatchUpState();
  const until = now - CATCH_UP_GRACE_MS;
  if (!state?.checkpoint) {
    writeCatchUpState({ checkpoint: until, lastRunAt: now, lastAlbums: 0, lastMissed: 0, totalMissed: 0 });
    return { firstRun: true, albums: 0, missed: 0 };
  }
  if (until <= state.checkpoint) return { skipped: true, albums: 0, missed: 0 };

  const records = await client.request(
    `/history/since?date=${encodeURIComponent(new Date(state.checkpoint).toISOString())}`,
    "GET",
    null,
    false,
    { forceRefresh: true, timeoutMs: CATCH_UP_TIMEOUT_MS },
  );
  const changed = (Array.isArray(records) ? records : []).filter((record) => {
    const at = Date.parse(record?.date);
    return (
      FILE_CHANGING_HISTORY_EVENTS.has(String(record?.eventType ?? "").toLowerCase()) &&
      positiveId(record?.albumId) &&
      Number.isFinite(at) &&
      at > state.checkpoint &&
      at <= until
    );
  });

  // Webhook events can arrive a little after Lidarr writes its history.
  const coverage = webhookCoverage(state.checkpoint, now);
  const albums = new Set();
  const missed = new Set();
  for (const record of changed) {
    const albumId = positiveId(record.albumId);
    albums.add(albumId);
    if (!coverage.albumIds.has(albumId) && !coverage.artistIds.has(positiveId(record.artistId))) {
      missed.add(albumId);
    }
  }
  if (missed.size) {
    recordLidarrWebhookEvent({ eventType: "CatchUp", albumIds: [...missed] }, { now });
    logger.warn(
      "library",
      `[LidarrWebhook] History check found ${missed.size} album(s) the webhook did not report; indexing them now`,
    );
  }
  writeCatchUpState({
    checkpoint: until,
    lastRunAt: now,
    lastAlbums: albums.size,
    lastMissed: missed.size,
    totalMissed: (Number(state.totalMissed) || 0) + missed.size,
    lastMissedAt: missed.size ? now : state.lastMissedAt || null,
  });
  return { albums: albums.size, missed: missed.size };
}

async function runCatchUp() {
  const { lidarrClient } = await import("./lidarrClient.js");
  if (!lidarrClient.isConfigured()) return;
  const result = await catchUpFromLidarrHistory({ client: lidarrClient });
  if (result.missed) await processLidarrWebhookEvents();
}

// The full index, once a night, for what neither the webhook nor Lidarr's
// history reports: files changed outside Lidarr, and drift.
const FULL_SCAN_HOUR = (() => {
  const hour = Number.parseInt(process.env.LIBRARY_FULL_SCAN_HOUR ?? "4", 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 4;
})();

function msUntilHour(hour, from = new Date()) {
  const next = new Date(from);
  next.setHours(hour, 0, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next - from;
}

let sweepTimer = null;
let catchUpTimer = null;
let nightlyTimer = null;

function scheduleNightlyScan() {
  nightlyTimer = setTimeout(async () => {
    try {
      const { scheduleLibraryScan } = await import("./libraryScanWorker.js");
      scheduleLibraryScan({ includeLidarr: true });
      logger.info("library", "[Library] Nightly full scan queued");
      // After the scan has had time to finish: link anything it found, then
      // rebuild switched-on smart playlists against fresh ratings.
      const { scheduleSongRecordRelink } = await import("./songRecordService.js");
      scheduleSongRecordRelink({ delayMs: 45 * 60 * 1000 });
    } catch (error) {
      logger.warn("library", `[Library] Nightly full scan could not be queued: ${error.message}`);
    } finally {
      scheduleNightlyScan();
    }
  }, msUntilHour(FULL_SCAN_HOUR));
  nightlyTimer.unref?.();
}

// Picks up events a restart left waiting, retries failed ones when due, runs
// the 15-minute history check and queues the nightly full scan.
export function startLidarrWebhookProcessor() {
  if (sweepTimer) return;
  const sweep = () =>
    processLidarrWebhookEvents().catch((error) => {
      logger.warn("library", `[LidarrWebhook] Processing failed: ${error.message}`);
    });
  sweep();
  sweepTimer = setInterval(sweep, SWEEP_MS);
  sweepTimer.unref?.();

  const catchUp = () =>
    runCatchUp().catch((error) => {
      logger.warn("library", `[LidarrWebhook] History check failed, will try again: ${error.message}`);
    });
  catchUp();
  catchUpTimer = setInterval(catchUp, CATCH_UP_MS);
  catchUpTimer.unref?.();

  scheduleNightlyScan();
}

export function stopLidarrWebhookProcessor() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (catchUpTimer) clearInterval(catchUpTimer);
  if (nightlyTimer) clearTimeout(nightlyTimer);
  sweepTimer = null;
  catchUpTimer = null;
  nightlyTimer = null;
}

/** Whether the webhook is arriving and being acted on, for Settings. */
export function getLidarrWebhookStatus({ now = Date.now() } = {}) {
  const last = db.prepare(
    "SELECT event_type, received_at FROM lidarr_webhook_events ORDER BY id DESC LIMIT 1",
  ).get();
  const lastIndexed = db.prepare(
    `SELECT event_type, processed_at FROM lidarr_webhook_events
     WHERE status = 'done' ORDER BY processed_at DESC LIMIT 1`,
  ).get();
  const counts = db.prepare(
    `SELECT
       SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS last_day,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM lidarr_webhook_events`,
  ).get(now - DAY_MS);
  const lastError = db.prepare(
    `SELECT event_type, status, error, received_at FROM lidarr_webhook_events
     WHERE error IS NOT NULL AND status IN ('pending', 'failed')
     ORDER BY id DESC LIMIT 1`,
  ).get();
  const catchUp = readCatchUpState();
  return {
    catchUp: catchUp?.lastRunAt
      ? {
          lastRunAt: catchUp.lastRunAt,
          lastMissed: Number(catchUp.lastMissed) || 0,
          totalMissed: Number(catchUp.totalMissed) || 0,
          lastMissedAt: catchUp.lastMissedAt || null,
        }
      : null,
    lastEvent: last ? { type: last.event_type, receivedAt: last.received_at } : null,
    lastIndexed: lastIndexed ? { type: lastIndexed.event_type, processedAt: lastIndexed.processed_at } : null,
    lastDay: Number(counts?.last_day) || 0,
    pending: Number(counts?.pending) || 0,
    failed: Number(counts?.failed) || 0,
    lastError: lastError
      ? { type: lastError.event_type, status: lastError.status, message: lastError.error, receivedAt: lastError.received_at }
      : null,
  };
}
