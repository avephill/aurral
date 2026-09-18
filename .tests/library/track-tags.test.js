import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// Tagging songs in Psalter. His iTunes tags came in on the records and cannot
// be edited there - they are what was exported in 2021 - so what he does here
// layers over them, and is the only tagging music added since can have.

const [isolatedState, { db }, { userOps }, libraryStore, tags] = await setupIsolatedBackend(
  "track-tags",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/trackTagService.js",
);

const trackIds = {};

test.before(() => {
  resetDatabase(db);
  userOps.createUser("dunshill", "hash");
  for (const name of ["carol", "newer", "plain"]) {
    trackIds[name] = libraryStore.upsertLibraryTrack({
      identityKey: `r:${name}`, title: name, artistName: "Nat King Cole", metadata: {},
    }).id;
  }
  // One song arrived from iTunes carrying tags in its comment; the others did
  // not, as anything added since the export would not.
  const record = db.prepare(`
    INSERT INTO song_records (owner, source, source_key, title, artist, comment, created_at, updated_at)
    VALUES ('dunshill', 'itunes', 'k1', 'carol', 'Nat King Cole', 'holiday, mellow', ?, ?)
  `).run(Date.now(), Date.now()).lastInsertRowid;
  db.prepare(`
    INSERT INTO song_record_links (record_id, track_id, method, status, updated_at)
    VALUES (?, ?, 'exact', 'linked', ?)
  `).run(record, trackIds.carol, Date.now());
});

test.after(() => cleanupIsolatedState(isolatedState));

test("a tag is a word, however it is typed", () => {
  assert.equal(tags.normalizeTag("  Holiday  "), "holiday");
  assert.equal(tags.normalizeTag("road, trip"), "road trip", "a comma separates tags, so it cannot be in one");
  assert.deepEqual(tags.tagsFromComment("holiday, mellow"), ["holiday", "mellow"]);
  assert.deepEqual(tags.normalizeTags(["A", "a", " A "]), ["a"], "said once");
});

test("what iTunes brought is counted, and left where it is", () => {
  const listed = tags.listTags({ owner: "dunshill" });
  assert.deepEqual(listed.map((entry) => entry.tag).sort(), ["holiday", "mellow"]);
  assert.equal(listed.find((entry) => entry.tag === "holiday").imported, 1);
  const record = db.prepare("SELECT comment FROM song_records WHERE source_key = 'k1'").get();
  assert.equal(record.comment, "holiday, mellow", "the import is not rewritten");
});

test("music that arrived after the export can be tagged too", () => {
  tags.setTrackTags({ owner: "dunshill", trackId: trackIds.newer, tags: ["Holiday", "loud"] });
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId: trackIds.newer }), ["holiday", "loud"]);
  const holiday = tags.listTags({ owner: "dunshill" }).find((entry) => entry.tag === "holiday");
  assert.equal(holiday.songs, 2, "the imported one and the new one");
  assert.equal(holiday.own, 1);
});

test("a tag on one song is one tag, from whichever side it came", () => {
  tags.setTrackTags({ owner: "dunshill", trackId: trackIds.carol, tags: ["holiday"] });
  const holiday = tags.listTags({ owner: "dunshill" }).find((entry) => entry.tag === "holiday");
  assert.equal(holiday.songs, 2, "not three");
});

test("a tag goes on or off a handful at once, leaving their others alone", () => {
  const added = tags.tagTracks({ owner: "dunshill", trackIds: Object.values(trackIds), tag: "winter" });
  assert.equal(added.changed, 3);
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId: trackIds.newer }), ["holiday", "loud", "winter"]);

  const removed = tags.tagTracks({ owner: "dunshill", trackIds: [trackIds.plain], tag: "winter", remove: true });
  assert.equal(removed.changed, 1);
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId: trackIds.plain }), []);
  // Asking again changes nothing rather than counting twice.
  assert.equal(tags.tagTracks({ owner: "dunshill", trackIds: [trackIds.plain], tag: "winter", remove: true }).changed, 0);
});

