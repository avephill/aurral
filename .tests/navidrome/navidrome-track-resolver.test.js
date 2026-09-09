import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, libraryStore, resolver] = await setupIsolatedBackend(
  "navidrome-track-resolver",
  "backend/config/db-sqlite.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/navidromeTrackResolver.js",
);

const {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} = libraryStore;

const AURRAL_ROOT = "/data/Music/Library";
let album;
let track;
let otherTrack;

function seedTrack({ artistKey, artistName, albumKey, albumTitle, trackKey, title, file }) {
  const artist = upsertLibraryArtist({ identityKey: artistKey, name: artistName, metadata: {} });
  const seededAlbum = upsertLibraryAlbum({
    identityKey: albumKey,
    artistId: artist.id,
    title: albumTitle,
    albumArtist: artistName,
  });
  const seededTrack = upsertLibraryTrack({ identityKey: trackKey, title, artistName });
  linkLibraryAlbumTrack({ albumId: seededAlbum.id, trackId: seededTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: seededTrack.id,
    albumId: seededAlbum.id,
    source: "lidarr",
    path: `${AURRAL_ROOT}/${file}`,
    format: "flac",
    available: true,
  });
  return { album: seededAlbum, track: seededTrack };
}

// A stand-in for the admin NavidromeClient: real, library-relative paths on
// the native calls and fake "Artist/Album/Title.ext" paths on Subsonic ones,
// as Navidrome itself behaves.
function fakeAdminClient({ playlistTracks = [], songsByPath = {}, songsByTitle = {} } = {}) {
  return {
    calls: [],
    async getLibraries() {
      return [{ id: 1, name: "Music", path: "/music" }, { id: 2, name: "avery", path: "/libraries/avery" }];
    },
    async getPlaylistTracks(playlistId) {
      this.calls.push(["getPlaylistTracks", playlistId]);
      return playlistTracks;
    },
    async findSongsByPath(path) {
      this.calls.push(["findSongsByPath", path]);
      return songsByPath[path] || [];
    },
    async searchSongsNative(title) {
      this.calls.push(["searchSongsNative", title]);
      return songsByTitle[title] || [];
    },
    async searchSongs(title) {
      this.calls.push(["searchSongs", title]);
      return (songsByTitle[title] || []).map((song) => ({ ...song, path: `${song.artist}/${song.album}/01 - ${song.title}.flac` }));
    },
  };
}

