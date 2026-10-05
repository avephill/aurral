import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { cleanupIsolatedState, resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

// A daily copy of what someone has made of their library, and putting parts
// of it back.

const [isolatedState, { db }, { userOps }, history] = await setupIsolatedBackend(
  "library-history",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryHistoryService.js",
);

const DAY = 24 * 60 * 60 * 1000;
let dad;

// His library as the readers would find it, which each test changes.
const state = {};
const reset = () => Object.assign(state, {
  playlists: [
    { name: "Holiday", folder: "", comment: "", kind: "list", songs: ["A/X/1.mp3", "A/X/2.mp3", "B/Y/1.mp3"] },
    { name: "Five stars", folder: "Smart", comment: "", kind: "smart", rules: { all: [{ is: { rating: 5 } }] } },
  ],
  ratings: { "A/X/1.mp3": 5, "A/X/2.mp3": 3 },
  favourites: ["album:x", "song:y"],
  tags: { tracks: { 1: ["holiday"], 2: ["holiday", "sunday"] }, albums: {} },
  library: { enabled: true, artists: [{ mbid: "m1", name: "Alvvays" }], albums: [] },
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const deps = {
  read: Object.fromEntries(["playlists", "ratings", "favourites", "tags", "library"]
    .map((section) => [section, async () => clone(state[section])])),
};

test.before(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM library_snapshots").run();
  db.prepare("DELETE FROM library_snapshot_parts").run();
  dad = userOps.createUser("dunshill", "hash");
  reset();
});

test.after(() => cleanupIsolatedState(isolatedState));

test("a day when nothing changed costs a row, not another copy", async () => {
  const now = Date.now();
  const first = await history.takeSnapshot(dad, { deps, now: now - 2 * DAY });
  const parts = db.prepare("SELECT COUNT(*) AS n FROM library_snapshot_parts").get().n;
  const second = await history.takeSnapshot(dad, { deps, now: now - DAY });
  assert.equal(second.unchanged, true);
  assert.notEqual(second.id, first.id, "the day is still recorded");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_snapshot_parts").get().n, parts, "nothing stored twice");

  state.ratings["A/X/2.mp3"] = 4;
  await history.takeSnapshot(dad, { deps, now });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_snapshot_parts").get().n, parts + 1, "only the ratings again");

  const listed = history.listSnapshots("dunshill");
  assert.deepEqual(listed.map((entry) => entry.changed), [["ratings"], [], ["playlists", "ratings", "favourites", "tags", "library"]]);
  reset();
});

test("comparing a day with now says what is different, part by part", async () => {
  const [, , oldest] = history.listSnapshots("dunshill");
  state.playlists[0].songs = ["A/X/1.mp3", "C/Z/9.mp3"];
  state.playlists.push({ name: "New one", folder: "", comment: "", kind: "list", songs: [] });
  state.playlists.splice(1, 1);
  state.ratings = { "A/X/1.mp3": 5, "Q/Q/1.mp3": 2 };
  state.favourites = ["album:x", "artist:z"];
  state.tags = { tracks: { 1: ["holiday"], 2: ["sunday"] }, albums: {} };
  state.library = { enabled: true, artists: [], albums: ["V/Christmas"] };

  const { differences } = await history.compareWithNow(dad, oldest.id, { deps });
  const byName = new Map(differences.playlists.map((change) => [change.name, change]));
  assert.deepEqual(
    { ...byName.get("Holiday") },
    { name: "Holiday", change: "songs", kind: "list", removed: 2, added: 1, then: 3, now: 2 },
  );
  assert.equal(byName.get("Five stars").change, "gone");
  assert.equal(byName.get("New one").change, "new");
  assert.deepEqual(differences.ratings, { changed: 0, cleared: 1, added: 1, total: 2 });
  assert.deepEqual(differences.favourites, { removed: 1, added: 1 });
  assert.equal(differences.tags.songs, 1);
  assert.deepEqual(differences.tags.tags, [{ tag: "holiday", then: 2, now: 1 }]);
  assert.deepEqual(differences.library.artistsRemoved, ["Alvvays"]);
  assert.deepEqual(differences.library.albumsAdded, ["V/Christmas"]);
});

test("a restore takes a copy of now first, and puts back each part as it was", async () => {
  const [, , oldest] = history.listSnapshots("dunshill");
  const given = {};
  const restore = {
    playlists: async (user, then, names) => { given.playlists = { then, names }; return [{ name: names[0], restored: true, missing: 0 }]; },
    ratings: async (user, then) => { given.ratings = then; return { changed: 1 }; },
    tags: async (user, then) => { given.tags = then; return {}; },
  };
  await assert.rejects(
    () => history.restoreSnapshot(dad, oldest.id, { sections: ["playlists"], deps, restore }),
    /Choose which playlists/,
  );
  const before = history.listSnapshots("dunshill").length;
  const result = await history.restoreSnapshot(dad, oldest.id, {
    sections: ["playlists", "ratings", "tags"],
    playlists: ["Holiday"],
    deps,
    restore,
  });
  assert.equal(history.listSnapshots("dunshill").length, before + 1, "one taken first, to undo with");
  assert.equal(history.listSnapshots("dunshill")[0].reason, "before restore");
  assert.equal(result.undoSnapshot, history.listSnapshots("dunshill")[0].id);
  assert.deepEqual(given.playlists.names, ["Holiday"]);
  assert.deepEqual(given.playlists.then[0].songs, ["A/X/1.mp3", "A/X/2.mp3", "B/Y/1.mp3"], "as it was that day");
  assert.deepEqual(given.ratings, { "A/X/1.mp3": 5, "A/X/2.mp3": 3 });
  assert.deepEqual(given.tags.tracks["2"], ["holiday", "sunday"]);
  assert.equal(given.favourites, undefined, "what was not ticked is left alone");
  reset();
});

test("a snapshot belongs to its person", async () => {
  const other = userOps.createUser("helen", "hash");
  const [latest] = history.listSnapshots("dunshill");
  await assert.rejects(() => history.compareWithNow(other, latest.id, { deps }), /No such snapshot/);
  await assert.rejects(() => history.restoreSnapshot(other, latest.id, { sections: ["tags"], deps }), /No such snapshot/);
});

test("kept: the last 30 days, one a month for a year, and always the newest", async () => {
  db.prepare("DELETE FROM library_snapshots").run();
  const now = Date.UTC(2026, 8, 30, 12);
  for (let days = 0; days < 400; days += 1) {
    await history.takeSnapshot(dad, { deps, now: now - days * DAY });
  }
  history.pruneSnapshots({ now });
  const kept = history.listSnapshots("dunshill").map((entry) => entry.takenAt);
  const recent = kept.filter((at) => now - at <= 30 * DAY);
  const older = kept.filter((at) => now - at > 30 * DAY);
  assert.equal(recent.length, 31, "every day of the last month");
  assert.ok(older.length >= 11 && older.length <= 12, `about one a month before that (${older.length})`);
  assert.ok(older.every((at) => now - at <= 372 * DAY), "and nothing past a year");
  // Parts no snapshot uses any more are gone; the ones in use are kept.
  const used = new Set(db.prepare("SELECT parts_json FROM library_snapshots").all().flatMap((row) => Object.values(JSON.parse(row.parts_json))));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM library_snapshot_parts").get().n, used.size);
});

test("only an admin can see or restore someone's history", () => {
  const routes = readFileSync(new URL("../../backend/routes/users.js", import.meta.url), "utf8");
  for (const route of [
    'router.get("/:id/library-history", requireAuth, requireAdmin',
    'router.post("/:id/library-history", requireAuth, requireAdmin',
    'router.get("/:id/library-history/:snapshotId/compare", requireAuth, requireAdmin',
    'router.post("/:id/library-history/:snapshotId/restore", requireAuth, requireAdmin',
  ]) assert.ok(routes.includes(route), route);
  const server = readFileSync(new URL("../../backend/server.js", import.meta.url), "utf8");
  assert.match(server, /startLibraryHistory\(\)/);
});

// Putting back a long playlist has to leave exactly what was asked for. The
// single Subsonic call that was used before did not clear thousands of
// entries, and appended the restored list after what it left.

test("a playlist is rewritten to exactly the restored songs, or the restore says so", async () => {
  const fakeAdmin = ({ dropsSome = false } = {}) => {
    let entries = Array.from({ length: 12000 }, (_, i) => ({ id: String(i + 1), mediaFileId: `old-${i}` }));
    let next = 20000;
    return {
      getPlaylistTracks: async () => entries.map((entry) => ({ ...entry })),
      removePlaylistTracks: async (_id, ids) => {
        const gone = new Set(dropsSome ? ids.slice(50) : ids);
        entries = entries.filter((entry) => !gone.has(entry.id));
      },
      addPlaylistTracks: async (_id, songIds) => {
        entries.push(...songIds.map((mediaFileId) => ({ id: String(next++), mediaFileId })));
      },
      entries: () => entries,
    };
  };
  const wanted = Array.from({ length: 11997 }, (_, i) => `song-${i}`);
  const admin = fakeAdmin();
  assert.equal(await history.rewritePlaylistEntries(admin, "pl", wanted), 11997);
  assert.deepEqual(admin.entries().map((entry) => entry.mediaFileId), wanted, "in order, nothing left over");

  await assert.rejects(
    () => history.rewritePlaylistEntries(fakeAdmin({ dropsSome: true }), "pl", wanted),
    /has 12047 songs after restoring, not 11997/,
  );
  const source = readFileSync(new URL("../../backend/services/libraryHistoryService.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /client\.updatePlaylist\(playlistId, \{ name: entry\.name, songIds \}\)/);
});
