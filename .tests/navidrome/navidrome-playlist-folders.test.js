import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps }, folders] = await setupIsolatedBackend(
  "navidrome-playlist-folders",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/navidromePlaylistFolders.js",
);

let user;
let other;

test.before(() => {
  resetDatabase(db);
  user = userOps.getUserById(userOps.createUser("dunshill", "hash").id);
  other = userOps.getUserById(userOps.createUser("avery", "hash").id);
});

test.beforeEach(() => {
  db.prepare("DELETE FROM navidrome_playlist_folders").run();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("a playlist is filed, and an empty folder puts it back at the top", () => {
  assert.equal(folders.setPlaylistFolder(user.id, "p-1", "Rock/Live"), "Rock/Live");
  assert.equal(folders.getPlaylistFolders(user.id).get("p-1"), "Rock/Live");
  assert.equal(folders.setPlaylistFolder(user.id, "p-1", ""), "");
  assert.equal(folders.getPlaylistFolders(user.id).has("p-1"), false);
});

test("folder paths are tidied rather than taken as typed", () => {
  assert.equal(folders.normalizeFolder("  Rock // Live  "), "Rock/Live");
  assert.equal(folders.normalizeFolder("///"), "");
  assert.throws(() => folders.normalizeFolder("a/b/c/d/e/f"), /deep at most/);
  assert.throws(() => folders.normalizeFolder("x".repeat(61)), /characters at most/);
});

test("the folder list includes the ones only implied by a child", () => {
  folders.setPlaylistFolder(user.id, "p-1", "Rock/Live/Bootlegs");
  folders.setPlaylistFolder(user.id, "p-2", "Jazz");
  assert.deepEqual(folders.listFolders(user.id), ["Jazz", "Rock", "Rock/Live", "Rock/Live/Bootlegs"]);
});

test("renaming a folder takes everything underneath with it", () => {
  folders.setPlaylistFolder(user.id, "p-1", "Rock");
  folders.setPlaylistFolder(user.id, "p-2", "Rock/Live");
  folders.setPlaylistFolder(user.id, "p-3", "Jazz");

  assert.equal(folders.renameFolder(user.id, "Rock", "Guitar"), 2);
  const filed = folders.getPlaylistFolders(user.id);
  assert.equal(filed.get("p-1"), "Guitar");
  assert.equal(filed.get("p-2"), "Guitar/Live");
  assert.equal(filed.get("p-3"), "Jazz", "an unrelated folder is left alone");
});

test("a folder cannot be moved inside itself", () => {
  folders.setPlaylistFolder(user.id, "p-1", "Rock/Live");
  assert.throws(() => folders.renameFolder(user.id, "Rock", "Rock/Older"), /inside itself/);
  assert.throws(() => folders.renameFolder(user.id, "", "Rock"), /Which folder/);
  assert.throws(() => folders.renameFolder(user.id, "Rock", ""), /needs a name/);
});

test("throwing a folder away keeps the playlists, one level up", () => {
  folders.setPlaylistFolder(user.id, "p-1", "Rock");
  folders.setPlaylistFolder(user.id, "p-2", "Rock/Live");
  folders.setPlaylistFolder(user.id, "p-3", "Shows/Rock/Live");

  assert.equal(folders.removeFolder(user.id, "Rock"), 2);
  const filed = folders.getPlaylistFolders(user.id);
  assert.equal(filed.has("p-1"), false, "a playlist at the top level keeps no row");
  assert.equal(filed.get("p-2"), "Live");
  assert.equal(filed.get("p-3"), "Shows/Rock/Live", "a folder of the same name elsewhere is untouched");
});

test("one person's tree is not another's", () => {
  folders.setPlaylistFolder(user.id, "p-1", "Rock");
  folders.setPlaylistFolder(other.id, "p-1", "Jazz");
  assert.equal(folders.getPlaylistFolders(user.id).get("p-1"), "Rock");
  assert.equal(folders.getPlaylistFolders(other.id).get("p-1"), "Jazz");
  folders.renameFolder(user.id, "Rock", "Guitar");
  assert.equal(folders.getPlaylistFolders(other.id).get("p-1"), "Jazz");
});

test("playlists deleted elsewhere stop taking up room in the tree", () => {
  folders.setPlaylistFolder(user.id, "p-1", "Rock");
  folders.setPlaylistFolder(user.id, "p-2", "Rock");
  // p-2 was deleted from a phone; only p-1 comes back from Navidrome.
  assert.equal(folders.pruneMissingPlaylists(user.id, ["p-1"]), 1);
  assert.deepEqual([...folders.getPlaylistFolders(user.id).keys()], ["p-1"]);
});

test("forgetting one playlist leaves the rest of the tree alone", () => {
  folders.setPlaylistFolder(user.id, "p-1", "Rock");
  folders.setPlaylistFolder(user.id, "p-2", "Rock");
  assert.equal(folders.forgetPlaylistFolder(user.id, "p-1"), true);
  assert.equal(folders.forgetPlaylistFolder(user.id, "p-1"), false);
  assert.deepEqual([...folders.getPlaylistFolders(user.id).keys()], ["p-2"]);
});
