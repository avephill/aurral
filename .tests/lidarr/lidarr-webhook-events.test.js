import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// Lidarr webhook events are recorded before anything is done with them, and a
// failure leaves them waiting to be retried rather than lost.

const [isolatedState, { db }, events] = await setupIsolatedBackend(
  "lidarr-webhook-events",
  "backend/config/db-sqlite.js",
  "backend/services/lidarrWebhookService.js",
);

test.beforeEach(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM lidarr_webhook_events").run();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

const row = (id) => db.prepare("SELECT * FROM lidarr_webhook_events WHERE id = ?").get(id);

test("each event names the albums or artists to re-read, or nothing", () => {
  const plan = events.planLidarrWebhookEvent;
  assert.deepEqual(plan("Download", { artist: { id: 7 }, album: { id: 8 } }), { albumIds: [8], artistIds: [] });
  assert.deepEqual(plan("Download", { artist: { id: 7 } }), { albumIds: [], artistIds: [7] });
  assert.deepEqual(plan("AlbumDelete", { album: { id: 8 } }), { albumIds: [8], artistIds: [] });
  for (const type of ["Rename", "Retag", "ArtistAdd", "ArtistDelete"]) {
    assert.deepEqual(plan(type, { artist: { id: 7 } }), { albumIds: [], artistIds: [7] }, type);
  }
  for (const type of ["Test", "Grab", "Health", "ApplicationUpdate", "DownloadFailure"]) {
    assert.equal(plan(type, { artist: { id: 7 }, album: { id: 8 } }), null, type);
  }
});

test("events to act on wait as pending; the rest are recorded as ignored", () => {
  const download = events.recordLidarrWebhookEvent({ eventType: "Download", album: { id: 8 } });
  const test = events.recordLidarrWebhookEvent({ eventType: "Test" });
  assert.equal(row(download.id).status, "pending");
  assert.equal(row(test.id).status, "ignored");
});

test("a failed index is retried later, and succeeds then", async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const { id } = events.recordLidarrWebhookEvent({ eventType: "Download", album: { id: 8 } }, { now: clock });

  let calls = 0;
  const failingOnce = async (plan) => {
    calls += 1;
    assert.deepEqual(plan, { albumIds: [8], artistIds: [] });
    if (calls === 1) throw new Error("Lidarr is down");
    return { changed: true };
  };
  const seen = [];
  const afterIndex = async (outcome) => seen.push(outcome);

  await events.processLidarrWebhookEvents({ indexAlbums: failingOnce, afterIndex, now });
  assert.equal(row(id).status, "pending");
  assert.equal(row(id).attempts, 1);
  assert.equal(row(id).error, "Lidarr is down");
  assert.ok(row(id).next_attempt_at > clock, "retry waits");

  await events.processLidarrWebhookEvents({ indexAlbums: failingOnce, afterIndex, now });
  assert.equal(calls, 1, "not retried before it is due");

  clock = row(id).next_attempt_at;
  await events.processLidarrWebhookEvents({ indexAlbums: failingOnce, afterIndex, now });
  assert.equal(row(id).status, "done");
  assert.equal(row(id).error, null);
  assert.deepEqual(seen, [{ changed: true }]);
});

test("an event that keeps failing is given up on and shows in the status", async () => {
  let clock = 5_000_000;
  const now = () => clock;
  const { id } = events.recordLidarrWebhookEvent({ eventType: "Rename", artist: { id: 7 } }, { now: clock });
  const alwaysFails = async () => {
    throw new Error("still down");
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await events.processLidarrWebhookEvents({ indexAlbums: alwaysFails, afterIndex: null, now });
    const current = row(id);
    if (current.next_attempt_at) clock = current.next_attempt_at;
  }
  assert.equal(row(id).status, "failed");
  assert.equal(row(id).attempts, 8);

  const status = events.getLidarrWebhookStatus({ now: clock });
  assert.equal(status.lastEvent.type, "Rename");
  assert.equal(status.failed, 1);
  assert.equal(status.pending, 0);
  assert.equal(status.lastError.status, "failed");
  assert.equal(status.lastError.message, "still down");
});

