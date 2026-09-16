import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// Sharing a playlist with one person. Navidrome has no per-user sharing, so
// the playlist is written again into the recipient's own account, resolved
// against the songs they can actually reach.

process.env.AURRAL_NAVIDROME_MUSIC_ROOT = "/data/Music/Library";

const [isolatedState, { db }, { userOps }, libraryStore, social] = await setupIsolatedBackend(
  "social",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/socialService.js",
);

const trackIds = {};
const PATHS = {};

test.before(() => {
  resetDatabase(db);
  for (const name of ["avery", "dunshill", "kitty"]) userOps.createUser(name, "hash");
  const artist = libraryStore.upsertLibraryArtist({ identityKey: "a", name: "Neko Case", metadata: {} });
  const album = libraryStore.upsertLibraryAlbum({ identityKey: "al", artistId: artist.id, title: "Blacklisted", metadata: {} });
  for (const name of ["shared", "outside"]) {
    const track = libraryStore.upsertLibraryTrack({ identityKey: `r:${name}`, title: name, artistName: "Neko Case", metadata: {} });
    trackIds[name] = track.id;
    PATHS[name] = `/data/Music/Library/Neko Case/Blacklisted/${name}.flac`;
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, discNumber: 1, trackNumber: 1 });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id, albumId: album.id, source: "lidarr", path: PATHS[name], durationMs: 200_000, available: true,
    });
  }
});

test.after(() => cleanupIsolatedState(isolatedState));

// dunshill can reach the shared library 1 and his own 5. The playlist holds
// three files: one he has a copy of, one that lives only in Avery's personal
// library, and one Psalter never indexed but Navidrome knows - which must
// still carry over.
const REL = {
  his: "Neko Case/Blacklisted/shared.flac",
  averyOnly: "Neko Case/Blacklisted/outside.flac",
  unindexed: "Schola Hungarica/Christmas/unindexed.flac",
};

function fakeDeps() {
  const playlists = new Map();
  const calls = [];
  const copies = {
    [REL.his]: [
      { id: "song-shared-main", path: REL.his, libraryId: 1 },
      { id: "song-shared-his", path: REL.his, libraryId: 5 },
    ],
    [REL.averyOnly]: [{ id: "song-outside-avery", path: REL.averyOnly, libraryId: 4 }],
    [REL.unindexed]: [{ id: "song-unindexed-main", path: REL.unindexed, libraryId: 1 }],
  };
  const admin = {
    isConfigured: () => true,
    async getPlaylistRecord(id) {
      return id === "pl-1" ? { id, name: "Road trip", ownerName: "avery" } : null;
    },
    async getPlaylistTracks() {
      return [
        { mediaFileId: "song-shared-main", path: REL.his },
        { mediaFileId: "song-outside-avery", path: REL.averyOnly },
        { mediaFileId: "song-unindexed-main", path: REL.unindexed },
      ];
    },
    async getUsers() {
      return [{ id: "nd-dunshill", userName: "dunshill" }];
    },
    async getUserLibraries() {
      return [{ id: 1 }, { id: 5 }];
    },
  };
  return {
    playlists,
    calls,
    adminClient: () => admin,
    songsByPath: async (path) => copies[path] || [],
    personalLibraryId: async () => 5,
    userClient: (username) => ({
      user: username,
      async getSubsonicPlaylist(id) {
        return playlists.has(id) ? { id, entry: playlists.get(id).songIds.map((songId) => ({ id: songId })) } : null;
      },
      async createPlaylist(name, songIds) {
        const id = `mirror-${playlists.size + 1}`;
        playlists.set(id, { owner: username, name, songIds });
        calls.push({ verb: "create", username, name, songIds });
        return { id };
      },
      async updatePlaylist(id, { name, songIds }) {
        playlists.set(id, { owner: username, name, songIds });
        calls.push({ verb: "update", username, name, songIds });
      },
      async deletePlaylist(id) {
        playlists.delete(id);
        calls.push({ verb: "delete", username, id });
      },
      async request() {
        return {};
      },
    }),
  };
}

