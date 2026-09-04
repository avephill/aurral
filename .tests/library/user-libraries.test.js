import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  materializeUserLibrary,
  normalizeUserLibrariesSettings,
  planNavidromeLibraries,
  sanitizeUserFolderName,
  selectUserLibraryCatalog,
} from "../../backend/services/userLibraryService.js";

async function makeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aurral-userlib-"));
  const mainDir = path.join(root, "Library-main");
  const userDir = path.join(root, "users", "mom");
  await fsp.mkdir(path.join(mainDir, "Radiohead"), { recursive: true });
  await fsp.mkdir(path.join(mainDir, "Neko Case"), { recursive: true });
  return { root, mainDir, userDir };
}

test("materializeUserLibrary creates relative symlinks for existing artist folders", async (t) => {
  const { root, mainDir, userDir } = await makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const changes = await materializeUserLibrary(
    userDir,
    [{ path: path.join(mainDir, "Radiohead") }, { path: path.join(mainDir, "Neko Case") }],
    [],
  );

  assert.equal(changes, 2);
  const link = path.join(userDir, "Radiohead");
  const target = await fsp.readlink(link);
  assert.ok(!path.isAbsolute(target), "symlink should be relative");
  assert.equal(path.resolve(userDir, target), path.join(mainDir, "Radiohead"));
  assert.ok((await fsp.stat(link)).isDirectory());
});

test("materializeUserLibrary skips artists whose folder does not exist yet", async (t) => {
  const { root, mainDir, userDir } = await makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const changes = await materializeUserLibrary(
    userDir,
    [{ path: path.join(mainDir, "Not Ripped Yet") }],
    [],
  );

  assert.equal(changes, 0);
  assert.equal(fs.existsSync(path.join(userDir, "Not Ripped Yet")), false);
});

test("materializeUserLibrary removes stale symlinks but never real directories", async (t) => {
  const { root, mainDir, userDir } = await makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await materializeUserLibrary(
    userDir,
    [{ path: path.join(mainDir, "Radiohead") }, { path: path.join(mainDir, "Neko Case") }],
    [],
  );
  const realDir = path.join(userDir, "Not A Symlink");
  await fsp.mkdir(realDir);

  const changes = await materializeUserLibrary(
    userDir,
    [{ path: path.join(mainDir, "Radiohead") }],
    [],
  );

  assert.equal(changes, 1);
  assert.equal(fs.existsSync(path.join(userDir, "Neko Case")), false);
  assert.ok(fs.existsSync(path.join(userDir, "Radiohead")));
  assert.ok(fs.existsSync(realDir));
});

test("materializeUserLibrary repairs symlinks pointing at the wrong target", async (t) => {
  const { root, mainDir, userDir } = await makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await fsp.mkdir(userDir, { recursive: true });
  await fsp.symlink(
    path.relative(userDir, path.join(mainDir, "Neko Case")),
    path.join(userDir, "Radiohead"),
    "dir",
  );

  await materializeUserLibrary(userDir, [{ path: path.join(mainDir, "Radiohead") }], []);

  const target = await fsp.readlink(path.join(userDir, "Radiohead"));
  assert.equal(path.resolve(userDir, target), path.join(mainDir, "Radiohead"));
});

test("materializeUserLibrary is idempotent", async (t) => {
  const { root, mainDir, userDir } = await makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const members = [{ path: path.join(mainDir, "Radiohead") }];
  const first = await materializeUserLibrary(userDir, members, []);
  const second = await materializeUserLibrary(userDir, members, []);

  assert.equal(first, 1);
  assert.equal(second, 0);
});

test("sanitizeUserFolderName strips unsafe characters and falls back to user id", () => {
  assert.equal(sanitizeUserFolderName("mom"), "mom");
  assert.equal(sanitizeUserFolderName("Mo/m..\\x"), "Mo_m.._x");
  assert.equal(sanitizeUserFolderName("../../etc", 7), "_.._etc");
  assert.equal(sanitizeUserFolderName("///", 7), "___");
  assert.equal(sanitizeUserFolderName("", 7), "user-7");
  assert.equal(sanitizeUserFolderName(""), null);
});

