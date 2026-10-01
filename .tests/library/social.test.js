import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  shareWithEveryone,
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
  // Sharing needs a congregation in common; this suite is about what is
  // shared, not about who may.
  shareWithEveryone(db);
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
  const source = { name: "Road trip", updatedAt: "2026-09-17T00:00:00Z" };
  const admin = {
    isConfigured: () => true,
    source,
    async getPlaylistRecord(id) {
      return id === "pl-1" ? { id, name: source.name, updatedAt: source.updatedAt, ownerName: "avery" } : null;
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
  const albumsAdded = [];
  return {
    playlists,
    calls,
    source,
    copies,
    albumsAdded,
    adminClient: () => admin,
    songsByPath: async (path) => copies[path] || [],
    personalLibraryId: async () => 5,
    // Personal libraries are off unless a test turns them on.
    canAddAlbums: () => false,
    addAlbums: (username, folders, addedFor) => {
      albumsAdded.push({ username, folders, addedFor });
      return folders.length;
    },
    libraryReady: async () => {},
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

const shareRow = (recipient = "dunshill") =>
  db.prepare("SELECT * FROM playlist_shares WHERE recipient = ?").get(recipient);

// Share it with him and have him add it, as most of these tests need.
async function shareAndAdd(deps) {
  await social.sharePlaylist({ owner: "avery", playlistId: "pl-1", recipients: ["dunshill"], deps });
  return social.acceptShare({ id: shareRow().id, requester: "dunshill", deps });
}

test("a shared playlist waits for the recipient to add it", async () => {
  const deps = fakeDeps();
  const result = await social.sharePlaylist({
    owner: "avery", playlistId: "pl-1", recipients: ["dunshill"], deps,
  });
  assert.deepEqual(result.shared, [{ recipient: "dunshill" }]);
  assert.equal(deps.calls.length, 0, "nothing written into his account yet");
  const [waiting] = social.listSharesForRecipient("dunshill");
  assert.equal(waiting.acceptedAt, null);
  // The quarter-hourly pass leaves it alone too.
  assert.equal((await social.syncShare(shareRow(), deps)).status, "waiting");
  assert.equal(deps.calls.length, 0);
  db.prepare("DELETE FROM playlist_shares").run();
});

test("a shared playlist is written into the recipient's own account", async () => {
  const deps = fakeDeps();
  const result = await shareAndAdd(deps);
  assert.equal(result.status, "written");
  assert.equal(result.songs, 2);
  assert.equal(result.missing, 1);

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
  // Each fake starts with no playlists in it, so begin from nothing shared:
  // otherwise the copy an earlier test made looks like one deleted since.
  db.prepare("DELETE FROM playlist_shares").run();
  const deps = fakeDeps();
  await shareAndAdd(deps);
  const before = deps.calls.length;
  const share = db.prepare("SELECT * FROM playlist_shares WHERE recipient = 'dunshill'").get();
  const again = await social.syncShare(share, deps);
  assert.equal(again.status, "unchanged");
  assert.equal(deps.calls.length, before);
});

test("only the owner can share a playlist, and only with people who exist", async () => {
  db.prepare("DELETE FROM playlist_shares").run();
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
  db.prepare("DELETE FROM playlist_shares").run();
  const deps = fakeDeps();
  await shareAndAdd(deps);
  const share = db.prepare("SELECT * FROM playlist_shares WHERE recipient = 'dunshill'").get();
  const result = await social.removeShare({ id: share.id, requester: "avery", deleteCopy: true, deps });
  assert.equal(result.removed, true);
  assert.equal(result.copyDeleted, true);
  assert.deepEqual(social.listSharesForRecipient("dunshill"), []);
  assert.ok(deps.calls.some((call) => call.verb === "delete"));
});

test("turning a share down changes nothing the sharer can see", async () => {
  db.prepare("DELETE FROM playlist_shares").run();
  const deps = fakeDeps();
  await social.sharePlaylist({ owner: "avery", playlistId: "pl-1", recipients: ["dunshill"], deps });
  const before = social.listSharesByOwner("avery");
  await social.removeShare({ id: shareRow().id, requester: "dunshill", deps });

  assert.deepEqual(social.listSharesForRecipient("dunshill"), [], "gone from his page");
  assert.deepEqual(social.listSharesByOwner("avery"), before, "and hers reads exactly as it did");
  assert.deepEqual(Object.keys(before[0]).sort(), ["id", "name", "recipient", "sourcePlaylistId"]);
});

test("a copy the recipient throws away is not put back", async () => {
  db.prepare("DELETE FROM playlist_shares").run();
  const deps = fakeDeps();
  await shareAndAdd(deps);
  const mirrorId = [...deps.playlists.keys()][0];

  // He deletes it in his own client, as anyone may with a playlist of theirs.
  deps.playlists.delete(mirrorId);
  const share = db.prepare("SELECT * FROM playlist_shares WHERE recipient = 'dunshill'").get();
  assert.equal((await social.syncShare(share, deps)).status, "dropped");
  assert.equal(deps.playlists.size, 0, "nothing written back");

  // And it stays gone on the next pass, rather than reappearing every quarter hour.
  const dropped = db.prepare("SELECT * FROM playlist_shares WHERE recipient = 'dunshill'").get();
  assert.equal((await social.syncShare(dropped, deps)).status, "dropped");
  assert.equal(deps.playlists.size, 0);
  assert.deepEqual(social.listSharesForRecipient("dunshill"), [], "and off his page");

  // Sharing it again is asking again: nothing until he says yes, then a fresh copy.
  await social.sharePlaylist({ owner: "avery", playlistId: "pl-1", recipients: ["dunshill"], deps });
  assert.equal(deps.playlists.size, 0);
  assert.equal(social.listSharesForRecipient("dunshill")[0].acceptedAt, null);
  await social.acceptShare({ id: shareRow().id, requester: "dunshill", deps });
  assert.equal(deps.playlists.size, 1);
  assert.equal(social.listSharesForRecipient("dunshill").length, 1);
});

test("renaming your playlist renames their copy", async () => {
  db.prepare("DELETE FROM playlist_shares").run();
  const deps = fakeDeps();
  await shareAndAdd(deps);

  deps.source.name = "Long drive";
  deps.source.updatedAt = "2026-09-18T00:00:00Z";
  const share = db.prepare("SELECT * FROM playlist_shares WHERE recipient = 'dunshill'").get();
  await social.syncShare(share, deps);

  const mirror = [...deps.playlists.values()][0];
  assert.equal(mirror.name, "Long drive (from avery)");
  assert.equal(social.listSharesForRecipient("dunshill")[0].name, "Long drive");
});

test("a playlist nobody has touched is not worked out again", async () => {
  db.prepare("DELETE FROM playlist_shares").run();
  const deps = fakeDeps();
  await shareAndAdd(deps);

  // One song was missing from his library, so it is still looked at each pass:
  // what he was missing may have arrived.
  let share = db.prepare("SELECT * FROM playlist_shares WHERE recipient = 'dunshill'").get();
  assert.equal(share.missing_count, 1);
  const lookups = [];
  const watched = { ...deps, songsByPath: async (path) => { lookups.push(path); return deps.songsByPath(path); } };
  await social.syncShare(share, watched);
  assert.ok(lookups.length > 0, "still resolved while something is missing");

  // With nothing missing and the source untouched, it settles.
  db.prepare("UPDATE playlist_shares SET missing_count = 0 WHERE id = ?").run(share.id);
  share = db.prepare("SELECT * FROM playlist_shares WHERE recipient = 'dunshill'").get();
  lookups.length = 0;
  assert.equal((await social.syncShare(share, watched)).status, "unchanged");
  assert.equal(lookups.length, 0, "no per-song lookups at all");
});

test("adding a shared playlist asks for the albums its songs need, not whole artists", async () => {
  db.prepare("DELETE FROM playlist_shares").run();
  const deps = { ...fakeDeps(), canAddAlbums: () => true };
  await social.sharePlaylist({ owner: "avery", playlistId: "pl-1", recipients: ["dunshill"], deps });
  const { id } = shareRow();

  // Only the person it is for can look, or say yes.
  await assert.rejects(() => social.previewShare({ id, requester: "avery", deps }), /not for you/);
  await assert.rejects(() => social.acceptShare({ id, requester: "kitty", deps }), /not for you/);

  // He can play two of the three songs; the third is in Avery's library
  // only, and its album folder is what would be added.
  const plan = await social.previewShare({ id, requester: "dunshill", deps });
  assert.equal(plan.songs, 3);
  assert.equal(plan.have, 2);
  assert.equal(plan.missing, 1);
  assert.deepEqual(plan.albums, [{ folder: "Neko Case/Blacklisted", artist: "Neko Case", album: "Blacklisted", songs: 1 }]);
  assert.equal(plan.artists, 1);
  assert.equal(plan.unavailable, 0);
  assert.deepEqual(deps.albumsAdded, [], "looking adds nothing");
  assert.equal(deps.calls.length, 0);

  // Saying yes records the album for him, writes his copy with what he can
  // play now, and writes it again once the library has caught up.
  let ready = false;
  deps.libraryReady = async () => {
    ready = true;
    // The scan has put the album in his library.
    deps.copies[REL.averyOnly].push({ id: "song-outside-his", path: REL.averyOnly, libraryId: 5 });
  };
  const result = await social.acceptShare({ id, requester: "dunshill", deps });
  assert.equal(result.albumsAdded, 1);
  assert.deepEqual(deps.albumsAdded, [{
    username: "dunshill", folders: ["Neko Case/Blacklisted"], addedFor: "Road trip (from avery)",
  }]);
  assert.equal(result.missing, 1, "first written with what he can play already");
  await result.ready;
  assert.equal(ready, true);
  const mirror = [...deps.playlists.values()][0];
  assert.deepEqual(mirror.songIds, ["song-shared-his", "song-outside-his", "song-unindexed-main"]);
  assert.equal(shareRow().missing_count, 0);
});

test("without a personal library to add to, the missing songs are only counted", async () => {
  db.prepare("DELETE FROM playlist_shares").run();
  const deps = fakeDeps();
  await social.sharePlaylist({ owner: "avery", playlistId: "pl-1", recipients: ["dunshill"], deps });
  const plan = await social.previewShare({ id: shareRow().id, requester: "dunshill", deps });
  assert.deepEqual(plan.albums, []);
  assert.equal(plan.unavailable, 1);
  const result = await social.acceptShare({ id: shareRow().id, requester: "dunshill", deps });
  assert.equal(result.albumsAdded, 0);
  assert.equal(result.status, "written");
  assert.deepEqual(deps.albumsAdded, []);
});

test("after their own library, a copy comes from the main library, not someone else's", async () => {
  // An admin can reach every library, Dad's included. Avery's copy of his
  // playlist must not point into it when the main library has the song.
  social.resetSocialCaches();
  const deps = fakeDeps();
  const copies = [
    { id: "in-dads", path: REL.his, libraryId: 5 },
    { id: "in-main", path: REL.his, libraryId: 1 },
  ];
  const resolved = await social.resolveCopiesForUser({
    username: "avery",
    paths: [REL.his],
    deps: {
      ...deps,
      personalLibraryId: async () => 4,
      canonicalLibraryId: async () => 1,
      songsByPath: async () => copies,
      adminClient: () => ({
        getUsers: async () => [{ id: "nd-avery", userName: "avery" }],
        getUserLibraries: async () => [{ id: 1 }, { id: 4 }, { id: 5 }],
      }),
    },
  });
  assert.equal(resolved.get(REL.his), "in-main");
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

  // A broadcast names the people it reached, so nobody has to wonder who
  // "everyone" was.
  const broadcast = his.inbox.find((entry) => entry.toEveryone);
  assert.deepEqual(broadcast.audience.includes("dunshill"), true);
  assert.equal(broadcast.audience.includes("avery"), false, "not the sender");
  const mine = his.inbox.find((entry) => !entry.toEveryone);
  assert.deepEqual(mine.audience, ["dunshill"]);

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

// A recommendation with no recipient is one row read by several people, so read
// and hidden have to be recorded per person rather than on the row.

test("one person reading a broadcast does not read it for everybody", () => {
  social.createRecommendation({ sender: "avery", kind: "track", targetId: trackIds.shared, note: "for everyone" });

  assert.equal(social.listRecommendationsFor("dunshill").unread >= 1, true);
  assert.equal(social.listRecommendationsFor("kitty").unread >= 1, true);

  social.markRecommendationsRead("dunshill");
  assert.equal(social.listRecommendationsFor("dunshill").unread, 0, "read for the one who looked");
  assert.equal(social.listRecommendationsFor("kitty").unread >= 1, true, "still waiting for the one who did not");
});

test("one person hiding a broadcast does not hide it for everybody", () => {
  const before = social.listRecommendationsFor("kitty").inbox.length;
  const entry = social.listRecommendationsFor("dunshill").inbox[0];
  social.dismissRecommendation({ id: entry.id, requester: "dunshill" });

  assert.equal(
    social.listRecommendationsFor("dunshill").inbox.some((row) => row.id === entry.id),
    false,
    "gone from theirs",
  );
  assert.equal(social.listRecommendationsFor("kitty").inbox.length, before, "still on everyone else's");
});

test("saying it again replaces saying it once", () => {
  social.createRecommendation({
    sender: "avery", kind: "track", targetId: trackIds.outside, note: "first thought", recipients: ["kitty"],
  });
  social.createRecommendation({
    sender: "avery", kind: "track", targetId: trackIds.outside, note: "second thought", recipients: ["kitty"],
  });
  // An earlier test sent the same track to everyone, and that broadcast is a
  // separate thing from one addressed to her.
  const hers = social.listRecommendationsFor("kitty").inbox
    .filter((entry) => String(entry.targetId) === String(trackIds.outside) && !entry.toEveryone);
  assert.equal(hers.length, 1, "one recommendation, not two");
  assert.equal(hers[0].note, "second thought");
});

test("a sender can take one back, and only their own", () => {
  const mine = social.listRecommendationsFor("avery").sent[0];
  assert.throws(
    () => social.withdrawRecommendation({ id: mine.id, requester: "kitty" }),
    /not yours to take back/,
  );
  social.withdrawRecommendation({ id: mine.id, requester: "avery" });
  assert.equal(
    social.listRecommendationsFor("avery").sent.some((entry) => entry.id === mine.id),
    false,
  );
  assert.equal(
    social.listRecommendationsFor("kitty").inbox.some((entry) => entry.id === mine.id),
    false,
    "and it leaves their page too",
  );
});

test("a recommendation carries the artist, so a page can offer to add them", () => {
  const sent = social.createRecommendation({
    sender: "avery", kind: "track", targetId: trackIds.shared, recipients: ["kitty"],
  });
  assert.equal(sent.sent, 1);
  const entry = social.listRecommendationsFor("kitty").inbox.find((row) => row.kind === "track");
  assert.ok(Object.prototype.hasOwnProperty.call(entry, "artistMbid"));
  assert.ok(Object.prototype.hasOwnProperty.call(entry, "albumId"));
});

// The congregation rule, where it actually bites: the picker offering the
// right names is a courtesy, refusing the wrong ones is the rule.

test("you cannot recommend to someone you share no congregation with", () => {
  db.prepare("DELETE FROM congregation_members WHERE username = 'kitty'").run();
  assert.equal(social.listPeople({ exclude: "avery" }).includes("kitty"), false, "and she is not offered");
  assert.throws(
    () => social.createRecommendation({
      sender: "avery", kind: "track", targetId: trackIds.shared, recipients: ["kitty"],
    }),
    /not in a congregation together/,
  );
  // Put back, so the rest of the suite is about sharing again.
  shareWithEveryone(db);
  assert.ok(social.listPeople({ exclude: "avery" }).includes("kitty"));
});
