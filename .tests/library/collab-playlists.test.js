import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  shareWithEveryone,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// A playlist several people build together. Navidrome gives a playlist one
// owner and nobody else a way to change it, so the real list lives in Psalter
// and everyone holds a copy; what they do to their copy is read back.

process.env.AURRAL_NAVIDROME_MUSIC_ROOT = "/data/Music/Library";

const [isolatedState, { db }, { userOps }, libraryStore, , collab] = await setupIsolatedBackend(
  "collab",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/socialService.js",
  "backend/services/collabPlaylistService.js",
);

const REL = {
  one: "Neko Case/Blacklisted/one.flac",
  two: "Neko Case/Blacklisted/two.flac",
  hers: "Neko Case/Blacklisted/hers.flac",
};

test.before(() => {
  resetDatabase(db);
  for (const name of ["avery", "dunshill"]) userOps.createUser(name, "hash");
  // Sharing needs a congregation in common; this suite is about what is
  // shared, not about who may.
  shareWithEveryone(db);
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "a", name: "Neko Case", metadata: {} });
  const album = libraryStore.upsertLibraryAlbum({ identityKey: "al", artistId: artist.id, title: "Blacklisted", metadata: {} });
  for (const [key, rel] of Object.entries(REL)) {
    const track = libraryStore.upsertLibraryTrack({ identityKey: `r:${key}`, title: key, artistName: "Neko Case", metadata: {} });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, discNumber: 1, trackNumber: 1 });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id, albumId: album.id, source: "lidarr",
      path: `/data/Music/Library/${rel}`, durationMs: 200_000, available: true,
    });
  }
});

test.after(() => cleanupIsolatedState(isolatedState));

// Every song exists in both libraries except "hers", which only dunshill has.
const startClean = () => {
  db.prepare("DELETE FROM collab_tracks").run();
  db.prepare("DELETE FROM collab_members").run();
  db.prepare("DELETE FROM collab_playlists").run();
};

function fakeDeps() {
  const playlists = new Map();
  const copies = {
    [REL.one]: [{ id: "one-avery", path: REL.one, libraryId: 4 }, { id: "one-dun", path: REL.one, libraryId: 5 }],
    [REL.two]: [{ id: "two-avery", path: REL.two, libraryId: 4 }, { id: "two-dun", path: REL.two, libraryId: 5 }],
    [REL.hers]: [{ id: "hers-dun", path: REL.hers, libraryId: 5 }],
  };
  const songToPath = new Map(
    Object.entries(copies).flatMap(([path, songs]) => songs.map((song) => [song.id, path])),
  );
  const libraryOf = { avery: 4, dunshill: 5 };
  const admin = {
    isConfigured: () => true,
    async getPlaylistRecord(id) {
      return id === "seed" ? { id, name: "Road trip", ownerName: "avery" } : null;
    },
    async getPlaylistTracks() {
      return [{ path: REL.one }, { path: REL.two }];
    },
    async getUsers() {
      return [{ id: "nd-avery", userName: "avery" }, { id: "nd-dun", userName: "dunshill" }];
    },
    async getUserLibraries(id) {
      return id === "nd-avery" ? [{ id: 1 }, { id: 4 }] : [{ id: 1 }, { id: 5 }];
    },
    async getSongsByIds(ids) {
      return ids.map((id) => ({ id, path: `/data/Music/Library/${songToPath.get(String(id))}` }));
    },
  };
  return {
    playlists,
    adminClient: () => admin,
    pathsForSongIds: async (ids) => new Map(ids.map((id) => [String(id), songToPath.get(String(id)) || ""])),
    songsByPath: async (path) => copies[path] || [],
    personalLibraryId: async (username) => libraryOf[username],
    userClient: (username) => ({
      user: username,
      async getSubsonicPlaylist(id) {
        const entry = playlists.get(id);
        return entry ? { id, entry: entry.songIds.map((songId) => ({ id: songId })) } : null;
      },
      async createPlaylist(name, songIds) {
        const id = `copy-${playlists.size + 1}`;
        playlists.set(id, { owner: username, name, songIds: [...songIds] });
        return { id };
      },
      async updatePlaylist(id, { name, songIds }) {
        playlists.set(id, { owner: username, name, songIds: [...songIds] });
      },
      async deletePlaylist(id) {
        playlists.delete(id);
      },
    }),
  };
}

const copyOf = (deps, username) =>
  [...deps.playlists.entries()].find(([, value]) => value.owner === username);

test("everyone gets their own copy, holding what their library has", async () => {
  startClean();
  const deps = fakeDeps();
  const made = await collab.createCollabPlaylist({
    owner: "avery", name: "Road trip", members: ["dunshill"], fromPlaylistId: "seed", deps,
  });
  assert.equal(made.songs, 2);

  const [, mine] = copyOf(deps, "avery");
  const [, theirs] = copyOf(deps, "dunshill");
  assert.equal(mine.name, "Road trip");
  assert.deepEqual(mine.songIds, ["one-avery", "two-avery"], "his own library's copies");
  assert.deepEqual(theirs.songIds, ["one-dun", "two-dun"]);

  const listed = collab.listCollabPlaylistsFor("dunshill");
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].members, ["avery", "dunshill"]);
  assert.equal(listed[0].isOwner, false);
});

