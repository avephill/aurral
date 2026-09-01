import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  materializeUserLibrary,
  normalizeUserLibrariesSettings,
  sanitizeUserFolderName,
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
  const existing = { enabled: true, rootPath: "/data/music/users" };
  assert.deepEqual(normalizeUserLibrariesSettings(undefined, existing), existing);
  assert.deepEqual(normalizeUserLibrariesSettings({ enabled: false }, existing), {
    enabled: false,
    rootPath: "/data/music/users",
  });
  assert.deepEqual(
    normalizeUserLibrariesSettings({ rootPath: " /data/other/ " }, existing),
    { enabled: true, rootPath: "/data/other" },
  );
});