test("normalizeUserLibrariesSettings merges input over existing values", () => {
  const existing = {
    enabled: true,
    rootPath: "/data/music/users",
    manageNavidrome: false,
    navidromeRootPath: "/music/users",
  };
  assert.deepEqual(normalizeUserLibrariesSettings(undefined, existing), existing);
  assert.deepEqual(normalizeUserLibrariesSettings({ enabled: false }, existing), {
    ...existing,
    enabled: false,
  });
  assert.deepEqual(
    normalizeUserLibrariesSettings({ rootPath: " /data/other/ ", navidromeRootPath: "" }, existing),
    { ...existing, rootPath: "/data/other", navidromeRootPath: "" },
  );
  // Legacy saved settings without the Navidrome keys default to managing Navidrome.
  assert.deepEqual(
    normalizeUserLibrariesSettings(undefined, { enabled: true, rootPath: "/data/music/users" }),
    { enabled: true, rootPath: "/data/music/users", manageNavidrome: true, navidromeRootPath: "" },
  );
});

test("selectUserLibraryCatalog flags membership and other users' libraries, sorted by name", () => {
  const tagLabelsById = new Map([[1, "mom"], [2, "avery"], [3, "flac"]]);
  const lidarrArtists = [
    { id: 2, foreignArtistId: "b", artistName: "The Beatles", sortName: "beatles, the", tags: [2, 3], statistics: { albumCount: 12, trackFileCount: 200 } },
    { id: 1, foreignArtistId: "a", artistName: "Aimee Mann", sortName: "mann, aimee", tags: [1, 2] },
    { id: 3, foreignArtistId: null, artistName: "No MBID", tags: [1] },
  ];
  const catalog = selectUserLibraryCatalog({
    lidarrArtists,
    tagLabelsById,
    usernames: ["Mom", "avery"],
    viewerUsername: "avery",
  });
  assert.deepEqual(catalog.map((artist) => artist.artistName), ["The Beatles", "Aimee Mann"]);
  assert.equal(catalog[0].inLibrary, true);
  assert.deepEqual(catalog[0].libraries, []);
  assert.equal(catalog[0].albumCount, 12);
  assert.equal(catalog[1].inLibrary, true);
  assert.deepEqual(catalog[1].libraries, ["Mom"]);

  const forMom = selectUserLibraryCatalog({
    lidarrArtists,
    tagLabelsById,
    usernames: ["Mom", "avery"],
    viewerUsername: "Mom",
  });
  assert.equal(forMom[0].inLibrary, false);
  assert.deepEqual(forMom[0].libraries, ["avery"]);
  assert.equal(forMom[1].inLibrary, true);
});

test("selectUserLibraryCatalog reports albums on the server alongside Lidarr's total", () => {
  const lidarrArtists = [
    {
      id: 1,
      foreignArtistId: "a",
      artistName: "Aimee Mann",
      statistics: { albumCount: 22 },
    },
    { id: 2, foreignArtistId: "b", artistName: "Beak", statistics: { albumCount: 3 } },
  ];
  const catalog = selectUserLibraryCatalog({
    lidarrArtists,
    tagLabelsById: new Map(),
    usernames: [],
    viewerUsername: "avery",
    albumCountsByMbid: new Map([["a", 12]]),
  });

  assert.equal(catalog[0].albumCount, 22);
  assert.equal(catalog[0].libraryAlbumCount, 12);
  // An artist with nothing on disk reports zero rather than inheriting Lidarr's count.
  assert.equal(catalog[1].albumCount, 3);
  assert.equal(catalog[1].libraryAlbumCount, 0);
});