test("a shared playlist is written into the recipient's own account", async () => {
  const deps = fakeDeps();
  const result = await social.sharePlaylist({
    owner: "avery", playlistId: "pl-1", recipients: ["dunshill"], deps,
  });
  assert.deepEqual(result.shared, [{ recipient: "dunshill", songs: 2, missing: 1, status: "written" }]);

  // His copy holds only the song he can reach, and says who it came from.
  const [created] = deps.calls;
  assert.equal(created.verb, "create");
  assert.equal(created.username, "dunshill");
  assert.equal(created.name, "Road trip (from avery)");
  // His own copy of the first, the shared library's copy of the one Psalter
  // does not index, and nothing from Avery's private library.
  assert.deepEqual(created.songIds, ["song-shared-his", "song-unindexed-main"]);

  const received = social.listSharesForRecipient("dunshill");
  assert.equal(received.length, 1);
  assert.equal(received[0].owner, "avery");
  assert.equal(received[0].missing, 1);
  assert.equal(received[0].songCount, 2);
  // Nobody else sees it.
  assert.deepEqual(social.listSharesForRecipient("kitty"), []);
});

test("an unchanged playlist is not written again", async () => {
  const deps = fakeDeps();
  await social.sharePlaylist({ owner: "avery", playlistId: "pl-1", recipients: ["dunshill"], deps });
  const before = deps.calls.length;
  const share = db.prepare("SELECT * FROM playlist_shares WHERE recipient = 'dunshill'").get();
  const again = await social.syncShare(share, deps);
  assert.equal(again.status, "unchanged");
  assert.equal(deps.calls.length, before);
});

test("only the owner can share a playlist, and only with people who exist", async () => {
  const deps = fakeDeps();
  await assert.rejects(
    () => social.sharePlaylist({ owner: "kitty", playlistId: "pl-1", recipients: ["dunshill"], deps }),
    /not yours to share/,
  );
  await assert.rejects(
    () => social.sharePlaylist({ owner: "avery", playlistId: "pl-1", recipients: ["nobody"], deps }),
    /No Psalter user/,
  );
});

test("stopping a share leaves their copy unless asked to remove it", async () => {
  const deps = fakeDeps();
  await social.sharePlaylist({ owner: "avery", playlistId: "pl-1", recipients: ["dunshill"], deps });
  const share = db.prepare("SELECT * FROM playlist_shares WHERE recipient = 'dunshill'").get();
  const result = await social.removeShare({ id: share.id, requester: "avery", deleteCopy: true, deps });
  assert.equal(result.removed, true);
  assert.equal(result.copyDeleted, true);
  assert.deepEqual(social.listSharesForRecipient("dunshill"), []);
  assert.ok(deps.calls.some((call) => call.verb === "delete"));
});

test("a recommendation reaches named people, or everyone", () => {
  const toOne = social.createRecommendation({
    sender: "avery", kind: "track", targetId: trackIds.shared, note: "for the drive", recipients: ["dunshill"],
  });
  assert.equal(toOne.sent, 1);
  assert.equal(toOne.toEveryone, false);

  social.createRecommendation({ sender: "avery", kind: "track", targetId: trackIds.outside });

  const his = social.listRecommendationsFor("dunshill");
  assert.equal(his.inbox.length, 2, "his own plus the one for everyone");
  assert.equal(his.unread, 2);
  assert.equal(his.inbox.some((entry) => entry.note === "for the drive"), true);
  // The sender does not get their own broadcast back.
  assert.equal(social.listRecommendationsFor("avery").inbox.length, 0);
  assert.equal(social.listRecommendationsFor("avery").sent.length, 2);

  assert.equal(social.markRecommendationsRead("dunshill") >= 2, true);
  assert.equal(social.listRecommendationsFor("dunshill").unread, 0);

  const first = his.inbox[0];
  social.dismissRecommendation({ id: first.id, requester: "dunshill" });
  assert.equal(social.listRecommendationsFor("dunshill").inbox.length, 1);
});

test("a recommendation has to point at something really on the server", () => {
  assert.throws(
    () => social.createRecommendation({ sender: "avery", kind: "album", targetId: 999999 }),
    /not in the library/,
  );
  assert.throws(
    () => social.createRecommendation({ sender: "avery", kind: "mixtape", targetId: 1 }),
    /album, a song or a playlist/,
  );
});

test("listening is shown unless a person turns it off", () => {
  assert.equal(social.getSocialSettings("dunshill").shareListening, true);
  assert.equal(social.setShareListening("dunshill", false).shareListening, false);
  assert.equal(social.getSocialSettings("dunshill").shareListening, false);
  assert.equal(social.setShareListening("dunshill", true).shareListening, true);
});
