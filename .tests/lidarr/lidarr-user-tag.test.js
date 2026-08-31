import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { lidarrClient } from "../../backend/services/lidarrClient.js";

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function withFakeLidarr(initialTags, run) {
  const state = { tags: [...initialTags], created: [] };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/v1/tag") {
      return json(res, 200, state.tags);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/tag") {
      const payload = await readJsonBody(req);
      const tag = { id: state.tags.length + 1, label: payload.label };
      state.tags.push(tag);
      state.created.push(tag);
      return json(res, 201, tag);
    }
    return json(res, 404, { message: `unexpected ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const previousHold = lidarrClient._holdConfig;
  const previousConfig = lidarrClient.config;
  lidarrClient._holdConfig = true;
  lidarrClient.config = {
    url: `http://127.0.0.1:${port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
  };

  try {
    await run(state);
  } finally {
    lidarrClient._holdConfig = previousHold;
    lidarrClient.config = previousConfig;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("ensureUserTag creates a lowercase tag for a new user", async () => {
  await withFakeLidarr([{ id: 1, label: "aurral" }], async (state) => {
    const tagId = await lidarrClient.ensureUserTag("Avery");
    assert.equal(tagId, 2);
    assert.deepEqual(state.created, [{ id: 2, label: "avery" }]);
  });
});

test("ensureUserTag reuses an existing tag case-insensitively", async () => {
  await withFakeLidarr([{ id: 5, label: "Avery" }], async (state) => {
    const tagId = await lidarrClient.ensureUserTag("avery");
    assert.equal(tagId, 5);
    assert.equal(state.created.length, 0);
  });
});

test("ensureUserTag returns null for a blank username", async () => {
  await withFakeLidarr([], async (state) => {
    const tagId = await lidarrClient.ensureUserTag("  ");
    assert.equal(tagId, null);
    assert.equal(state.created.length, 0);
  });
});