test("planNavidromeLibraries creates missing libraries and assigns them to matching users", () => {
  const config = { navidromeRootPath: "/music/users" };
  const entries = [
    { username: "mom", userDir: "/data/music/users/mom" },
    { username: "avery", userDir: "/data/music/users/avery" },
    { username: "dad", userDir: "/data/music/users/dad" },
    { username: "kid", userDir: "/data/music/users/kid" },
  ];
  const libraries = [
    { id: 1, name: "Music Library", path: "/music/Library-main" },
    { id: 2, name: "avery", path: "/music/users/avery/" },
    { id: 3, name: "kid", path: "/music/somewhere-else" },
  ];
  const navidromeUsers = [
    { id: "u-mom", userName: "Mom", isAdmin: false },
    { id: "u-avery", userName: "avery", isAdmin: true },
    { id: "u-kid", userName: "kid", isAdmin: false },
  ];
  const plan = planNavidromeLibraries({
    entries,
    libraries,
    navidromeUsers,
    userLibraryIds: new Map([["u-mom", [1]]]),
    config,
  });
  assert.deepEqual(plan.create, [
    { username: "mom", name: "mom", path: "/music/users/mom" },
    { username: "dad", name: "dad", path: "/music/users/dad" },
  ]);
  // mom: new library, resolved by path after creation, keeps existing access.
  assert.deepEqual(plan.assign, [
    { username: "mom", navUserId: "u-mom", libraryId: null, libraryPath: "/music/users/mom", currentIds: [1] },
  ]);
  // avery is a Navidrome admin (sees everything); dad has no Navidrome user; kid's name is taken.
  assert.deepEqual(plan.skipped, [
    { username: "dad", reason: "no-navidrome-user" },
    { username: "kid", reason: "name-in-use" },
  ]);

  // Already assigned: nothing to do.
  const settled = planNavidromeLibraries({
    entries: [entries[0]],
    libraries: [...libraries, { id: 4, name: "mom", path: "/music/users/mom" }],
    navidromeUsers,
    userLibraryIds: new Map([["u-mom", [1, 4]]]),
    config,
  });
  assert.deepEqual(settled, { create: [], assign: [], skipped: [] });

  // No Navidrome root override: paths are the same as Aurral's.
  const samePath = planNavidromeLibraries({ entries: [entries[0]], libraries: [], navidromeUsers, config: {} });
  assert.equal(samePath.create[0].path, "/data/music/users/mom");
});

test("materializeUserLibrary clears a self-referential symlink", async (t) => {
  const { root, userDir } = await makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // "Geologist" -> "Geologist" resolves forever, so a scanner walking it gives
  // up with ELOOP after reporting Geologist/Geologist/Geologist/...
  await fsp.mkdir(userDir, { recursive: true });
  const link = path.join(userDir, "Geologist");
  await fsp.symlink("Geologist", link, "dir");

  const changes = await materializeUserLibrary(
    userDir,
    [{ path: path.join(userDir, "Geologist") }],
    [],
  );

  assert.equal(changes, 1);
  await assert.rejects(() => fsp.lstat(link), { code: "ENOENT" });
});

test("materializeUserLibrary clears symlinks whose target has gone away", async (t) => {
  const { root, mainDir, userDir } = await makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const artist = { path: path.join(mainDir, "Radiohead") };
  await materializeUserLibrary(userDir, [artist], []);
  const link = path.join(userDir, "Radiohead");
  assert.ok((await fsp.lstat(link)).isSymbolicLink());

  // The artist folder is renamed in the main library, so the link dangles.
  await fsp.rename(path.join(mainDir, "Radiohead"), path.join(mainDir, "Radiohead (renamed)"));

  const changes = await materializeUserLibrary(userDir, [artist], []);

  assert.equal(changes, 1);
  assert.equal(fs.existsSync(link), false);
  await assert.rejects(() => fsp.lstat(link), { code: "ENOENT" });
});
