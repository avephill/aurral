import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// The Social routes over real HTTP: who may call them, and what they refuse.

const [isolatedState, { db }, { userOps }, libraryStore, socialRouter, express] = await setupIsolatedBackend(
  "social-routes",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/routes/social.js",
  "node_modules/express/index.js",
);

let server;
let base;
let actingAs = null;
let trackId;

test.before(async () => {
  resetDatabase(db);
  for (const name of ["avery", "dunshill"]) userOps.createUser(name, "hash");
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "a", name: "Neko Case", metadata: {} });
  const album = libraryStore.upsertLibraryAlbum({ identityKey: "al", artistId: artist.id, title: "Blacklisted", metadata: {} });
  const track = libraryStore.upsertLibraryTrack({ identityKey: "r:1", title: "Deep Red Bells", artistName: "Neko Case", metadata: {} });
  trackId = track.id;
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, discNumber: 1, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id, albumId: album.id, source: "lidarr",
    path: "/data/Music/Library/Neko Case/Blacklisted/01.flac", durationMs: 200_000, available: true,
  });

  const app = express.default();
  app.use(express.default.json());
  // Stands in for the app's own auth: the routes only need req.user.
  app.use((req, _res, next) => {
    if (actingAs) req.user = actingAs;
    next();
  });
  app.use("/api/social", socialRouter.default);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/social`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanupIsolatedState(isolatedState);
});

const call = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

test("a signed-out caller gets nothing", async () => {
  actingAs = null;
  const overview = await call("GET", "/overview");
  assert.equal(overview.status, 401);
  const send = await call("POST", "/recommendations", { kind: "track", targetId: 1 });
  assert.equal(send.status, 401);
});

test("the overview shows who you can share with, and nothing of other people's", async () => {
  actingAs = { id: 1, username: "avery" };
  const { status, body } = await call("GET", "/overview");
  assert.equal(status, 200);
  assert.equal(body.me, "avery");
  assert.deepEqual(body.people, ["dunshill"], "yourself is not someone to share with");
  assert.deepEqual(body.shares.received, []);
  assert.equal(body.settings.shareListening, true);
});

test("a recommendation reaches the person it names", async () => {
  actingAs = { id: 1, username: "avery" };
  const sent = await call("POST", "/recommendations", {
    kind: "track", targetId: trackId, note: "listen to this", recipients: ["dunshill"],
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.sent, 1);

  actingAs = { id: 2, username: "dunshill" };
  const his = await call("GET", "/overview");
  assert.equal(his.body.recommendations.inbox.length, 1);
  assert.equal(his.body.recommendations.inbox[0].title, "Deep Red Bells");
  assert.equal(his.body.recommendations.inbox[0].note, "listen to this");
});

test("a recommendation must point at real music", async () => {
  actingAs = { id: 1, username: "avery" };
  const missing = await call("POST", "/recommendations", { kind: "album", targetId: 424242 });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /not in the library/);

  const nonsense = await call("POST", "/recommendations", { kind: "concert", targetId: 1 });
  assert.equal(nonsense.status, 400);
});

test("one person cannot hide another's recommendation", async () => {
  actingAs = { id: 1, username: "avery" };
  const sent = await call("POST", "/recommendations", { kind: "track", targetId: trackId, recipients: ["dunshill"] });
  const id = sent.body.ids[0];

  // A third party, with no claim on it.
  actingAs = { id: 3, username: "someone-else" };
  const refused = await call("POST", `/recommendations/${id}/dismiss`);
  assert.equal(refused.status, 403);

  actingAs = { id: 2, username: "dunshill" };
  const allowed = await call("POST", `/recommendations/${id}/dismiss`);
  assert.equal(allowed.status, 200);
});

test("only the sender can take a recommendation back", async () => {
  actingAs = { id: 1, username: "avery" };
  const sent = await call("POST", "/recommendations", { kind: "track", targetId: trackId, recipients: ["dunshill"] });
  const id = sent.body.ids[0];

  // The person it was for can hide it, but taking it back is the sender's.
  actingAs = { id: 2, username: "dunshill" };
  const refused = await call("DELETE", `/recommendations/${id}`);
  assert.equal(refused.status, 403);

  actingAs = { id: 1, username: "avery" };
  const taken = await call("DELETE", `/recommendations/${id}`);
  assert.equal(taken.status, 200);

  actingAs = { id: 2, username: "dunshill" };
  const theirs = await call("GET", "/overview");
  assert.equal(theirs.body.recommendations.inbox.some((entry) => entry.id === id), false);
});

test("sharing a playlist fails cleanly when Navidrome is not configured", async () => {
  actingAs = { id: 1, username: "avery" };
  const { status, body } = await call("POST", "/playlists/pl-1/share", { recipients: ["dunshill"] });
  assert.equal(status, 503);
  assert.match(body.error, /Navidrome/);
});

test("a person can stop sharing their listening", async () => {
  actingAs = { id: 2, username: "dunshill" };
  const off = await call("PUT", "/settings", { shareListening: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.shareListening, false);
  const overview = await call("GET", "/overview");
  assert.equal(overview.body.settings.shareListening, false);
});
