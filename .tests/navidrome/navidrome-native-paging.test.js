import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { NavidromeClient } from "../../backend/services/navidrome.js";

// A fake native API with a 7,300-track playlist that only ever returns the
// page asked for, and that records every write.
async function withFakeNative(run) {
  const total = 7300;
  const state = { gets: [], adds: [], deletes: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/auth/login") return send(200, { token: "t" });
    if (url.pathname === "/api/playlist/p1/tracks" && req.method === "GET") {
      const start = Number(url.searchParams.get("_start") || 0);
      const requestedEnd = Number(url.searchParams.get("_end") || total);
      const end = Math.min(requestedEnd, total);
      state.gets.push([start, requestedEnd]);
      return send(200, Array.from({ length: Math.max(0, end - start) }, (_, i) => ({ id: String(start + i + 1), mediaFileId: `mf-${start + i + 1}`, path: `p/${start + i + 1}.flac`, libraryId: 1 })));
    }
    if (url.pathname === "/api/playlist/p1/tracks" && req.method === "POST") {
      let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => { state.adds.push(JSON.parse(body).ids.length); send(200, { added: 1 }); });
      return undefined;
    }
    if (url.pathname === "/api/playlist/p1/tracks" && req.method === "DELETE") {
      state.deletes.push(url.searchParams.getAll("id").length);
      return send(200, { ids: [] });
    }
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(new NavidromeClient(`http://127.0.0.1:${server.address().port}`, "admin", "pw"), state, total);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("playlist tracks are read page by page until the playlist is exhausted", async () => {
  await withFakeNative(async (client, state, total) => {
    const tracks = await client.getPlaylistTracks("p1");
    assert.equal(tracks.length, total);
    assert.equal(tracks[0].id, "1");
    assert.equal(tracks.at(-1).id, String(total));
    assert.deepEqual(state.gets, [[0, 1000], [1000, 2000], [2000, 3000], [3000, 4000], [4000, 5000], [5000, 6000], [6000, 7000], [7000, 8000]]);
  });
});

test("large adds and deletes go out in chunks", async () => {
  await withFakeNative(async (client, state) => {
    const ids = Array.from({ length: 1201 }, (_, i) => `x${i}`);
    await client.addPlaylistTracks("p1", ids);
    assert.deepEqual(state.adds, [500, 500, 201]);
    await client.removePlaylistTracks("p1", ids);
    assert.deepEqual(state.deletes, [500, 500, 201]);
    assert.equal(await client.removePlaylistTracks("p1", []), null);
  });
});
