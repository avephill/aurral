import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { cleanupIsolatedState, resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

// Compilations are picked one album at a time, and an album someone picked
// is known by its MusicBrainz release group, so it stays theirs when Lidarr
// renames its folder or moves it somewhere else.

process.env.AURRAL_NAVIDROME_MUSIC_ROOT = "/music";

const [isolatedState, { db }, { dbOps }, library] = await setupIsolatedBackend(
  "compilation-picks",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/userLibraryService.js",
);

const VA = library.VARIOUS_ARTISTS_MBID;
const at = Date.now();
let nextTrack = 1;

function artist(mbid, name) {
  return db.prepare(`INSERT INTO library_artists (identity_key, mbid, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(`mbid:${mbid}`, mbid, name, at, at).lastInsertRowid;
}
function album(artistId, rg, title, files) {
  const id = db.prepare(`INSERT INTO library_albums (identity_key, release_group_mbid, artist_id, title, release_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`rg:${rg}`, rg, artistId, title, "1999-05-01", at, at).lastInsertRowid;
  for (const file of files) {
    const track = db.prepare(`INSERT INTO library_tracks (identity_key, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(`t:${nextTrack++}`, file, at, at).lastInsertRowid;
    db.prepare(`INSERT INTO library_media_files (track_id, album_id, source, path, created_at, updated_at) VALUES (?, ?, 'lidarr', ?, ?, ?)`)
      .run(track, id, `/music/${file}`, at, at);
  }
  return id;
}
const settings = (userLibraries) =>
  dbOps.updateSettings({ ...dbOps.getSettings(), userLibraries: { enabled: true, rootPath: "/libraries", ...userLibraries } });

test.before(() => {
  resetDatabase(db);
  for (const table of ["user_library_albums", "library_media_files", "library_album_tracks", "library_tracks", "library_albums", "library_artists"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const va = artist(VA, "Various Artists");
  const radiohead = artist("a74b1b7f-71a5-4011-9441-d0b5e4122711", "Radiohead");
  album(va, "rg-grease", "Grease", ["Various Artists/Grease (1978)/01 - Grease.mp3", "Various Artists/Grease (1978)/02 - Summer Nights.mp3"]);
  album(va, "rg-jungle", "Jungle Book", ["Compilations/Jungle Book/01 - Bare Necessities.mp3"]);
  album(radiohead, "rg-kida", "Kid A", ["Radiohead/Kid A/01 - Everything.mp3"]);
  settings({ compilationsByAlbum: true });
});

test.after(() => cleanupIsolatedState(isolatedState));

test("an album picked by its release group is recorded where it is now", () => {
  const result = library.addUserLibraryAlbumsByMbid("dunshill", ["rg-grease", "rg-nowhere"], "picked");
  assert.equal(result.added, 1);
  assert.deepEqual(result.missing, ["rg-nowhere"], "nothing on the server to link");
  const [row] = library.listUserLibraryAlbums("dunshill");
  assert.equal(row.folder, "Various Artists/Grease (1978)");
  assert.equal(row.releaseGroupMbid, "rg-grease");
  assert.equal(row.compilation, true);
  assert.equal(library.addUserLibraryAlbumsByMbid("dunshill", ["rg-grease"]).added, 0, "once is enough");
});

test("when Lidarr moves the album, the link follows it", () => {
  db.prepare("UPDATE library_media_files SET path = replace(path, 'Grease (1978)', 'Grease') WHERE path LIKE '%Grease (1978)%'").run();
  const targets = library.albumTargetsFor("dunshill");
  assert.deepEqual(targets, [{ folder: "Various Artists/Grease", target: "/music/Various Artists/Grease" }]);
  assert.equal(library.listUserLibraryAlbums("dunshill")[0].folder, "Various Artists/Grease", "and remembers where");
});

test("albums recorded by folder learn which album they are, if Lidarr knows", () => {
  library.addUserLibraryAlbums("helen", ["Compilations/Jungle Book", "Various Artists/Mixtape Nobody Matched"], "a shared playlist");
  const rows = new Map(library.listUserLibraryAlbums("helen").map((row) => [row.folder, row]));
  assert.equal(rows.get("Compilations/Jungle Book").releaseGroupMbid, "rg-jungle");
  assert.equal(rows.get("Various Artists/Mixtape Nobody Matched").releaseGroupMbid, null);
  // One Lidarr does not know keeps being found by its folder.
  assert.ok(library.albumTargetsFor("helen").some((entry) => entry.folder === "Various Artists/Mixtape Nobody Matched"));

  db.prepare("UPDATE user_library_albums SET release_group_mbid = NULL WHERE username = 'helen'").run();
  assert.equal(library.backfillAlbumReleaseGroups(), 1, "the older rows are filled in too");
});

test("the compilations list is Various Artists' albums, with who has each", () => {
  const list = library.selectCompilationCatalog("helen");
  assert.deepEqual(list.map((entry) => entry.title), ["Grease", "Jungle Book"], "not Kid A");
  const grease = list.find((entry) => entry.title === "Grease");
  assert.equal(grease.inLibrary, false);
  assert.deepEqual(grease.libraries, ["dunshill"]);
  assert.equal(grease.year, "1999");
  assert.equal(grease.trackCount, 2);
  assert.equal(list.find((entry) => entry.title === "Jungle Book").inLibrary, true);
});

test("taking one out is by the album, wherever it is", () => {
  assert.equal(library.removeUserLibraryAlbumsByMbid("dunshill", ["rg-grease"]), 1);
  assert.equal(library.listUserLibraryAlbums("dunshill").length, 0);
});

test("Various Artists is never in a library whole once compilations are picked", () => {
  assert.equal(library.isWholeArtistAllowed(VA), false);
  assert.equal(library.isWholeArtistAllowed("a74b1b7f-71a5-4011-9441-d0b5e4122711"), true);
  const catalog = library.selectUserLibraryCatalog({
    lidarrArtists: [
      { id: 1, foreignArtistId: VA, artistName: "Various Artists" },
      { id: 2, foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711", artistName: "Radiohead" },
    ],
    compilationsByAlbum: true,
  });
  assert.deepEqual(catalog.map((entry) => entry.artistName), ["Radiohead"]);

  // Until each person's picks are in, the old way stands.
  settings({ compilationsByAlbum: false });
  assert.equal(library.isWholeArtistAllowed(VA), true);
  assert.equal(library.getCompilationCatalog({ username: "helen" }).enabled, false);
  settings({ compilationsByAlbum: true });
  assert.equal(library.getCompilationCatalog({ username: "helen" }).enabled, true);
});

test("compilations are picked from bulk migration, one at a time", () => {
  const routes = readFileSync(new URL("../../backend/routes/userLibrary.js", import.meta.url), "utf8");
  assert.match(routes, /router\.post\("\/albums", requireAuth/);
  assert.match(routes, /router\.get\("\/compilations", requireAuth/);
  assert.match(routes, /Compilations are added one at a time/);
  const page = readFileSync(new URL("../../frontend/src/pages/MyLibraryPage.jsx", import.meta.url), "utf8");
  assert.match(page, /<Compilations items=/);
  assert.match(page, /hideCompilations=\{compilationsEnabled\}/);
});
