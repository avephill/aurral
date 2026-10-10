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
  // What the server does on starting: iTunes tags become his own.
  tags.adoptImportedTags();
});

test.after(() => cleanupIsolatedState(isolatedState));

test("a tag is a word, however it is typed", () => {
  assert.equal(tags.normalizeTag("  Holiday  "), "holiday");
  assert.equal(tags.normalizeTag("road, trip"), "road trip", "a comma separates tags, so it cannot be in one");
  assert.deepEqual(tags.tagsFromComment("holiday, mellow"), ["holiday", "mellow"]);
  assert.deepEqual(tags.normalizeTags(["A", "a", " A "]), ["a"], "said once");
});

test("what iTunes brought becomes his own, and the export is left as it was", () => {
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId: trackIds.carol }), ["holiday", "mellow"]);
  const listed = tags.listTags({ owner: "dunshill" });
  assert.deepEqual(listed.map((entry) => entry.tag).sort(), ["holiday", "mellow"]);
  assert.equal(listed.find((entry) => entry.tag === "holiday").own, 1, "his, not a read-only layer");
  const record = db.prepare("SELECT comment FROM song_records WHERE source_key = 'k1'").get();
  assert.equal(record.comment, "holiday, mellow", "the import is not rewritten");
  // Kept aside the first time, as the table was.
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'track_tags_before_adoption'").get());
});

test("the copy is made once: a tag taken off stays off", () => {
  tags.tagTracks({ owner: "dunshill", trackIds: [trackIds.carol], tag: "mellow", remove: true });
  assert.deepEqual(tags.adoptImportedTags(), { links: 0, songs: 0 }, "nothing left to copy");
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId: trackIds.carol }), ["holiday"],
    "removed for good, with no note left behind");
  tags.tagTracks({ owner: "dunshill", trackIds: [trackIds.carol], tag: "mellow" });
});

test("music that arrived after the export can be tagged too", () => {
  tags.setTrackTags({ owner: "dunshill", trackId: trackIds.newer, tags: ["Holiday", "loud"] });
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId: trackIds.newer }), ["holiday", "loud"]);
  const holiday = tags.listTags({ owner: "dunshill" }).find((entry) => entry.tag === "holiday");
  assert.equal(holiday.songs, 2, "the imported one and the new one");
  assert.equal(holiday.own, 2);
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

test("a rule reads his tags, not the comment they came in", () => {
  const merged = tags.mergeOwnTags(
    // The export's comment still says what it said in 2021.
    new Map([[trackIds.carol, { comment: "holiday, mellow, retired", genre: "jazz" }]]),
    "dunshill",
  );
  const entry = merged.get(trackIds.carol);
  assert.deepEqual([...entry.tags].sort(), ["holiday", "mellow", "winter"]);
  assert.match(entry.comment, /winter/, "what he added here");
  assert.doesNotMatch(entry.comment, /retired/, "and not what is only in the old comment");
  assert.equal(entry.genre, "jazz", "the rest of the record is untouched");
  // As his iTunes comments were written, so a rule for "mellow," finds it
  // wherever it falls.
  assert.match(entry.comment, /,$/);
  for (const tag of entry.tags) assert.ok(entry.comment.includes(`${tag},`), tag);
});

test("renaming a tag iTunes brought is just renaming it", () => {
  tags.renameTag({ owner: "dunshill", from: "mellow", to: "quiet" });
  const listed = tags.listTags({ owner: "dunshill" }).map((entry) => entry.tag);
  assert.ok(listed.includes("quiet"));
  assert.ok(!listed.includes("mellow"), "the old name is gone from the count");
  assert.ok(!tags.getTrackTags({ owner: "dunshill", trackId: trackIds.carol }).some((tag) => tag.startsWith("-")),
    "no note of a retired tag");
  const record = db.prepare("SELECT comment FROM song_records WHERE source_key = 'k1'").get();
  assert.equal(record.comment, "holiday, mellow", "still what was exported");
  const merged = tags.mergeOwnTags(new Map([[trackIds.carol, { comment: "holiday, mellow" }]]), "dunshill");
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
  assert.match(library, /<TagsModal\s+subject=\{tagging\}/);
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
  tags.adoptImportedTags();

  const detail = tags.getTrackTagDetail({ owner: "dunshill", trackId });
  const from = new Map(detail.inherited.map((entry) => [entry.tag, entry.from]));
  assert.equal(from.get("yuletide"), "The Christmas Song", "the record's tag is inherited");
  assert.deepEqual(detail.tags, ["crooner"], "and the iTunes one is simply its own");
});

