import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

process.env.AURRAL_NAVIDROME_USER_AUTH = "reverse-proxy";
process.env.AURRAL_NAVIDROME_USER_HEADER = "X-Authentik-Username";

const [isolatedState, { db }, { dbOps, userOps }, { NavidromeClient }, userClientModule] =
  await setupIsolatedBackend(
    "navidrome-playlist-editing",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/navidrome.js",
    "backend/services/navidromeUserClient.js",
  );

const router = (await import("../../backend/routes/navidromePlaylists.js")).default;

const subsonicOk = (payload = {}) =>
  JSON.stringify({ "subsonic-response": { status: "ok", version: "1.16.1", ...payload } });

// A Navidrome that records what it was asked to do. Playlist p-1 belongs to
// the signed-in user, p-2 to somebody else.
function createFakeNavidrome() {
  const state = { requests: [], entries: ["song-a", "song-b", "song-c"] };
  const handler = (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const reply = (body, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
    const collectBody = () => new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        if (!raw) return resolve(null);
        try {
          return resolve(JSON.parse(raw));
        } catch {
          return resolve(raw);
        }
      });
    });

    if (url.pathname === "/auth/login") return reply(JSON.stringify({ token: "admin-token" }));
    if (url.pathname === "/api/playlist/p-1") {
      return reply(JSON.stringify({ id: "p-1", name: "Mine", ownerName: "dunshill", songCount: 3 }));
    }
    if (url.pathname === "/api/playlist/p-2") {
      return reply(JSON.stringify({ id: "p-2", name: "Theirs", ownerName: "someone-else", songCount: 3 }));
    }
    if (url.pathname === "/api/playlist/p-1/tracks" && req.method === "GET") {
      return reply(JSON.stringify(state.entries.map((songId, index) => ({
        id: index + 1,
        mediaFileId: songId,
        path: `Artist/Album/0${index + 1} Song.flac`,
      }))));
    }
    if (url.pathname.startsWith("/api/playlist/p-1/tracks/") && req.method === "PUT") {
      return collectBody().then((body) => {
        state.requests.push({ kind: "move", rowId: url.pathname.split("/").at(-1), body });
        reply(JSON.stringify({ id: "p-1" }));
      });
    }
    if (url.pathname === "/rest/getPlaylist") {
      return reply(subsonicOk({
        playlist: {
          id: "p-1",
          name: "Mine",
          owner: "dunshill",
          songCount: state.entries.length,
          entry: state.entries.map((songId, index) => ({ id: songId, title: `Song ${index + 1}` })),
        },
      }));
    }
    if (url.pathname === "/rest/updatePlaylist") {
      // Navidrome's updatePlaylist is posted as a form, so the positions are
      // in the body rather than the query string.
      return collectBody().then((body) => {
        const params = new URLSearchParams(typeof body === "string" ? body : "");
        state.requests.push({
          kind: "update",
          removed: [...params.getAll("songIndexToRemove"), ...url.searchParams.getAll("songIndexToRemove")],
        });
        reply(subsonicOk());
      });
    }
    return reply(JSON.stringify({ error: "not found" }), 404);
  };
  return { state, handler };
}

let server;
let fake;
let user;

test.before(async () => {
  resetDatabase(db);
  fake = createFakeNavidrome();
  server = await createMockHttpServer(fake.handler);
  dbOps.updateSettings({
    integrations: { navidrome: { url: server.url, username: "avery", password: "admin-secret" } },
  });
  user = userOps.getUserById(userOps.createUser("dunshill", "hash").id);
});

test.after(async () => {
  await server?.close();
  await cleanupIsolatedState(isolatedState);
});

// Express keeps the handlers it was given; this finds the one under test.
function routeHandler(method, path) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack.at(-1).handle;
    }
  }
  throw new Error(`no route for ${method} ${path}`);
}

function responseFor() {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    send(value) {
      this.body = typeof value === "string" ? JSON.parse(value) : value;
      return this;
    },
  };
  return response;
}

