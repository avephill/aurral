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

test("a bundle left in the imports folder is imported once and set aside", async () => {
  const { mkdtempSync, writeFileSync, readdirSync } = await import("node:fs");
  const { gzipSync } = await import("node:zlib");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "song-record-imports-"));
  writeFileSync(join(dir, "library.json.gz"), gzipSync(JSON.stringify({
    format: "psalter-itunes-library",
    owner: "dunshill",
    records: [song("meta:someone|record|a song|200", { title: "A Song", artist: "Someone", album: "Record" })],
  })));
  const [result] = records.importSongRecordBundlesFromDisk({ dir });
  assert.equal(result.records, 1);
  assert.deepEqual(records.importSongRecordBundlesFromDisk({ dir }), []);
  assert.match(readdirSync(dir)[0], /^library\.json\.gz\.imported-/);
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

// iTunes credits the person, MusicBrainz the group: "Nat King Cole" against
// "The Nat King Cole Trio". 71 of his songs sat in the missing list for that
// reason alone while 893 tracks by the group were on the server.
test("a credit that differs only by an ensemble word still matches", () => {
  assert.equal(matching.artistCore("The Nat King Cole Trio"), "natkingcole");
  assert.equal(matching.artistCore("Bill Evans Trio"), "billevans");
  assert.equal(matching.artistCore("Duke Ellington & His Orchestra"), "dukeellington");
  // A name that is only the ensemble word keeps it, or nothing would be left.
  assert.equal(matching.artistCore("The Band"), "band");
  assert.equal(matching.artistCore("Trio"), "trio");
  assert.deepEqual(matching.artistKeys("The Nat King Cole Trio"), ["natkingcoletrio", "natkingcole"]);

  const index = matching.buildCandidateIndex([
    { trackId: 1, title: "Sweet Lorraine", artistName: "The Nat King Cole Trio", albumTitle: "The Jazz Collector Edition, Vol. 1", albumId: 7, durationMs: 180_000 },
  ]);
  const links = matching.matchRecords(
    [{ id: 11, title: "Sweet Lorraine", artist: "Nat King Cole", album: "The Trio Recordings", durationMs: 181_000 }],
    index,
  );
  assert.equal(links.get(11)?.trackId, 1);
});

// His iTunes library kept a titled and an untitled copy of some rips. Once the
// titled one has its file, the copy is not music the server lacks - it made a
// fully present album look missing.
test("a duplicate of a linked song is not reported as missing", () => {
  const [onDisk] = addAlbum({ artist: "Thom Yorke", album: "Tomorrow's Modern Boxes", tracks: [["A Brain in a Bottle", 281]] });
  records.importSongRecordBundle({
    format: "psalter-itunes-library",
    owner: "dunshill",
    records: [
      song("path:Thom Yorke/Boxes/01 Brain.m4a", {
        title: "A Brain In A Bottle", artist: "Thom Yorke", album: "Tomorrow's Modern Boxes", durationMs: 281_000, rating: 3,
      }),
      // The untitled rip of the same disc, a second adrift.
      song("path:Thom Yorke/Boxes/Track 01.m4a", {
        title: "Track 01", artist: "Thom Yorke", album: "Tomorrow's Modern Boxes", durationMs: 282_000, rating: 3,
      }),
    ],
  });
  assert.equal(
    db.prepare("SELECT track_id AS trackId FROM song_record_links WHERE record_id = (SELECT id FROM song_records WHERE title = 'A Brain In A Bottle')").get().trackId,
    onDisk.id,
  );

  const hidden = records.getMissingSongsReport({ owner: "dunshill" });
  assert.equal(hidden.totals.duplicates, 1);
  assert.ok(!hidden.items.some((album) => album.album === "Tomorrow's Modern Boxes"));

  const shown = records.getMissingSongsReport({ owner: "dunshill", includeDuplicates: true });
  assert.ok(shown.items.some((album) => album.songs.some((entry) => entry.title === "Track 01")));
});

