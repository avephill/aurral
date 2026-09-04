import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLibraries,
  planPlaylistPortability,
  resolveSharedEquivalents,
} from "../../backend/services/navidromePlaylistPortability.js";

const LIBRARIES = [
  { id: 1, name: "Music Library", path: "/music" },
  { id: 2, name: "Avery (old)", path: "/music-avery" },
  { id: 4, name: "avery", path: "/music-root/users/avery" },
  { id: 5, name: "dunshill", path: "/music-root/users/dunshill" },
];

test("libraries under the user-library root are the personal ones", () => {
  const { shared, personal } = classifyLibraries(LIBRARIES, "/music-root/users");
  assert.deepEqual(shared.map((l) => l.id), [1, 2]);
  assert.deepEqual(personal.map((l) => l.id), [4, 5]);
});

test("a trailing slash on the root does not change the split", () => {
  const { personal } = classifyLibraries(LIBRARIES, "/music-root/users/");
  assert.deepEqual(personal.map((l) => l.id), [4, 5]);
});

test("with no user-library root configured every library counts as shared", () => {
  const { shared, personal } = classifyLibraries(LIBRARIES, "");
  assert.equal(shared.length, 4);
  assert.equal(personal.length, 0);
});

test("a playlist built entirely from a shared library is portable", () => {
  const plan = planPlaylistPortability({
    playlist: { id: "p1", name: "Christmas", ownerName: "avery", public: true },
    tracks: [
      { id: "t1", libraryId: 1, path: "A/B/1.mp3" },
      { id: "t2", libraryId: 1, path: "A/B/2.mp3" },
    ],
    sharedLibraryIds: [1, 2],
  });
  assert.equal(plan.portable, true);
  assert.deepEqual(plan.foreign, []);
  assert.deepEqual(plan.tracksByLibrary, { 1: 2 });
});

test("a track added while browsing a personal library makes the playlist unportable", () => {
  const plan = planPlaylistPortability({
    playlist: { id: "p2", name: "Rock and Roll", ownerName: "dunshill", public: true },
    tracks: [
      { id: "t1", libraryId: 1, path: "A/B/1.mp3" },
      { id: "t2", libraryId: 4, path: "Abner Jay/True Story/07 - My Mule.mp3", title: "My Mule" },
    ],
    sharedLibraryIds: [1, 2],
  });
  assert.equal(plan.portable, false);
  assert.equal(plan.foreign.length, 1);
  assert.equal(plan.foreign[0].libraryId, 4);
  assert.equal(plan.foreign[0].title, "My Mule");
  assert.deepEqual(plan.tracksByLibrary, { 1: 1, 4: 1 });
});

test("a personal-library track maps to the same file in a shared library", async () => {
  const client = {
    findSongsByPath: async (path) => [
      { id: "lib4id", libraryId: 4, path },
      { id: "lib1id", libraryId: 1, path },
    ],
  };
  const { mapped, unmapped } = await resolveSharedEquivalents({
    client,
    foreign: [{ playlistTrackId: "t2", libraryId: 4, path: "A/B/1.mp3" }],
    sharedLibraryIds: [1, 2],
  });
  assert.deepEqual(unmapped, []);
  assert.equal(mapped[0].sharedMediaFileId, "lib1id");
  assert.equal(mapped[0].sharedLibraryId, 1);
});

test("a track that exists only in a personal library is reported, never guessed", async () => {
  const client = {
    findSongsByPath: async (path) => [{ id: "lib4id", libraryId: 4, path }],
  };
  const { mapped, unmapped } = await resolveSharedEquivalents({
    client,
    foreign: [{ playlistTrackId: "t2", libraryId: 4, path: "A/B/orphan.mp3" }],
    sharedLibraryIds: [1, 2],
  });
  assert.deepEqual(mapped, []);
  assert.equal(unmapped[0].reason, "not present in any shared library");
});

test("the same path is looked up once however many tracks share it", async () => {
  let calls = 0;
  const client = {
    findSongsByPath: async (path) => {
      calls += 1;
      return [{ id: "lib1id", libraryId: 1, path }];
    },
  };
  await resolveSharedEquivalents({
    client,
    foreign: [
      { playlistTrackId: "a", libraryId: 4, path: "A/B/1.mp3" },
      { playlistTrackId: "b", libraryId: 5, path: "A/B/1.mp3" },
    ],
    sharedLibraryIds: [1],
  });
  assert.equal(calls, 1);
});

test("a lookup failure is reported rather than dropping the track", async () => {
  const client = {
    findSongsByPath: async () => {
      throw new Error("navidrome down");
    },
  };
  const { mapped, unmapped } = await resolveSharedEquivalents({
    client,
    foreign: [{ playlistTrackId: "t", libraryId: 4, path: "A/B/1.mp3" }],
    sharedLibraryIds: [1],
  });
  assert.deepEqual(mapped, []);
  assert.equal(unmapped[0].reason, "lookup failed");
});