test("a rule sees both kinds of tag as one comment", () => {
  const merged = tags.mergeOwnTags(
    new Map([[trackIds.carol, { comment: "holiday, mellow", genre: "jazz" }]]),
    "dunshill",
  );
  const entry = merged.get(trackIds.carol);
  assert.match(entry.comment, /holiday/);
  assert.match(entry.comment, /mellow/, "what iTunes had is still there");
  assert.match(entry.comment, /winter/, "and what he added here");
  assert.equal(entry.genre, "jazz", "the rest of the record is untouched");
});

test("renaming reaches songs tagged by iTunes, without rewriting the import", () => {
  tags.renameTag({ owner: "dunshill", from: "mellow", to: "quiet" });
  const listed = tags.listTags({ owner: "dunshill" }).map((entry) => entry.tag);
  assert.ok(listed.includes("quiet"));
  assert.ok(!listed.includes("mellow"), "the old name is gone from the count");
  const record = db.prepare("SELECT comment FROM song_records WHERE source_key = 'k1'").get();
  assert.equal(record.comment, "holiday, mellow", "still what was exported");

  const merged = tags.mergeOwnTags(
    new Map([[trackIds.carol, { comment: "holiday, mellow" }]]),
    "dunshill",
  );
  assert.match(merged.get(trackIds.carol).comment, /quiet/);
  assert.doesNotMatch(merged.get(trackIds.carol).comment, /mellow/, "and a rule no longer sees it");
});

test("a tag can be dropped entirely, imported or not", () => {
  tags.renameTag({ owner: "dunshill", from: "winter", to: "" });
  assert.ok(!tags.listTags({ owner: "dunshill" }).some((entry) => entry.tag === "winter"));
});

test("songs carrying a tag can be listed, from either side", () => {
  const holiday = tags.tracksWithTag({ owner: "dunshill", tag: "holiday" });
  assert.equal(holiday.length, 2);
  assert.ok(holiday.includes(trackIds.carol));
  assert.ok(holiday.includes(trackIds.newer));
});

test("the app offers tagging where the songs are", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const library = read("../../frontend/src/pages/LibraryPage.jsx");
  const nav = read("../../frontend/src/navigation/libraryNavConfig.js");
  const routes = read("../../frontend/src/App.jsx");
  const routed = read("../../backend/routes/tags.js");

  assert.match(library, /label: "Tags\.\.\."/, "on the song's own menu");
  assert.match(library, /<TagsModal subject=\{tagging\}/);
  assert.match(library, /kind: "album"/, "and on a whole record's menu");
  assert.match(nav, /path: "\/library\/tags"/, "and a page of its own under Library");
  assert.match(routes, /path="\/library\/tags"/);
  // Tagging your own songs is not an admin job, unlike the iTunes import tools.
  assert.doesNotMatch(routed, /requireAdmin/);
  assert.match(routed, /router\.use\(requireAuth\)/);
});

// Tagging a whole record. A tag on an album belongs to every song on it - and
// to any song added to it later - so it is kept once on the album rather than
// copied onto each song.

const albumIds = {};

test("a record can be tagged, and every song on it counts", () => {
  const artistId = libraryStore.upsertLibraryArtist({
    identityKey: "a:cole", name: "Nat King Cole", metadata: {},
  }).id;
  albumIds.christmas = libraryStore.upsertLibraryAlbum({
    identityKey: "al:christmas", artistId, title: "The Christmas Song", metadata: {},
  }).id;
  for (const name of ["carol", "newer"]) {
    libraryStore.linkLibraryAlbumTrack({ albumId: albumIds.christmas, trackId: trackIds[name] });
  }

  tags.setAlbumTags({ owner: "dunshill", albumId: albumIds.christmas, tags: ["yuletide"] });

  assert.deepEqual(
    tags.tracksWithTag({ owner: "dunshill", tag: "yuletide" }).sort(),
    [trackIds.carol, trackIds.newer].sort(),
    "both songs on the record carry it",
  );
  const listed = tags.listTags({ owner: "dunshill" }).find((entry) => entry.tag === "yuletide");
  assert.equal(listed.songs, 2);
  assert.equal(listed.album, 2, "counted as coming from a record");
  assert.equal(listed.albums, 1);
  const written = db.prepare("SELECT tags_json AS tags FROM track_tags WHERE owner = 'dunshill'").all();
  assert.ok(
    written.every((row) => !row.tags.includes("yuletide")),
    "and nothing was written onto the songs themselves",
  );
});