test("moving an entry asks Navidrome to insert it one past the destination", async () => {
  const response = responseFor();
  await routeHandler("PUT", "/:id/entries/:index/position")(
    { user, params: { id: "p-1", index: "0" }, body: { toIndex: 2, songId: "song-a" } },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { moved: true, fromIndex: 0, toIndex: 2 });
  const move = fake.state.requests.findLast((request) => request.kind === "move");
  assert.equal(move.rowId, "1", "the row at position 0 is the one that moves");
  // Navidrome removes the entry first, so the position it wants is one past
  // where the entry should end up.
  assert.deepEqual(move.body, { insert_before: "3" });
});

test("a move is refused when the song at that position is not the one the caller saw", async () => {
  const response = responseFor();
  await routeHandler("PUT", "/:id/entries/:index/position")(
    { user, params: { id: "p-1", index: "0" }, body: { toIndex: 1, songId: "song-somewhere-else" } },
    response,
  );
  assert.equal(response.statusCode, 409);
});

test("a move outside the playlist is refused", async () => {
  const response = responseFor();
  await routeHandler("PUT", "/:id/entries/:index/position")(
    { user, params: { id: "p-1", index: "0" }, body: { toIndex: 99 } },
    response,
  );
  assert.equal(response.statusCode, 400);
});

test("moving to the same place is a no-op rather than a write", async () => {
  const before = fake.state.requests.filter((request) => request.kind === "move").length;
  const response = responseFor();
  await routeHandler("PUT", "/:id/entries/:index/position")(
    { user, params: { id: "p-1", index: "1" }, body: { toIndex: 1 } },
    response,
  );
  assert.deepEqual(response.body, { moved: false });
  assert.equal(fake.state.requests.filter((request) => request.kind === "move").length, before);
});

test("someone else's playlist cannot be reordered, even though the admin could", async () => {
  const response = responseFor();
  await routeHandler("PUT", "/:id/entries/:index/position")(
    { user, params: { id: "p-2", index: "0" }, body: { toIndex: 1 } },
    response,
  );
  assert.equal(response.statusCode, 403);
});

test("several entries are removed in one call, by position", async () => {
  const response = responseFor();
  await routeHandler("POST", "/:id/entries/remove")(
    {
      user,
      params: { id: "p-1" },
      body: { entries: [{ index: 0, songId: "song-a" }, { index: 2, songId: "song-c" }] },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { removed: 2 });
  const update = fake.state.requests.findLast((request) => request.kind === "update");
  assert.deepEqual(update.removed, ["0", "2"]);
});

test("a stale position stops the whole removal rather than deleting the wrong track", async () => {
  const before = fake.state.requests.filter((request) => request.kind === "update").length;
  const response = responseFor();
  await routeHandler("POST", "/:id/entries/remove")(
    {
      user,
      params: { id: "p-1" },
      body: { entries: [{ index: 0, songId: "song-a" }, { index: 1, songId: "moved-away" }] },
    },
    response,
  );
  assert.equal(response.statusCode, 409);
  assert.equal(fake.state.requests.filter((request) => request.kind === "update").length, before);
});

test("the user client sends one update for a batch of removals", async () => {
  const client = userClientModule.createNavidromeUserClient(user);
  const before = fake.state.requests.filter((request) => request.kind === "update").length;
  assert.equal(await client.removePlaylistEntries("p-1", [3, 1, 1]), 2);
  const after = fake.state.requests.filter((request) => request.kind === "update");
  assert.equal(after.length, before + 1, "one call, not one per entry");
  assert.deepEqual(after.at(-1).removed, ["3", "1"]);
});

test("the client move helper targets the right playlist row", async () => {
  const client = new NavidromeClient(server.url, "avery", "admin-secret");
  await client.movePlaylistTrack("p-1", 2, 0);
  const move = fake.state.requests.findLast((request) => request.kind === "move");
  assert.equal(move.rowId, "2");
  assert.deepEqual(move.body, { insert_before: "1" });
});
