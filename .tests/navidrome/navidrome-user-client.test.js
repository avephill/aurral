import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  NavidromeUserClient,
  isNavidromeAuthError,
} from "../../backend/services/navidromeUserClient.js";

function subsonic(payload) {
  return JSON.stringify({ "subsonic-response": { status: "ok", version: "1.16.1", ...payload } });
}

async function withFakeNavidrome(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, pathname: url.pathname, params: url.searchParams, headers: req.headers, body });
      const result = handler({ pathname: url.pathname, params: url.searchParams, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(result);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("per-user requests carry the trusted username header and no password token", async () => {
  await withFakeNavidrome(
    ({ pathname }) => (pathname === "/rest/ping" ? subsonic({}) : subsonic({ playlists: { playlist: [] } })),
    async (url, requests) => {
      const client = new NavidromeUserClient(url, "dunshill", { header: "Remote-User" });
      assert.equal(client.isConfigured(), true);
      await client.ping();
      const [request] = requests;
      assert.equal(request.headers["remote-user"], "dunshill");
      assert.equal(request.params.get("u"), "dunshill");
      assert.equal(request.params.get("t"), null);
      assert.equal(request.params.get("s"), null);
      assert.equal(request.params.get("p"), null);
      assert.equal(request.params.get("c"), "aurral");
    },
  );
});

test("the header name follows configuration", async () => {
  await withFakeNavidrome(
    () => subsonic({}),
    async (url, requests) => {
      const client = new NavidromeUserClient(url, "avery", { header: "X-Forwarded-User" });
      await client.ping();
      assert.equal(requests[0].headers["x-forwarded-user"], "avery");
      assert.equal(requests[0].headers["remote-user"], undefined);
    },
  );
});

test("appending songs batches into updatePlaylist calls and removals go by index", async () => {
  await withFakeNavidrome(
    () => subsonic({}),
    async (url, requests) => {
      const client = new NavidromeUserClient(url, "dunshill");
      const ids = Array.from({ length: 120 }, (_, index) => `song-${index}`);
      assert.equal(await client.appendPlaylistSongs("pl-1", ids), 120);
      const updates = requests.filter((request) => request.pathname === "/rest/updatePlaylist");
      assert.equal(updates.length, 3);
      for (const update of updates) {
        assert.equal(update.method, "POST");
        assert.equal(update.headers["remote-user"], "dunshill");
        const body = new URLSearchParams(update.body);
        assert.equal(body.get("playlistId"), "pl-1");
        assert.ok(body.getAll("songIdToAdd").length <= 50);
      }
      assert.equal(await client.removePlaylistEntries("pl-1", [3, 3, 1, -1, "x"]), 2);
      const removal = new URLSearchParams(requests.at(-1).body);
      assert.deepEqual(removal.getAll("songIndexToRemove"), ["3", "1"]);
      assert.equal(await client.removePlaylistEntries("pl-1", []), 0);
    },
  );
});

test("a Subsonic auth failure is reported as such", async () => {
  await withFakeNavidrome(
    () => JSON.stringify({ "subsonic-response": { status: "failed", error: { code: 40, message: "Wrong username or password" } } }),
    async (url) => {
      const client = new NavidromeUserClient(url, "dunshill");
      await assert.rejects(() => client.ping(), (error) => {
        assert.equal(isNavidromeAuthError(error), true);
        return true;
      });
    },
  );
  assert.equal(isNavidromeAuthError({ code: 70 }), false);
  assert.equal(isNavidromeAuthError(new Error("network")), false);
});

test("the native API is refused for per-user clients", async () => {
  const client = new NavidromeUserClient("http://127.0.0.1:1", "dunshill");
  await assert.rejects(() => client.findSongsByPath("A/B/c.flac"), /not available/);
});