test.before(() => {
  resetDatabase(db);
  ({ album, track } = seedTrack({
    artistKey: "jethro-tull",
    artistName: "Jethro Tull",
    albumKey: "stand-up",
    albumTitle: "Stand Up",
    trackKey: "a-new-day-yesterday",
    title: "A New Day Yesterday",
    file: "Jethro Tull/Stand Up/01 A New Day Yesterday.flac",
  }));
  ({ track: otherTrack } = seedTrack({
    artistKey: "mungo-jerry",
    artistName: "Mungo Jerry",
    albumKey: "in-the-summertime",
    albumTitle: "In the Summertime",
    trackKey: "in-the-summertime",
    title: "In the Summertime",
    file: "Mungo Jerry/In the Summertime/01 In the Summertime.flac",
  }));
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test.beforeEach(() => {
  resolver.resetNavidromeTrackResolver();
});

test("playlist entries map to canonical tracks through the native paths, learning the root on the way", async () => {
  const client = fakeAdminClient({
    playlistTracks: [
      { id: "pt-1", mediaFileId: "nd-1", path: "Jethro Tull/Stand Up/01 A New Day Yesterday.flac", libraryId: 1 },
      { id: "pt-2", mediaFileId: "nd-2", path: "Mungo Jerry/In the Summertime/01 In the Summertime.flac", libraryId: 1 },
      { id: "pt-3", mediaFileId: "nd-3", path: "Somebody Else/Album/01 Missing.flac", libraryId: 1 },
    ],
  });
  const entries = [
    { id: "nd-1", title: "A New Day Yesterday", artist: "Jethro Tull", album: "Stand Up", duration: 493, path: "Jethro Tull/Stand Up/01 - A New Day Yesterday.flac" },
    { id: "nd-2", title: "In the Summertime", artist: "Mungo Jerry", album: "In the Summertime", duration: 210, path: "fake/path.flac" },
    { id: "nd-3", title: "Missing", artist: "Somebody Else", album: "Album", duration: 100, path: "fake/other.flac" },
  ];
  const tracks = await resolver.mapNavidromeEntriesToTracks(entries, { playlistId: "pl-1", client });

  assert.equal(tracks.length, 3);
  assert.equal(tracks[0].available, true);
  assert.equal(tracks[0].trackId, track.id);
  assert.equal(tracks[0].albumId, album.id);
  assert.equal(tracks[0].streamPath, `/library/canonical-stream/${album.id}/${track.id}`);
  assert.equal(tracks[0].artistName, "Jethro Tull");
  assert.equal(tracks[0].durationMs, 493000);
  assert.equal(tracks[1].available, true);
  assert.equal(tracks[1].trackId, otherTrack.id);
  assert.equal(tracks[2].available, false);
  assert.equal(tracks[2].title, "Missing");
  assert.equal(tracks[2].streamPath, null);
  assert.deepEqual(resolver.getNavidromeRoots(), { aurralRoot: AURRAL_ROOT, navidromeRoot: "" });
  assert.deepEqual(client.calls[0], ["getPlaylistTracks", "pl-1"]);
});

test("entries stay unavailable when the admin connection cannot supply real paths", async () => {
  const client = fakeAdminClient({ playlistTracks: [] });
  const tracks = await resolver.mapNavidromeEntriesToTracks(
    [{ id: "nd-1", title: "A New Day Yesterday", path: "Jethro Tull/Stand Up/01 - A New Day Yesterday.flac" }],
    { playlistId: "pl-1", client },
  );
  assert.equal(tracks[0].available, false);
  assert.equal(resolver.getNavidromeRoots().aurralRoot, null);
});

test("a canonical track resolves to the main-library song once the root is known", async () => {
  const relative = "Jethro Tull/Stand Up/01 A New Day Yesterday.flac";
  const client = fakeAdminClient({
    songsByTitle: {
      "A New Day Yesterday": [
        { id: "nd-personal", title: "A New Day Yesterday", artist: "Jethro Tull", album: "Stand Up", path: relative, libraryId: 2 },
        { id: "nd-main", title: "A New Day Yesterday", artist: "Jethro Tull", album: "Stand Up", path: relative, libraryId: 1 },
        { id: "nd-other", title: "A New Day Yesterday", artist: "Cover Band", album: "Covers", path: "Cover Band/Covers/03 A New Day Yesterday.flac", libraryId: 1 },
      ],
    },
    songsByPath: {
      [relative]: [
        { id: "nd-personal", path: relative, libraryId: 2 },
        { id: "nd-main", path: relative, libraryId: 1 },
      ],
    },
  });

  const canonical = resolver.describeCanonicalTrack({ trackId: track.id, albumId: album.id });
  assert.equal(canonical.path, `${AURRAL_ROOT}/${relative}`);

  // First time: roots unknown, so the title search does the work and teaches the root.
  assert.equal(await resolver.resolveNavidromeSongId(canonical, { client }), "nd-main");
  assert.equal(resolver.getNavidromeRoots().aurralRoot, AURRAL_ROOT);
  assert.ok(client.calls.some(([name]) => name === "searchSongsNative"));

  // Second time: cached, no calls at all.
  client.calls.length = 0;
  assert.equal(await resolver.resolveNavidromeSongId(canonical, { client }), "nd-main");
  assert.equal(client.calls.length, 0);

  // Another track with the root known goes straight to the exact path lookup.
  const other = resolver.describeCanonicalTrack({ trackId: otherTrack.id });
  client.findSongsByPath = async (path) => {
    client.calls.push(["findSongsByPath", path]);
    return [{ id: "nd-mungo", path, libraryId: 1 }];
  };
  assert.equal(await resolver.resolveNavidromeSongId(other, { client }), "nd-mungo");
  assert.deepEqual(client.calls, [["findSongsByPath", "Mungo Jerry/In the Summertime/01 In the Summertime.flac"]]);
});

test("payload resolution falls back to a name search for tracks outside the library", async () => {
  const client = fakeAdminClient({
    songsByTitle: {
      Trash: [{ id: "nd-trash", title: "Trash", artist: "Show Me the Body", album: "Corpus I" }],
    },
  });
  const { resolved, unresolved } = await resolver.resolveNavidromeSongIds(
    [
      { trackName: "Trash", artistName: "Show Me the Body", albumName: "Corpus I" },
      { trackName: "Nowhere", artistName: "Nobody" },
    ],
    { client },
  );
  assert.deepEqual(resolved.map((entry) => entry.songId), ["nd-trash"]);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].trackName, "Nowhere");
});