test("a link judged wrong takes back its tags; one moved takes them along", () => {
  const make = (name) => libraryStore.upsertLibraryTrack({
    identityKey: `r:link-${name}`, title: name, artistName: "Nat King Cole", metadata: {},
  }).id;
  const wrong = make("wrong");
  const right = make("right");
  const record = db.prepare(`
    INSERT INTO song_records (owner, source, source_key, title, artist, comment, created_at, updated_at)
    VALUES ('dunshill', 'itunes', 'k-link', 'link', 'Nat King Cole', 'swing, late night', ?, ?)
  `).run(Date.now(), Date.now()).lastInsertRowid;
  db.prepare(`
    INSERT INTO song_record_links (record_id, track_id, method, status, updated_at) VALUES (?, ?, 'guess', 'review', ?)
  `).run(record, wrong, Date.now());
  tags.adoptImportedTags();
  tags.tagTracks({ owner: "dunshill", trackIds: [wrong], tag: "his own" });
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId: wrong }), ["swing", "late night", "his own"]);

  // Relinked to the right song: the tags go with the record.
  db.prepare("UPDATE song_record_links SET track_id = ? WHERE record_id = ?").run(right, record);
  tags.adoptImportedTags();
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId: wrong }), ["his own"], "what he added stays");
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId: right }), ["swing", "late night"]);

  // Then judged wrong altogether.
  tags.releaseAdoptedTags(record);
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId: right }), []);
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

// Filtering the song list by several tags at once.

test("songs can be found by all of some tags, or any of them", () => {
  userOps.createUser("bspang", "hash");
  const id = (name) => libraryStore.upsertLibraryTrack({
    identityKey: `r:filter-${name}`, title: name, artistName: "Alvvays", metadata: {},
  }).id;
  const both = id("both");
  const onlyChill = id("chill");
  const onlyNight = id("night");
  tags.setTrackTags({ owner: "bspang", trackId: both, tags: ["chill", "night"] });
  tags.setTrackTags({ owner: "bspang", trackId: onlyChill, tags: ["chill"] });
  tags.setTrackTags({ owner: "bspang", trackId: onlyNight, tags: ["Night"] });

  const sorted = (ids) => ids.map(Number).sort((a, b) => a - b);
  assert.deepEqual(sorted(tags.tracksWithTags({ owner: "bspang", tags: ["chill", "night"] })), [both], "all by default");
  assert.deepEqual(
    sorted(tags.tracksWithTags({ owner: "bspang", tags: ["chill", "NIGHT"], match: "any" })),
    sorted([both, onlyChill, onlyNight]),
    "any, however the tag is typed",
  );
  assert.deepEqual(tags.tracksWithTags({ owner: "bspang", tags: [] }), [], "no tags, no songs");
  assert.deepEqual(tags.tracksWithTags({ owner: "dunshill", tags: ["chill"] }), [], "one person's tags only");

  // Taking a tag off a song takes it out of the filter too.
  tags.tagTracks({ owner: "bspang", trackIds: [both], tag: "night", remove: true });
  assert.deepEqual(tags.tracksWithTags({ owner: "bspang", tags: ["chill", "night"] }), []);
});

test("the song list asks the server for the chosen tags", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const canonical = read("../../backend/routes/library/handlers/canonical.js");
  const client = read("../../frontend/src/utils/api/endpoints/library.js");
  const page = read("../../frontend/src/pages/LibraryPage.jsx");
  assert.match(canonical, /tracksWithTags\(\{\s*owner: req\.user\.username,/);
  assert.match(canonical, /match: req\.query\.tagMatch === "any" \? "any" : "all"/);
  // With a rating filter as well, a song has to pass both.
  assert.match(canonical, /trackIds = trackIds\.filter\(\(id\) => allowed\.has\(Number\(id\)\)\)/);
  assert.match(client, /tags: Array\.isArray\(options\.tags\) && options\.tags\.length \? options\.tags\.join\(","\)/);
  assert.match(page, /<TagFilter\s+selected=\{selectedTags\}/);
  assert.match(page, /\["genre", "rating", "favorites", "tags", "tagMatch"\]/, "and Clear clears them");
});

test("an iTunes tag that began with a dash comes across as a tag, not a removal", () => {
  const trackId = libraryStore.upsertLibraryTrack({
    identityKey: "r:dash", title: "dash", artistName: "Nat King Cole", metadata: {},
  }).id;
  const record = db.prepare(`
    INSERT INTO song_records (owner, source, source_key, title, artist, comment, created_at, updated_at)
    VALUES ('dunshill', 'itunes', 'k-dash', 'dash', 'Nat King Cole', 'holiday, - traditional', ?, ?)
  `).run(Date.now(), Date.now()).lastInsertRowid;
  db.prepare(`
    INSERT INTO song_record_links (record_id, track_id, method, status, updated_at) VALUES (?, ?, 'exact', 'linked', ?)
  `).run(record, trackId, Date.now());
  tags.adoptImportedTags();
  assert.deepEqual(tags.getTrackTags({ owner: "dunshill", trackId }), ["holiday", "traditional"]);
});
