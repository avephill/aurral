import assert from "node:assert/strict";
import test from "node:test";

import { planPlaylistRepair, repairPlaylist } from "../../backend/services/navidromePlaylistRepair.js";

const CANONICAL = 1;

const track = (id, mediaFileId, libraryId, path) => ({ id, mediaFileId, libraryId, path });

test("a playlist already built from a shared library is left untouched", () => {
  const plan = planPlaylistRepair({
    tracks: [track("e1", "m1", 1, "a.mp3"), track("e2", "m2", 1, "b.mp3")],
    canonicalLibraryId: CANONICAL,
  });
  assert.equal(plan.changed, false);
  assert.equal(plan.remapped, 0);
  assert.equal(plan.duplicatesRemoved, 0);
  assert.deepEqual(plan.desiredIds, ["m1", "m2"]);
});

test("a personal-library entry is rewritten to the shared copy", () => {
  const plan = planPlaylistRepair({
    tracks: [track("e1", "personal", 4, "a.mp3")],
    canonicalLibraryId: CANONICAL,
    canonicalIdByPath: new Map([["a.mp3", "sharedA"]]),
  });
  assert.deepEqual(plan.desiredIds, ["sharedA"]);
  assert.equal(plan.remapped, 1);
  assert.equal(plan.changed, true);
});

test("the same file added once per library collapses to one entry", () => {
  const plan = planPlaylistRepair({
    tracks: [
      track("e1", "m1", 1, "a.mp3"),
      track("e2", "p4", 4, "a.mp3"),
      track("e3", "p5", 5, "a.mp3"),
      track("e4", "m2", 2, "a.mp3"),
    ],
    canonicalLibraryId: CANONICAL,
    canonicalIdByPath: new Map([["a.mp3", "m1"]]),
  });
  // All four entries are the same file wearing four library ids, so exactly one
  // survives. Library 2 is not the canonical library, so its copy is a
  // duplicate too even though it is not a personal library.
  assert.deepEqual(plan.desiredIds, ["m1"]);
  assert.equal(plan.duplicatesRemoved, 3);
});

test("the first occurrence keeps its position", () => {
  const plan = planPlaylistRepair({
    tracks: [
      track("e1", "m1", 1, "a.mp3"),
      track("e2", "m2", 1, "b.mp3"),
      track("e3", "p", 4, "a.mp3"),
      track("e4", "m3", 1, "c.mp3"),
    ],
    canonicalLibraryId: CANONICAL,
    canonicalIdByPath: new Map([["a.mp3", "m1"]]),
  });
  assert.deepEqual(plan.desiredIds, ["m1", "m2", "m3"]);
});

test("a track with no shared copy makes the whole playlist unsafe to rewrite", () => {
  const plan = planPlaylistRepair({
    tracks: [track("e1", "m1", 1, "a.mp3"), track("e2", "orphan", 4, "gone.mp3")],
    canonicalLibraryId: CANONICAL,
    canonicalIdByPath: new Map(),
  });
  assert.equal(plan.safe, false);
  assert.equal(plan.changed, false, "an unsafe plan must never report itself as applicable");
  assert.equal(plan.unmapped.length, 1);
});

const fakeClient = ({ tracks, failAdd = false }) => {
  const state = { tracks: [...tracks], calls: [] };
  return {
    state,
    getPlaylistTracks: async () => state.tracks.map((t) => ({ ...t })),
    findSongsByPath: async (path) => [
      { id: `shared:${path}`, libraryId: 1, path },
      { id: `personal:${path}`, libraryId: 4, path },
    ],
    removePlaylistTracks: async (_id, entryIds) => {
      state.calls.push(["remove", entryIds.length]);
      state.tracks = state.tracks.filter((t) => !entryIds.includes(t.id));
    },
    addPlaylistTracks: async (_id, ids) => {
      state.calls.push(["add", ids.length]);
      if (failAdd) throw new Error("navidrome refused");
      state.tracks.push(
        ...ids.map((mediaFileId, i) => ({ id: `new${i}`, mediaFileId, libraryId: 1, path: `p${i}` })),
      );
    },
  };
};

test("a dry run reports the change without writing", async () => {
  const client = fakeClient({ tracks: [track("e1", "personal:a.mp3", 4, "a.mp3")] });
  const summary = await repairPlaylist({
    client,
    playlist: { id: "pl", name: "Test" },
    canonicalLibraryId: CANONICAL,
    dryRun: true,
  });
  assert.equal(summary.changed, true);
  assert.equal(summary.applied, false);
  assert.deepEqual(client.state.calls, [], "dry run must not call any write endpoint");
});

test("applying rewrites the playlist and verifies the result", async () => {
  const client = fakeClient({
    tracks: [
      track("e1", "shared:a.mp3", 1, "a.mp3"),
      track("e2", "personal:a.mp3", 4, "a.mp3"),
      track("e3", "shared:b.mp3", 1, "b.mp3"),
    ],
  });
  const summary = await repairPlaylist({
    client,
    playlist: { id: "pl", name: "Test" },
    canonicalLibraryId: CANONICAL,
    dryRun: false,
  });
  assert.equal(summary.applied, true);
  assert.equal(summary.before, 3);
  assert.equal(summary.after, 2);
  assert.equal(summary.duplicatesRemoved, 1);
  assert.equal(summary.verifiedCount, 2);
});

test("a failed rewrite restores the original entries", async () => {
  const original = [
    track("e1", "shared:a.mp3", 1, "a.mp3"),
    track("e2", "personal:a.mp3", 4, "a.mp3"),
  ];
  const client = fakeClient({ tracks: original, failAdd: true });
  await assert.rejects(
    repairPlaylist({ client, playlist: { id: "pl", name: "Test" }, canonicalLibraryId: CANONICAL, dryRun: false }),
    /navidrome refused/,
  );
  // The restore path re-adds the originals rather than leaving it emptied.
  const addCalls = client.state.calls.filter(([kind]) => kind === "add");
  assert.equal(addCalls.length, 2, "should retry an add to restore");
  assert.equal(addCalls[1][1], original.length);
});

test("a playlist generated from an .m3u or .NSP file is never rewritten", async () => {
  const client = fakeClient({ tracks: [track("e1", "personal:a.mp3", 4, "a.mp3")] });
  for (const playlist of [
    { id: "p1", name: "Album", path: "/music-root/users/avery/X/Y.m3u", sync: true },
    { id: "p2", name: "recently_added", path: "/music/playlist/recently_added.NSP", sync: true },
  ]) {
    const summary = await repairPlaylist({ client, playlist, canonicalLibraryId: CANONICAL, dryRun: false });
    assert.equal(summary.skipped, "file-backed");
    assert.equal(summary.applied, false);
  }
  // Navidrome re-syncs these from their source, so touching them is pointless
  // at best and fights the file at worst.
  assert.deepEqual(client.state.calls, []);
});
