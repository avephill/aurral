import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// A playlist shown to a congregation: anyone in it may take a copy or not,
// and the owner is never told who did.

process.env.AURRAL_NAVIDROME_MUSIC_ROOT = "/data/Music/Library";

const [isolatedState, { db }, { userOps }, social, listings] = await setupIsolatedBackend(
  "congregation-playlists",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/socialService.js",
  "backend/services/congregationPlaylistService.js",
);

const congregation = {};

// Family: Dad, Avery and Helen. Choir: Dad and Kitty. Kitty is not family,
// and Helen is not in the choir.
test.before(() => {
  resetDatabase(db);
  for (const table of ["congregations", "congregation_members", "playlist_shares", "congregation_playlists", "congregation_playlist_audience"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  for (const name of ["dunshill", "avery", "helen", "kitty"]) userOps.createUser(name, "hash");
  const at = Date.now();
  for (const [name, members] of [["Family", ["dunshill", "avery", "helen"]], ["Choir", ["dunshill", "kitty"]]]) {
    congregation[name] = db.prepare(`
      INSERT INTO congregations (name, description, enrollment, created_at, updated_at) VALUES (?, '', 'assigned', ?, ?)
    `).run(name, at, at).lastInsertRowid;
    for (const member of members) {
      db.prepare("INSERT INTO congregation_members (congregation_id, username, joined_at) VALUES (?, ?, ?)")
        .run(congregation[name], member, at);
    }
  }
});

test.after(() => cleanupIsolatedState(isolatedState));

const REL = {
  mine: "Bing Crosby/White Christmas/01.flac",
  notMine: "Various Artists/A Very Special Christmas/03.flac",
};

function fakeDeps() {
  const playlists = new Map();
  const albumsAdded = [];
  const admin = {
    isConfigured: () => true,
    async getPlaylistRecord(id) {
      return id === "holiday" ? { id, name: "Holiday", ownerName: "dunshill", updatedAt: "2026-09-23T00:00:00Z" } : null;
    },
    async getPlaylistTracks() {
      return [{ mediaFileId: "a", path: REL.mine }, { mediaFileId: "b", path: REL.notMine }];
    },
    async getUsers() {
      return ["avery", "helen", "kitty"].map((name) => ({ id: `nd-${name}`, userName: name }));
    },
    async getUserLibraries() {
      return [{ id: 6 }];
    },
  };
  return {
    playlists,
    albumsAdded,
    adminClient: () => admin,
    songsByPath: async (path) => (path === REL.mine
      ? [{ id: "mine-main", path, libraryId: 1 }, { id: "mine-hers", path, libraryId: 6 }]
      : [{ id: "notmine-main", path, libraryId: 1 }]),
    personalLibraryId: async () => 6,
    canAddAlbums: () => true,
    addAlbums: (username, folders, addedFor) => {
      albumsAdded.push({ username, folders, addedFor });
      return folders.length;
    },
    libraryReady: async () => {},
    userClient: (username) => ({
      async getSubsonicPlaylist(id) {
        return playlists.has(id) ? { id } : null;
      },
      async createPlaylist(name, songIds) {
        const id = `copy-${playlists.size + 1}`;
        playlists.set(id, { owner: username, name, songIds });
        return { id };
      },
      async updatePlaylist(id, { name, songIds }) {
        playlists.set(id, { owner: username, name, songIds });
      },
    }),
  };
}

test("a playlist is shown only to the congregations its owner chose, and only theirs", async () => {
  const deps = fakeDeps();
  await assert.rejects(
    () => listings.listPlaylist({ owner: "avery", playlistId: "holiday", congregationIds: [congregation.Family], deps }),
    /not yours/,
  );
  await assert.rejects(
    () => listings.listPlaylist({ owner: "dunshill", playlistId: "holiday", congregationIds: [], deps }),
    /at least one/,
  );
  const shown = await listings.listPlaylist({
    owner: "dunshill", playlistId: "holiday", congregationIds: [congregation.Family], deps,
  });
  assert.deepEqual(shown.congregations.map((entry) => entry.name), ["Family"]);

  assert.equal(listings.listingsFor("helen").length, 1);
  assert.equal(listings.listingsFor("avery").length, 1);
  assert.deepEqual(listings.listingsFor("kitty"), [], "the choir was not chosen");
  assert.deepEqual(listings.listingsFor("dunshill"), [], "not shown back to its owner");
  await assert.rejects(() => listings.previewListing({ id: shown.id, requester: "kitty", deps }), /No such playlist/);
});

test("taking one asks about albums first, then follows the owner's playlist", async () => {
  const deps = fakeDeps();
  const [listing] = listings.listingsFor("helen");
  assert.equal(listing.taken, null);

  const plan = await listings.previewListing({ id: listing.id, requester: "helen", deps });
  assert.equal(plan.have, 1);
  assert.deepEqual(plan.albums.map((album) => album.folder), ["Various Artists/A Very Special Christmas"]);
  assert.equal(deps.playlists.size, 0, "looking writes nothing");

  const result = await listings.takeListing({ id: listing.id, requester: "helen", deps });
  assert.equal(result.albumsAdded, 1);
  assert.equal(deps.albumsAdded[0].addedFor, "Holiday (from dunshill)");
  const [copy] = [...deps.playlists.values()];
  assert.equal(copy.owner, "helen");
  assert.equal(copy.name, "Holiday (from dunshill)");

  const [after] = listings.listingsFor("helen");
  assert.ok(after.taken, "shown as hers now");
  // It is on the congregation list, not among playlists shared with her by name.
  assert.deepEqual(social.listSharesForRecipient("helen"), []);
});

test("the owner is never told who took a copy", () => {
  assert.deepEqual(social.listSharesByOwner("dunshill"), []);
  const [mine] = listings.listingsBy("dunshill");
  assert.deepEqual(Object.keys(mine).sort(), ["congregations", "id", "name", "sourcePlaylistId"]);
});

test("taking it off the list leaves everyone's copy as their own", async () => {
  const [mine] = listings.listingsBy("dunshill");
  assert.throws(() => listings.unlistPlaylist({ id: mine.id, requester: "helen" }), /not yours/);
  listings.unlistPlaylist({ id: mine.id, requester: "dunshill" });
  assert.deepEqual(listings.listingsFor("helen"), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playlist_shares").get().n, 0, "no longer followed");
});

test("a playlist already shared by name is not offered again on the list", async () => {
  const deps = fakeDeps();
  await social.sharePlaylist({ owner: "dunshill", playlistId: "holiday", recipients: ["avery"], deps });
  await listings.listPlaylist({ owner: "dunshill", playlistId: "holiday", congregationIds: [congregation.Family], deps });
  assert.deepEqual(listings.listingsFor("avery"), []);
  assert.equal(listings.listingsFor("helen").length, 1);
});
