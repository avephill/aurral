import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { removeVisibleEntries, rewritePlaylistEntries } from "../../backend/services/navidromePlaylistWrites.js";

// Someone's own connection hides playlist entries from libraries they cannot
// open, and Navidrome counts positions against the whole list. Tried for real
// with Helen's account: a playlist of [X, A, B] with X only in the main
// library showed her [A, B], and removing her first song removed X.

const X = { id: "e1", mediaFileId: "X", libraryId: 1 };
const A = { id: "e2", mediaFileId: "A", libraryId: 6 };
const B = { id: "e3", mediaFileId: "B", libraryId: 6 };

function fakes(entries, { isAdmin = false } = {}) {
  let all = [...entries];
  const admin = {
    getUsers: async () => [{ id: "nd-helen", userName: "helen", isAdmin }],
    getUserLibraries: async () => [{ id: 6 }],
    getPlaylistTracks: async () => all.map((entry) => ({ ...entry })),
    removePlaylistTracks: async (_id, ids) => {
      all = all.filter((entry) => !ids.includes(entry.id));
    },
    addPlaylistTracks: async (_id, ids) => {
      all.push(...ids.map((mediaFileId, index) => ({ id: `new-${index}`, mediaFileId, libraryId: 6 })));
    },
  };
  // What her own connection shows: only what she can open.
  const client = {
    getPlaylist: async () => ({
      entry: all.filter((entry) => isAdmin || entry.libraryId === 6).map((entry) => ({ id: entry.mediaFileId })),
    }),
  };
  return { admin, client, all: () => all.map((entry) => entry.mediaFileId) };
}

test("removing what someone sees at a position removes that song, not a hidden one", async () => {
  const world = fakes([X, A, B]);
  const removed = await removeVisibleEntries({ ...world, playlistId: "p", username: "helen", indexes: [0] });
  assert.equal(removed, 1);
  assert.deepEqual(world.all(), ["X", "B"], "A went, and the song she cannot see stayed");
});

test("an admin sees every entry, so positions are the whole list's", async () => {
  const world = fakes([X, A, B], { isAdmin: true });
  await removeVisibleEntries({ ...world, playlistId: "p", username: "helen", indexes: [0] });
  assert.deepEqual(world.all(), ["A", "B"]);
});

test("if their view no longer lines up, nothing is removed", async () => {
  const world = fakes([X, A, B]);
  world.client.getPlaylist = async () => ({ entry: [{ id: "B" }, { id: "A" }] });
  await assert.rejects(
    () => removeVisibleEntries({ ...world, playlistId: "p", username: "helen", indexes: [0] }),
    /edited elsewhere/,
  );
  assert.deepEqual(world.all(), ["X", "A", "B"]);
});

test("a rewrite clears every entry, hidden ones too, and checks the count", async () => {
  const world = fakes([X, A, B]);
  assert.equal(await rewritePlaylistEntries(world.admin, "p", ["B", "A"]), 2);
  assert.deepEqual(world.all(), ["B", "A"]);
});

test("a person's own connection changes entries through these, not by position", () => {
  const source = readFileSync(new URL("../../backend/services/navidromeUserClient.js", import.meta.url), "utf8");
  assert.match(source, /removeVisibleEntries\(\{ admin, client: this, playlistId, username: this\.user, indexes \}\)/);
  assert.match(source, /await rewritePlaylistEntries\(admin, playlistId, songIds\)/);
  const routes = readFileSync(new URL("../../backend/routes/navidromePlaylists.js", import.meta.url), "utf8");
  assert.match(routes, /if \(error instanceof PlaylistWriteError\)/);
});
