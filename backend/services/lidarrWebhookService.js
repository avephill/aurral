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

let sweepTimer = null;

// Picks up events a restart left waiting and retries failed ones when due.
export function startLidarrWebhookProcessor() {
  if (sweepTimer) return;
  const sweep = () =>
    processLidarrWebhookEvents().catch((error) => {
      logger.warn("library", `[LidarrWebhook] Processing failed: ${error.message}`);
    });
  sweep();
  sweepTimer = setInterval(sweep, SWEEP_MS);
  sweepTimer.unref?.();
}

export function stopLidarrWebhookProcessor() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
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
  return {
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
