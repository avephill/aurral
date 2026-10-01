import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// How many albums a person may ask for in a day, and asking for a release
// without being able to add a whole artist.

const [isolatedState, { db }, { userOps }, requests] = await setupIsolatedBackend(
  "album-request-limit",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/albumRequestService.js",
);

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 24, 12);
let helen;
let avery;

test.before(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM album_requests").run();
  helen = userOps.createUser("helen", "hash");
  avery = userOps.createUser("avery", "hash", "admin");
});

test.after(() => cleanupIsolatedState(isolatedState));

const ask = (user, mbid, at) =>
  requests.recordAlbumRequest({ user, albumMbid: mbid, albumName: mbid, artistName: "Someone", at });

const refusal = (user, album, now = NOW) => {
  try {
    requests.assertAlbumRequestAllowed(user, album, now);
    return null;
  } catch (error) {
    return error;
  }
};

test("a new account may ask for three albums a day", () => {
  assert.equal(requests.DEFAULT_DAILY_ALBUM_REQUESTS, 3);
  assert.deepEqual(requests.albumRequestAllowance(helen, NOW), { limit: 3, used: 0, remaining: 3, nextAt: null });
  ask(helen, "a", NOW - 5 * HOUR);
  ask(helen, "b", NOW - 3 * HOUR);
  assert.equal(refusal(helen, { albumMbid: "c" }), null, "the third is fine");
  ask(helen, "c", NOW - 1 * HOUR);

  const error = refusal(helen, { albumMbid: "d" });
  assert.equal(error.statusCode, 429);
  assert.equal(error.code, "album-request-limit");
  // The first of the three leaves the day 19 hours from now.
  assert.equal(error.allowance.nextAt, NOW - 5 * HOUR + 24 * HOUR);
  assert.match(error.message, /3 albums a day.*another in about 19 hours/);
});

test("asking again for an album already asked for costs nothing", () => {
  assert.equal(refusal(helen, { albumMbid: "b" }), null);
  ask(helen, "b", NOW);
  assert.equal(requests.albumRequestAllowance(helen, NOW).used, 3, "still three, not four");
});

test("the day rolls: a request from yesterday no longer counts", () => {
  assert.equal(refusal(helen, { albumMbid: "d" }, NOW + 20 * HOUR), null);
});

test("an admin sets the number per person, or none, or no limit", () => {
  userOps.setAlbumRequestLimit(helen.id, 5);
  assert.equal(requests.albumRequestAllowance(helen, NOW).remaining, 2);
  userOps.setAlbumRequestLimit(helen.id, 0);
  assert.match(refusal(helen, { albumMbid: "z" }).message, /switched off/);
  userOps.setAlbumRequestLimit(helen.id, requests.NO_ALBUM_REQUEST_LIMIT);
  assert.equal(refusal(helen, { albumMbid: "z" }), null);
  assert.equal(requests.albumRequestAllowance(helen, NOW).limit, null);
  userOps.setAlbumRequestLimit(helen.id, null);
  assert.equal(requests.albumRequestAllowance(helen, NOW).limit, 3, "back to the default");
  assert.equal(userOps.getAllUsers().find((user) => user.username === "helen").albumRequestLimit, null);
});

test("admins have no limit", () => {
  for (const mbid of ["1", "2", "3", "4"]) ask(avery, mbid, NOW - HOUR);
  assert.equal(refusal({ ...avery, role: "admin" }, { albumMbid: "5" }), null);
});

test("a new account cannot add a whole artist, but can ask for a release", () => {
  const fresh = userOps.createUser("kitty", "hash");
  assert.equal(fresh.permissions.addArtist, false);
  assert.equal(fresh.permissions.addAlbum, true);
});

test("asking for a release by an artist Lidarr lacks needs only addAlbum", () => {
  const manager = readFileSync(new URL("../../backend/services/libraryManager.js", import.meta.url), "utf8");
  const request = manager.slice(manager.indexOf("async requestAlbumFromSearch"));
  assert.doesNotMatch(request.slice(0, 2500), /hasPermission\(user, "addArtist"\)/);
  assert.match(request.slice(0, 2500), /hasPermission\(user, "addAlbum"\)/);
});

test("every way of asking for an album is held to the limit", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const albums = read("../../backend/routes/library/handlers/albums.js");
  const downloads = read("../../backend/routes/library/handlers/downloads.js");
  const inbox = read("../../backend/routes/inbox.js");
  assert.equal((albums.match(/assertAlbumRequestAllowed\(req\.user/g) || []).length, 2, "add and request");
  assert.equal((downloads.match(/assertAlbumRequestAllowed\(req\.user/g) || []).length, 2, "download and search");
  assert.match(inbox, /assertAlbumRequestAllowed\(user, \{ albumMbid: metadata\.albumMbid \}\)/);
  assert.match(inbox, /recordAlbumRequested\(\{/, "and the inbox's requests are counted");
});

test("an admin sets it beside the person in Settings", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const routes = read("../../backend/routes/users.js");
  const table = read("../../frontend/src/pages/Settings/components/SettingsUsersTab.jsx");
  assert.match(routes, /router\.patch\("\/:id\/request-limit", requireAuth, requireAdmin/);
  assert.match(table, /<UserRequestLimit user=\{user\} onSaved=\{refreshUsers\} \/>/);
});
