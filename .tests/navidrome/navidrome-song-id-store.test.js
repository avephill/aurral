import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, store] = await setupIsolatedBackend(
  "navidrome-song-id-store",
  "backend/config/db-sqlite.js",
  "backend/services/navidromeSongIdStore.js",
);

const PATH = "/data/Music/Library/Jethro Tull/Stand Up/01 A New Day Yesterday.flac";

test.before(() => {
  resetDatabase(db);
});

test.beforeEach(() => {
  store.clearNavidromeSongIds();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("one file has an id per Navidrome library", () => {
  store.rememberNavidromeSongIds([
    { mediaPath: PATH, libraryId: 1, songId: "nd-main" },
    { mediaPath: PATH, libraryId: 4, songId: "nd-avery" },
  ]);

  assert.deepEqual(store.getNavidromeSongId(PATH, { libraryId: 4 }), { songId: "nd-avery", libraryId: 4 });
  assert.deepEqual(store.getNavidromeSongId(PATH, { libraryId: 1 }), { songId: "nd-main", libraryId: 1 });
  assert.equal(store.getNavidromeSongCopies(PATH).length, 2);
  assert.equal(store.getNavidromeSongId(PATH, { libraryId: 9 }), null);
});

test("an id maps back to its file", () => {
  store.rememberNavidromeSongId({ mediaPath: PATH, libraryId: 1, songId: "nd-main" });
  const paths = store.getMediaPathsForNavidromeSongIds(["nd-main", "nd-missing"]);
  assert.equal(paths.get("nd-main"), PATH);
  assert.equal(paths.has("nd-missing"), false);
});

test("re-resolving the same file in the same library replaces the id", () => {
  store.rememberNavidromeSongId({ mediaPath: PATH, libraryId: 1, songId: "nd-old" });
  store.rememberNavidromeSongId({ mediaPath: PATH, libraryId: 1, songId: "nd-new" });
  assert.equal(store.countNavidromeSongIds(), 1);
  assert.deepEqual(store.getNavidromeSongId(PATH, { libraryId: 1 }), { songId: "nd-new", libraryId: 1 });
});

test("an id Navidrome no longer knows can be forgotten", () => {
  store.rememberNavidromeSongId({ mediaPath: PATH, libraryId: 1, songId: "nd-gone" });
  assert.equal(store.forgetNavidromeSongId("nd-gone"), true);
  assert.equal(store.getNavidromeSongId(PATH, { libraryId: 1 }), null);
  assert.equal(store.forgetNavidromeSongId("nd-gone"), false);
});

test("a copy whose library Navidrome did not name is still kept", () => {
  store.rememberNavidromeSongId({ mediaPath: PATH, libraryId: null, songId: "nd-unknown-library" });
  assert.deepEqual(store.getNavidromeSongId(PATH), { songId: "nd-unknown-library", libraryId: null });
  assert.equal(store.getMediaPathsForNavidromeSongIds(["nd-unknown-library"]).get("nd-unknown-library"), PATH);
});

test("blank input is ignored rather than stored", () => {
  assert.equal(store.rememberNavidromeSongId({ mediaPath: "", songId: "x" }), false);
  assert.equal(store.rememberNavidromeSongId({ mediaPath: PATH, songId: "" }), false);
  assert.equal(store.countNavidromeSongIds(), 0);
  assert.equal(store.getNavidromeSongId(""), null);
  assert.deepEqual([...store.getMediaPathsForNavidromeSongIds([])], []);
});
