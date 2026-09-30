import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { cleanupIsolatedState, resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

// Smart playlists with a tag rule, which Psalter keeps because Navidrome
// cannot read Psalter's tags.

const [isolatedState, { db }, { userOps }, kept] = await setupIsolatedBackend(
  "kept-smart-playlists",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/tagPlaylistService.js",
);

test.before(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM tag_playlists").run();
  userOps.createUser("dunshill", "hash");
});

test.after(() => cleanupIsolatedState(isolatedState));

test("a new one may not take the name of a playlist he already has", async () => {
  await assert.rejects(
    () => kept.createKeptPlaylist({ owner: "dunshill", name: "Holiday", rules: { conditions: [] }, existingNames: ["holiday "] }),
    (error) => error.status === 409 && /already have a playlist called "Holiday"/.test(error.message),
  );
  db.prepare(`
    INSERT INTO tag_playlists (owner, name, rules_json, enabled, created_at, updated_at) VALUES ('dunshill', 'Sunday', '{}', 0, 0, 0)
  `).run();
  await assert.rejects(
    () => kept.createKeptPlaylist({ owner: "dunshill", name: "sunday", rules: { conditions: [] }, existingNames: [] }),
    /already have a playlist called/,
    "nor the name of one converted from iTunes",
  );
});

test("one kept here is found by the playlist it writes, renamed with it, and let go", () => {
  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO tag_playlists (owner, name, rules_json, enabled, made_here, navidrome_playlist_id, created_at, updated_at)
    VALUES ('dunshill', 'Sunday best', ?, 1, 1, 'nd-7', 0, 0)
  `).run(JSON.stringify({ match: "all", conditions: [{ field: "tag", operator: "has", value: "sunday" }] }));
  const row = kept.keptPlaylistFor("dunshill", "nd-7");
  assert.equal(row.id, Number(id));
  assert.equal(row.rules.conditions[0].value, "sunday");
  assert.equal(kept.keptPlaylistFor("somebody else", "nd-7"), null, "only its owner's");

  kept.renameKept(row, "Sunday best of all");
  assert.equal(db.prepare("SELECT name FROM tag_playlists WHERE id = ?").get(id).name, "Sunday best of all");
  kept.forgetKept(row);
  assert.equal(kept.keptPlaylistFor("dunshill", "nd-7"), null);
});

test("the routes send a tag rule to Psalter, and keep a kept playlist Psalter's", () => {
  const routes = readFileSync(new URL("../../backend/routes/navidromePlaylists.js", import.meta.url), "utf8");
  assert.match(routes, /if \(usesTagRule\(req\.body\?\.rules\)\) \{\s*try \{\s*const rules = toPsalterRules/);
  assert.match(routes, /const kept = keptPlaylistFor\(keeper\.user, req\.params\.id\);/);
  assert.match(routes, /cannot read Psalter's tags\. Make a new smart playlist for a tag rule\./);
  assert.match(routes, /if \(kept\) renameKept\(kept, name\);/);
  assert.match(routes, /if \(kept\) forgetKept\(kept\);/);
  const editor = readFileSync(new URL("../../frontend/src/components/SmartPlaylistEditor.jsx", import.meta.url), "utf8");
  assert.match(editor, /Psalter keeps this playlist up to date from the rules below/);
  assert.match(editor, /keeper === "navidrome" \? allFields\.filter\(\(field\) => field\.type !== "tag"\)/);
});