test("a song one of them adds to their copy reaches everyone", async () => {
  startClean();
  const deps = fakeDeps();
  const { id } = await collab.createCollabPlaylist({
    owner: "avery", name: "Road trip", members: ["dunshill"], fromPlaylistId: "seed", deps,
  });
  const [theirId, theirs] = copyOf(deps, "dunshill");
  deps.playlists.set(theirId, { ...theirs, songIds: [...theirs.songIds, "hers-dun"] });

  await collab.syncCollabPlaylist(id, deps);

  // Avery's library does not hold it, so his copy cannot, and it is counted.
  const [, mine] = copyOf(deps, "avery");
  assert.deepEqual(mine.songIds, ["one-avery", "two-avery"]);
  assert.equal(collab.listCollabPlaylistsFor("avery")[0].missing, 1);
  assert.equal(collab.listCollabPlaylistsFor("avery")[0].songCount, 3, "the shared list has it");
});

test("a song missing from one library is not read as them deleting it", async () => {
  startClean();
  const deps = fakeDeps();
  const { id } = await collab.createCollabPlaylist({
    owner: "avery", name: "Road trip", members: ["dunshill"], fromPlaylistId: "seed", deps,
  });
  const [theirId, theirs] = copyOf(deps, "dunshill");
  deps.playlists.set(theirId, { ...theirs, songIds: [...theirs.songIds, "hers-dun"] });
  await collab.syncCollabPlaylist(id, deps);

  // Avery never had that song written into his copy, so passing over it again
  // must not take it off the shared list.
  await collab.syncCollabPlaylist(id, deps);
  assert.equal(collab.listCollabPlaylistsFor("avery")[0].songCount, 3);
});

test("taking a song out of your copy takes it out for everyone", async () => {
  startClean();
  const deps = fakeDeps();
  const { id } = await collab.createCollabPlaylist({
    owner: "avery", name: "Road trip", members: ["dunshill"], fromPlaylistId: "seed", deps,
  });
  const [mineId, mine] = copyOf(deps, "avery");
  deps.playlists.set(mineId, { ...mine, songIds: mine.songIds.filter((songId) => songId !== "two-avery") });

  await collab.syncCollabPlaylist(id, deps);
  const [, theirs] = copyOf(deps, "dunshill");
  assert.deepEqual(theirs.songIds, ["one-dun"]);
  assert.equal(collab.listCollabPlaylistsFor("avery")[0].songCount, 1);
});

test("a copy that comes back empty does not empty it for everyone", async () => {
  startClean();
  const deps = fakeDeps();
  const { id } = await collab.createCollabPlaylist({
    owner: "avery", name: "Road trip", members: ["dunshill"], fromPlaylistId: "seed", deps,
  });
  const [theirId, theirs] = copyOf(deps, "dunshill");
  deps.playlists.set(theirId, { ...theirs, songIds: [] });

  await collab.syncCollabPlaylist(id, deps);
  assert.equal(collab.listCollabPlaylistsFor("avery")[0].songCount, 2, "left alone");
  const [, restored] = copyOf(deps, "dunshill");
  assert.deepEqual(restored.songIds, ["one-dun", "two-dun"], "and put back");
});

test("deleting your copy is how you leave, and the rest carry on", async () => {
  startClean();
  const deps = fakeDeps();
  const { id } = await collab.createCollabPlaylist({
    owner: "avery", name: "Road trip", members: ["dunshill"], fromPlaylistId: "seed", deps,
  });
  const [theirId] = copyOf(deps, "dunshill");
  deps.playlists.delete(theirId);

  await collab.syncCollabPlaylist(id, deps);
  assert.deepEqual(collab.listCollabPlaylistsFor("dunshill"), []);
  assert.deepEqual(collab.listCollabPlaylistsFor("avery")[0].members, ["avery"]);
});

test("a smart playlist cannot be built together, but its songs can start one", async () => {
  startClean();
  const deps = fakeDeps();
  const admin = deps.adminClient();
  const record = await admin.getPlaylistRecord("seed");
  admin.getPlaylistRecord = async (id) =>
    (id === "seed" ? { ...record, rules: { all: [{ is: { genre: "jazz" } } ] } } : null);

  await assert.rejects(
    () => collab.createCollabPlaylist({
      owner: "avery", name: "Rules", members: ["dunshill"], fromPlaylistId: "seed", deps,
    }),
    /keeps itself, so it cannot be built together/,
  );

  // Nothing half-made is left behind by the refusal.
  assert.deepEqual(collab.listCollabPlaylistsFor("avery"), []);
});

test("only the person who started it can put someone out, or end it", async () => {
  startClean();
  const deps = fakeDeps();
  const { id } = await collab.createCollabPlaylist({
    owner: "avery", name: "Road trip", members: ["dunshill"], fromPlaylistId: "seed", deps,
  });
  assert.throws(
    () => collab.removeCollabMember({ id, requester: "dunshill", username: "avery" }),
    /Only the person who started it/,
  );
  assert.throws(
    () => collab.deleteCollabPlaylist({ id, requester: "dunshill" }),
    /not yours to end/,
  );
  // But anyone can walk away themselves.
  collab.removeCollabMember({ id, requester: "dunshill", username: "dunshill" });
  assert.deepEqual(collab.listCollabPlaylistsFor("dunshill"), []);
});
