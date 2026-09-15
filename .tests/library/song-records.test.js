import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// A person's old iTunes library kept as song records: imported with the links
// the migration made, relinked when music arrives under a MusicBrainz name,
// and reported as missing while no file exists.

process.env.AURRAL_NAVIDROME_MUSIC_ROOT = "/data/Music/Library";

const [isolatedState, { db }, { userOps }, libraryStore, records, matching, tagPlaylists] = await setupIsolatedBackend(
  "song-records",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/songRecordService.js",
  "backend/services/songRecordMatching.js",
  "backend/services/tagPlaylistService.js",
);

function addAlbum({ artist, album, tracks }) {
  const artistRow = libraryStore.upsertLibraryArtist({ identityKey: `artist:${artist}`, name: artist, metadata: {} });
  const albumRow = libraryStore.upsertLibraryAlbum({
    identityKey: `album:${album}`,
    artistId: artistRow.id,
    title: album,
    metadata: {},
  });
  return tracks.map(([title, seconds], index) => {
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `recording:${album}-${index}`,
      title,
      artistName: artist,
      metadata: {},
    });
    libraryStore.linkLibraryAlbumTrack({ albumId: albumRow.id, trackId: track.id, discNumber: 1, trackNumber: index + 1 });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: albumRow.id,
      source: "lidarr",
      path: `/data/Music/Library/${artist}/${album}/${index + 1} ${title}.flac`,
      durationMs: seconds * 1000,
      available: true,
    });
    return track;
  });
}

const song = (key, fields, link = null) => ({ key, durationMs: 200_000, rating: 0, ...fields, link });

test.before(() => {
  resetDatabase(db);
  userOps.createUser("dunshill", "hash");
});

test.after(() => cleanupIsolatedState(isolatedState));

test("title similarity agrees with difflib", () => {
  assert.equal(matching.similarity("abcd", "bcde"), 0.75);
  assert.equal(matching.similarity("ocean", "the ocean"), 10 / 14);
  assert.equal(matching.normBare("Tom Traubert's Blues (Four Sheets to the Wind)"), "tom traubert s blues");
  assert.equal(matching.normArtist("The J.J. Cale Band"), "jjcaleband");
});

test("import seeds links from the migration, relinks renamed songs, reports the rest", () => {
  const [known] = addAlbum({ artist: "Bruce Cockburn", album: "Christmas", tracks: [["Adeste Fideles", 200]] });
  const [renamed] = addAlbum({ artist: "Led Zeppelin", album: "Houses of the Holy", tracks: [["The Ocean", 271]] });

  const result = records.importSongRecordBundle({
    format: "psalter-itunes-library",
    owner: "dunshill",
    records: [
      song("path:Bruce Cockburn/Christmas/01 Adeste.m4a", {
        title: "Adeste Fideles", artist: "Bruce Cockburn", album: "Christmas", comment: "Holiday,", rating: 4,
      }, { navidromePath: "Bruce Cockburn/Christmas/1 Adeste Fideles.flac", method: "T1", ambiguous: false }),
      song("path:Led Zeppelin/Houses/10 Ocean.m4a", {
        title: "Ocean", artist: "Led Zeppelin", album: "Houses of the Holy", durationMs: 271_400, rating: 5,
      }),
      song("path:Neko Case/Blacklisted/01 Things.m4a", {
        title: "Things That Scare Me", artist: "Neko Case", album: "Blacklisted", rating: 5, loved: true,
      }),
    ],
    playlists: [{ name: "Dad Favorites", kind: "user", keys: ["path:Neko Case/Blacklisted/01 Things.m4a"] }],
    smartPlaylists: [{
      name: "Holiday",
      rules: { match: "all", conditions: [{ field: "comment", operator: "contains", value: "Holiday," }] },
      unsupported: [],
    }],
  });

  assert.equal(result.records, 3);
  assert.equal(result.linked, 2);
  const links = db.prepare("SELECT track_id AS trackId, method FROM song_record_links ORDER BY record_id").all();
  assert.deepEqual(links.map((link) => link.trackId), [known.id, renamed.id]);
  assert.match(links[0].method, /^migration/);

  const missing = records.getMissingSongsReport({ owner: "dunshill" });
  assert.equal(missing.totals.songs, 1);
  assert.equal(missing.items[0].album, "Blacklisted");
  assert.equal(missing.items[0].ratedCount, 1);
  assert.deepEqual(missing.items[0].songs[0].playlists, ["Dad Favorites"]);

  // The CD gets ripped: Lidarr imports it and the waiting song finds its file.
  addAlbum({ artist: "Neko Case", album: "Blacklisted", tracks: [["Things That Scare Me", 200]] });
  assert.equal(records.relinkSongRecords({ owner: "dunshill" }).linked, 1);
  assert.equal(records.getMissingSongsReport({ owner: "dunshill" }).totals.songs, 0);

  // Importing again keeps an admin's verdict.
  const recordId = db.prepare("SELECT id FROM song_records WHERE title = 'Adeste Fideles'").get().id;
  assert.equal(records.decideSongLink(recordId, "reject"), true);
  records.importSongRecordBundle({
    format: "psalter-itunes-library",
    owner: "dunshill",
    records: [song("path:Bruce Cockburn/Christmas/01 Adeste.m4a", { title: "Adeste Fideles", artist: "Bruce Cockburn" },
      { navidromePath: "Bruce Cockburn/Christmas/1 Adeste Fideles.flac", method: "T1" })],
  });
  assert.equal(db.prepare("SELECT status FROM song_record_links WHERE record_id = ?").get(recordId).status, "rejected");
});