// Two albums sat in the missing list with every title and every length right,
// because the credit was wrong: a compilation iTunes filed under the album's
// own name against the server's "Various Artists", and a rip whose artist and
// album both came back from CDDB as "StellarStar" for "stellastarr*".
test("an album is placed by its shape when the credit disagrees", () => {
  const compilation = matching.buildCandidateIndex([
    { trackId: 1, title: "God Rest Ye Merry Gentlemen", artistName: "Various Artists", albumTitle: "Celtic Christmas", albumId: 5, durationMs: 124_906 },
    { trackId: 2, title: "The First Noel", artistName: "Various Artists", albumTitle: "Celtic Christmas", albumId: 5, durationMs: 140_293 },
    { trackId: 3, title: "Ding Dong Merrily On High", artistName: "Various Artists", albumTitle: "Celtic Christmas", albumId: 5, durationMs: 120_746 },
    { trackId: 4, title: "Noel Breton", artistName: "Various Artists", albumTitle: "Celtic Christmas", albumId: 5, durationMs: 102_600 },
    // A second record of that name, which is why matching by album name alone
    // gives up: it cannot tell which "Celtic Christmas" he owned.
    { trackId: 5, title: "Sweet Little Jesus Boy", artistName: "Eden's Bridge", albumTitle: "Celtic Christmas", albumId: 6, durationMs: 210_000 },
    { trackId: 6, title: "Coventry Carol", artistName: "Eden's Bridge", albumTitle: "Celtic Christmas", albumId: 6, durationMs: 190_000 },
  ]);
  const carols = matching.matchRecords(
    [
      { id: 1, title: "God Rest Ye Merry Gentlemen", artist: "Celtic Christmas", albumArtist: "Celtic Christmas", album: "Celtic Christmas", durationMs: 122_958 },
      { id: 2, title: "The First Noel", artist: "Celtic Christmas", albumArtist: "Celtic Christmas", album: "Celtic Christmas", durationMs: 138_344 },
      { id: 3, title: "Ding Dong Merrily On High", artist: "Celtic Christmas", albumArtist: "Celtic Christmas", album: "Celtic Christmas", durationMs: 118_804 },
    ],
    compilation,
  );
  assert.deepEqual([...carols].map(([id, link]) => [id, link.trackId, link.method]).sort(), [
    [1, 1, "album shape"],
    [2, 2, "album shape"],
    [3, 3, "album shape"],
  ]);

  // The misspelling reaches the album name too, so nothing but the songs
  // themselves identifies the record.
  const band = matching.buildCandidateIndex([
    { trackId: 11, title: "In the Walls", artistName: "stellastarr*", albumTitle: "stellastarr*", albumId: 9, durationMs: 229_413 },
    { trackId: 12, title: "Jenny", artistName: "stellastarr*", albumTitle: "stellastarr*", albumId: 9, durationMs: 256_800 },
    { trackId: 13, title: "My Coco", artistName: "stellastarr*", albumTitle: "stellastarr*", albumId: 9, durationMs: 305_866 },
    { trackId: 14, title: "Moongirl", artistName: "stellastarr*", albumTitle: "stellastarr*", albumId: 9, durationMs: 330_253 },
  ]);
  const links = matching.matchRecords(
    [
      { id: 21, title: "In the Walls", artist: "StellarStar", album: "StellarStar", durationMs: 229_388 },
      { id: 22, title: "Jenny", artist: "StellarStar", album: "StellarStar", durationMs: 256_764 },
      { id: 23, title: "My Coco", artist: "StellarStar", album: "StellarStar", durationMs: 305_828 },
    ],
    band,
  );
  assert.deepEqual([...links].map(([id, link]) => [id, link.trackId]), [[21, 11], [22, 12], [23, 13]]);
});

// A carol turns up on forty Christmas records. The agreement has to fill the
// album on the server, or one shared title would carry a whole record across.
test("a shape that covers little of the album on the server is not a match", () => {
  const index = matching.buildCandidateIndex(
    ["Silent Night", "Away in a Manger", "O Holy Night", "Joy to the World", "The First Noel",
     "Jingle Bells", "White Christmas", "Deck the Halls", "Good King Wenceslas", "O Come All Ye Faithful"]
      .map((title, position) => ({
        trackId: 100 + position,
        title,
        artistName: "Bing Crosby",
        albumTitle: "White Christmas",
        albumId: 42,
        durationMs: 180_000 + position * 1000,
      })),
  );
  const links = matching.matchRecords(
    [
      { id: 31, title: "Silent Night", artist: "A Village Choir", album: "Carols", durationMs: 180_000 },
      { id: 32, title: "Away in a Manger", artist: "A Village Choir", album: "Carols", durationMs: 181_000 },
      { id: 33, title: "Hark the Herald", artist: "A Village Choir", album: "Carols", durationMs: 200_000 },
    ],
    index,
  );
  assert.equal(links.size, 0);
});

// An iPod is the same shape of library under a different name, and the source
// keeps one person's iPod from colliding with another's iTunes.
test("an iPod bundle imports under its own source", () => {
  addAlbum({ artist: "Goldmund", album: "Corduroy Road", tracks: [["In a Notebook", 153]] });
  const result = records.importSongRecordBundle({
    format: "psalter-ipod-library",
    owner: "dunshill",
    records: [
      { key: "ipod-1", title: "In A Notebook", artist: "Goldmund", album: "Corduroy Road",
        durationMs: 153_000, playCount: 153 },
    ],
    playlists: [{ name: "Lounge Act (iPod)", kind: "manual", keys: ["ipod-1"] }],
  });
  assert.equal(result.source, "ipod");
  assert.equal(result.records, 1);
  const row = db.prepare("SELECT source, play_count AS playCount FROM song_records WHERE source_key = 'ipod-1'").get();
  assert.deepEqual(row, { source: "ipod", playCount: 153 });
  assert.ok(records.listSongRecordOwners().some((owner) => owner.owner === "dunshill"));
  // The comment field carries no tags, so nothing reaches the tag layer.
  assert.equal(db.prepare("SELECT comment FROM song_records WHERE source_key = 'ipod-1'").get().comment, null);
});

test("a bundle in no known format is refused", () => {
  assert.throws(
    () => records.importSongRecordBundle({ format: "psalter-minidisc-library", owner: "dunshill", records: [] }),
    /not a Psalter library bundle/,
  );
});
