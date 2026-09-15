import assert from "node:assert/strict";
import test from "node:test";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, history, webhook, auth] = await setupIsolatedBackend(
  "lidarr-webhook",
  "backend/config/db-sqlite.js",
  "backend/services/aurralHistoryService.js",
  "backend/routes/lidarrWebhook.js",
  "backend/middleware/auth.js",
);

const { upsertAurralHistory } = history;
const { handleLidarrWebhook, requireLidarrWebhookKey } = webhook;

function createResponse() {
  const result = { statusCode: 200, body: undefined, ended: false };
  return {
    result,
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
    end() {
      result.ended = true;
      return this;
    },
  };
}

test.beforeEach(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM aurral_history").run();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

const requestSearching = (metadata) =>
  upsertAurralHistory({
    referenceId: "42",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata,
  });

test("Lidarr Download webhook marks the matching request available", () => {
  requestSearching({
    albumId: 42,
    albumName: "Blue Train",
    artistName: "John Coltrane",
    artistMbid: "artist-mbid",
    userId: 7,
    username: "alice",
  });

  const response = createResponse();
  handleLidarrWebhook(
    {
      body: {
        eventType: "Download",
        album: {
          id: 42,
          title: "Blue Train",
          artist: {
            artistName: "John Coltrane",
            foreignArtistId: "artist-mbid",
          },
        },
      },
    },
    response,
  );

  assert.deepEqual(response.result.body, { handled: true });
  const entry = db
    .prepare("SELECT status_label, metadata FROM aurral_history WHERE id = ?")
    .get("aurral-album_requested-42");
  assert.equal(entry.status_label, "Downloaded");
  assert.equal(JSON.parse(entry.metadata).username, "alice");
});

test("the artist is read from beside the album, where Lidarr actually sends it", () => {
  requestSearching({ albumId: 42, albumName: "Blue Train" });

  const response = createResponse();
  handleLidarrWebhook(
    {
      body: {
        eventType: "Download",
        artist: { id: 3, name: "John Coltrane", mbId: "artist-mbid" },
        album: { id: 42, title: "Blue Train" },
        trackFiles: [],
      },
    },
    response,
  );

  assert.deepEqual(response.result.body, { handled: true });
  const metadata = JSON.parse(
    db.prepare("SELECT metadata FROM aurral_history WHERE id = ?").get("aurral-album_requested-42").metadata,
  );
  assert.equal(metadata.artistName, "John Coltrane");
  assert.equal(metadata.artistMbid, "artist-mbid");
});

test("Lidarr Download webhook ignores unrelated albums", () => {
  requestSearching({ albumId: 42, albumName: "Blue Train" });

  const response = createResponse();
  handleLidarrWebhook(
    { body: { eventType: "Download", album: { id: 99, title: "Other Album" } } },
    response,
  );

  assert.deepEqual(response.result.body, { handled: false });
  const entry = db
    .prepare("SELECT status_label FROM aurral_history WHERE id = ?")
    .get("aurral-album_requested-42");
  assert.equal(entry.status_label, "Searching");
});

test("Lidarr Download webhook matches a request through its album metadata", () => {
  upsertAurralHistory({
    referenceId: "artist-mbid",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata: { albumId: 42, albumName: "Blue Train" },
  });

  const response = createResponse();
  handleLidarrWebhook(
    { body: { eventType: "Download", album: { id: 42, title: "Blue Train" } } },
    response,
  );

  assert.deepEqual(response.result.body, { handled: true });
  const entry = db
    .prepare("SELECT status_label, metadata FROM aurral_history WHERE id = ?")
    .get("aurral-album_requested-artist-mbid");
  assert.equal(entry.status_label, "Downloaded");
  const metadata = JSON.parse(entry.metadata);
  assert.equal(metadata.albumId, "42");
  assert.equal(metadata.albumName, "Blue Train");
});

test("Lidarr non-download events are acknowledged without changing history", () => {
  const response = createResponse();
  handleLidarrWebhook({ body: { eventType: "Test" } }, response);
  assert.equal(response.result.statusCode, 204);
  assert.equal(response.result.ended, true);
});

test("only the webhook key opens the webhook, and it opens nothing else", () => {
  const webhookKey = auth.getLidarrWebhookKey();
  const apiKey = auth.getApiKey();
  assert.notEqual(webhookKey, apiKey);

  const attempt = (headers) => {
    let passed = false;
    const response = createResponse();
    requireLidarrWebhookKey({ headers }, response, () => {
      passed = true;
    });
    return { passed, statusCode: response.result.statusCode };
  };

  assert.equal(attempt({ "x-webhook-key": webhookKey }).passed, true);
  assert.deepEqual(attempt({}), { passed: false, statusCode: 401 });
  assert.equal(attempt({ "x-webhook-key": "wrong" }).passed, false);
  assert.equal(attempt({ "x-webhook-key": apiKey }).passed, false, "the admin API key is not a webhook key");
  assert.equal(attempt({ "x-api-key": apiKey }).passed, false);

  // The webhook key is not an API key anywhere else.
  assert.equal(auth.resolveRequestUser({ headers: { "x-api-key": webhookKey }, query: {} }), null);

  // Rotating retires the old key.
  const rotated = auth.rotateLidarrWebhookKey();
  assert.notEqual(rotated, webhookKey);
  assert.equal(attempt({ "x-webhook-key": webhookKey }).passed, false);
  assert.equal(attempt({ "x-webhook-key": rotated }).passed, true);
});