test("rules read his tags, his live ratings, and fall back to the file", () => {
  const songs = new Map([
    [1, { trackId: 1, songId: "a", title: "Adeste", artist: "Cockburn", album: "Christmas", genre: "Folk", year: 1993, rating: 4, playCount: 0, loved: false, created: "2026-01-01", discNumber: 1, trackNumber: 1 }],
    [2, { trackId: 2, songId: "b", title: "Ocean", artist: "Led Zeppelin", album: "Houses", genre: "Rock", year: 1973, rating: 2, playCount: 9, loved: true, created: "2026-01-01", discNumber: 1, trackNumber: 1 }],
    [3, { trackId: 3, songId: "c", title: "Untagged", artist: "Someone", album: "New", genre: "Pop", year: 2025, rating: 5, playCount: 0, loved: false, created: "2026-02-01", discNumber: 1, trackNumber: 1 }],
  ]);
  const tags = new Map([
    [1, { comment: "Holiday, Mellow,", genre: "Christmas", dateAdded: "2008-12-01" }],
    [2, { comment: "70's, Rock,", dateAdded: "2004-05-01" }],
  ]);
  const pick = (rules) => tagPlaylists.evaluateTagPlaylistRules(rules, songs, tags).songs.map((entry) => entry.songId);

  assert.deepEqual(pick({ match: "all", conditions: [{ field: "comment", operator: "contains", value: "holiday," }] }), ["a"]);
  assert.deepEqual(pick({ match: "all", conditions: [
    { field: "comment", operator: "notContains", value: "Holiday" },
    { field: "rating", operator: "gt", value: 3 },
  ] }), ["c"]);
  assert.deepEqual(pick({ match: "any", conditions: [
    { field: "genre", operator: "contains", value: "christmas" },
    { field: "dateadded", operator: "after", value: "2025-12-31" },
  ] }), ["a", "c"]);
  assert.deepEqual(pick({ match: "all", conditions: [
    { field: "year", operator: "inTheRange", value: "1970,1979" },
    { match: "any", conditions: [{ field: "loved", operator: "is", value: true }] },
  ] }), ["b"]);
  const { skipped } = tagPlaylists.evaluateTagPlaylistRules(
    { match: "all", conditions: [{ field: "bpm", operator: "gt", value: 100 }, { field: "rating", operator: "is", value: 5 }] },
    songs,
    tags,
  );
  assert.deepEqual(skipped, ["bpm gt"]);
});