test("a song added to the record later is already tagged", () => {
  const late = libraryStore.upsertLibraryTrack({
    identityKey: "r:bonus", title: "bonus", artistName: "Nat King Cole", metadata: {},
  }).id;
  libraryStore.linkLibraryAlbumTrack({ albumId: albumIds.christmas, trackId: late });
  assert.ok(
    tags.tracksWithTag({ owner: "dunshill", tag: "yuletide" }).includes(late),
    "no re-tagging needed",
  );
});

test("a rule sees the record's tags on each of its songs", () => {
  const seen = tags.mergeOwnTags(new Map(), "dunshill");
  assert.match(seen.get(trackIds.newer).comment, /yuletide/);
  assert.match(
    seen.get(trackIds.carol).comment,
    /holiday/,
    "and what iTunes brought is still there beside it",
  );
  assert.match(seen.get(trackIds.carol).comment, /yuletide/);
});

test("one song can say no to a tag the whole record has", () => {
  const result = tags.tagTracks({
    owner: "dunshill", trackIds: [trackIds.newer], tag: "yuletide", remove: true,
  });
  assert.equal(result.changed, 1);
  assert.ok(
    !tags.tracksWithTag({ owner: "dunshill", tag: "yuletide" }).includes(trackIds.newer),
  );
  assert.deepEqual(
    tags.getAlbumTags({ owner: "dunshill", albumId: albumIds.christmas }),
    ["yuletide"],
    "the record keeps it for everything else",
  );
  const detail = tags.getTrackTagDetail({ owner: "dunshill", trackId: trackIds.newer });
  assert.deepEqual(detail.removed, ["yuletide"]);
  assert.deepEqual(detail.inherited, [], "so it is not offered as inherited any more");
});

test("putting it back on that song clears the refusal", () => {
  tags.tagTracks({ owner: "dunshill", trackIds: [trackIds.newer], tag: "yuletide" });
  assert.ok(tags.tracksWithTag({ owner: "dunshill", tag: "yuletide" }).includes(trackIds.newer));
  const own = tags.getTrackTags({ owner: "dunshill", trackId: trackIds.newer });
  assert.ok(!own.includes("-yuletide"), "the note refusing it is gone");
});

test("a song says where each of its tags comes from", () => {
  // A song of its own, so earlier tests cannot have moved its tags about.
  const trackId = libraryStore.upsertLibraryTrack({
    identityKey: "r:origins", title: "origins", artistName: "Nat King Cole", metadata: {},
  }).id;
  libraryStore.linkLibraryAlbumTrack({ albumId: albumIds.christmas, trackId });
  const record = db.prepare(`
    INSERT INTO song_records (owner, source, source_key, title, artist, comment, created_at, updated_at)
    VALUES ('dunshill', 'itunes', 'k-origins', 'origins', 'Nat King Cole', 'crooner', ?, ?)
  `).run(Date.now(), Date.now()).lastInsertRowid;
  db.prepare(`
    INSERT INTO song_record_links (record_id, track_id, method, status, updated_at)
    VALUES (?, ?, 'exact', 'linked', ?)
  `).run(record, trackId, Date.now());

  const detail = tags.getTrackTagDetail({ owner: "dunshill", trackId });
  const from = new Map(detail.inherited.map((entry) => [entry.tag, entry.from]));
  assert.equal(from.get("yuletide"), "The Christmas Song");
  assert.equal(from.get("crooner"), "iTunes");
  assert.deepEqual(detail.tags, [], "and it has none of its own");
});

test("renaming a record's tag is one row, not one per song", () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM track_tags WHERE owner = 'dunshill'").get().n;
  const result = tags.renameTag({ owner: "dunshill", from: "yuletide", to: "christmas" });
  assert.equal(result.albums, 1);
  assert.deepEqual(
    tags.getAlbumTags({ owner: "dunshill", albumId: albumIds.christmas }),
    ["christmas"],
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM track_tags WHERE owner = 'dunshill'").get().n,
    before,
    "the songs were left alone",
  );
  assert.ok(tags.tracksWithTag({ owner: "dunshill", tag: "christmas" }).includes(trackIds.carol));
});
