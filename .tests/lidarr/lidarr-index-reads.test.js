import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { LidarrClient } from "../../backend/services/lidarrClient.js";
import { LIDARR_INDEX_READ } from "../../backend/services/libraryLidarrIndexer.js";

// The library index reads whole-artist track lists that Lidarr can be slow to
// answer. With the 30s interactive timeout and twelve requests at once, one
// slow artist aborted every index. These cover the two knobs the index now
// relies on: a per-call timeout that outlasts the client default, and fewer
// requests in flight at once.

async function startServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

function clientFor(t, port, timeoutMs) {
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${port}`,
    apiKey: "test",
    timeoutMs,
    circuitDisabled: true,
  };
  t.after(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });
  return client;
}

function respondAfter(ms) {
  return (_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
    }, ms);
  };
}

test("a per-call timeout outlasts the client default", async (t) => {
  const port = await startServer(t, respondAfter(400));
  const client = clientFor(t, port, 100);

  await assert.rejects(client.request("/track?artistId=1", "GET", null, false, {}));
  const answered = await client.request("/track?artistId=1", "GET", null, false, {
    timeoutMs: 3000,
  });
  assert.deepEqual(answered, []);
});

test("bulk track and track-file reads keep to the concurrency they are given", async (t) => {
  let inFlight = 0;
  let peak = 0;
  const port = await startServer(t, (request, response) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
    }, 30);
  });
  const client = clientFor(t, port, 2000);
  const artistIds = [1, 2, 3, 4, 5, 6, 7, 8];

  await client.getAllTracks({ artistIds, throwOnError: true, concurrency: 2 });
  assert.ok(peak >= 1 && peak <= 2, `peak ${peak} exceeded the requested concurrency`);

  peak = 0;
  await client.getAllTrackFiles({ artistIds, throwOnError: true, concurrency: 2 });
  assert.ok(peak >= 1 && peak <= 2, `peak ${peak} exceeded the requested concurrency`);
});

test("the library index reads with room to spare and fewer at a time", () => {
  assert.ok(LIDARR_INDEX_READ.timeoutMs >= 60_000);
  assert.ok(LIDARR_INDEX_READ.concurrency < 12);
  assert.equal(LIDARR_INDEX_READ.throwOnError, true);
});
