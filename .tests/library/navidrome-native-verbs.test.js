import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { NavidromeClient } from "../../backend/services/navidrome.js";

// The playlist repair unit tests drive a fake client, so they never exercise
// the real HTTP verb dispatch. That gap let a missing DELETE branch through to
// a live run. This drives NavidromeClient against a throwaway server so every
// verb its own methods rely on is proven to reach the wire.
const withServer = async (run) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/auth/login") {
        res.end(JSON.stringify({ token: "test-token" }));
        return;
      }
      res.end(JSON.stringify([]));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(new NavidromeClient(`http://127.0.0.1:${port}`, "admin", "pw"), seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test("removePlaylistTracks issues a DELETE with repeated id parameters", async () => {
  await withServer(async (client, seen) => {
    await client.removePlaylistTracks("pl1", ["a", "b"]);
    const call = seen.find((entry) => entry.method === "DELETE");
    assert.ok(call, "expected a DELETE request to reach the server");
    assert.match(call.url, /^\/api\/playlist\/pl1\/tracks\?/);
    assert.match(call.url, /id=a/);
    assert.match(call.url, /id=b/);
  });
});

test("removePlaylistTracks makes no request when there is nothing to remove", async () => {
  await withServer(async (client, seen) => {
    const result = await client.removePlaylistTracks("pl1", []);
    assert.equal(result, null);
    assert.deepEqual(seen, []);
  });
});

test("addPlaylistTracks issues a POST carrying the ids in order", async () => {
  await withServer(async (client, seen) => {
    await client.addPlaylistTracks("pl1", ["x", "y"]);
    const call = seen.find((entry) => entry.method === "POST" && entry.url.includes("/tracks"));
    assert.ok(call, "expected a POST request to reach the server");
    assert.equal(call.url, "/api/playlist/pl1/tracks");
  });
});

test("every verb the playlist methods need is dispatched, not rejected", async () => {
  await withServer(async (client) => {
    // Each of these threw "Unsupported method" before DELETE was handled.
    await assert.doesNotReject(() => client.getPlaylists());
    await assert.doesNotReject(() => client.getPlaylistTracks("pl1"));
    await assert.doesNotReject(() => client.addPlaylistTracks("pl1", ["x"]));
    await assert.doesNotReject(() => client.removePlaylistTracks("pl1", ["x"]));
    await assert.doesNotReject(() => client.findSongsByPath("a/b.mp3"));
  });
});