test("the status reports recent traffic and what was last indexed", async () => {
  const clock = 9_000_000;
  events.recordLidarrWebhookEvent({ eventType: "Test" }, { now: clock - 2 * 24 * 60 * 60 * 1000 });
  events.recordLidarrWebhookEvent({ eventType: "Download", album: { id: 8 } }, { now: clock - 1000 });
  await events.processLidarrWebhookEvents({ indexAlbums: async () => ({}), afterIndex: null, now: () => clock });
  const status = events.getLidarrWebhookStatus({ now: clock });
  assert.equal(status.lastDay, 1, "only the event from the last day counts");
  assert.equal(status.lastIndexed.type, "Download");
  assert.equal(status.lastError, null);
});

test("the history check queues only the albums the webhook missed, and counts them", async () => {
  db.prepare("DELETE FROM settings WHERE key = 'lidarrWebhookCatchUp'").run();
  assert.deepEqual(
    events.planLidarrWebhookEvent("CatchUp", { albumIds: [9, "x", 10] }),
    { albumIds: [9, 10], artistIds: [] },
  );

  const minute = 60 * 1000;
  const clock = 20_000_000;
  let historyReads = 0;
  const client = {
    request: async (endpoint) => {
      historyReads += 1;
      assert.match(endpoint, /^\/history\/since\?date=/);
      return [
        { eventType: "trackFileImported", albumId: 8, artistId: 7, date: new Date(clock - 9 * minute).toISOString() },
        { eventType: "trackFileImported", albumId: 9, artistId: 5, date: new Date(clock - 8 * minute).toISOString() },
        { eventType: "grabbed", albumId: 10, artistId: 5, date: new Date(clock - 8 * minute).toISOString() },
        { eventType: "trackFileImported", albumId: 11, artistId: 5, date: new Date(clock - 30 * 1000).toISOString() },
      ];
    },
  };

  const first = await events.catchUpFromLidarrHistory({ client, now: clock - 20 * minute });
  assert.equal(first.firstRun, true);
  assert.equal(historyReads, 0, "the first run only sets where to start");

  // The webhook told us about album 8, but not album 9.
  events.recordLidarrWebhookEvent({ eventType: "Download", album: { id: 8 } }, { now: clock - 9 * minute });

  const second = await events.catchUpFromLidarrHistory({ client, now: clock });
  assert.deepEqual(second, { albums: 2, missed: 1 }, "grabs change no files; the last minute waits for next time");
  const queued = db.prepare("SELECT payload, status FROM lidarr_webhook_events WHERE event_type = 'CatchUp'").all();
  assert.equal(queued.length, 1);
  assert.deepEqual(JSON.parse(queued[0].payload).albumIds, [9]);
  assert.equal(queued[0].status, "pending");

  const status = events.getLidarrWebhookStatus({ now: clock });
  assert.equal(status.catchUp.lastMissed, 1);
  assert.equal(status.catchUp.totalMissed, 1);
  assert.equal(status.catchUp.lastMissedAt, clock);
});

test("a failed history read leaves the starting point for the next check", async () => {
  db.prepare("DELETE FROM settings WHERE key = 'lidarrWebhookCatchUp'").run();
  const clock = 40_000_000;
  const down = { request: async () => { throw new Error("Lidarr is down"); } };
  await events.catchUpFromLidarrHistory({ client: down, now: clock - 30 * 60 * 1000 });
  await assert.rejects(events.catchUpFromLidarrHistory({ client: down, now: clock }), /down/);
  let askedFrom = null;
  const up = { request: async (endpoint) => { askedFrom = decodeURIComponent(endpoint.split("date=")[1]); return []; } };
  await events.catchUpFromLidarrHistory({ client: up, now: clock });
  assert.equal(askedFrom, new Date(clock - 30 * 60 * 1000 - 2 * 60 * 1000).toISOString(), "the same span is checked again");
});
