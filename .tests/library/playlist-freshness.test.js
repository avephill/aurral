import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A smart playlist is a promise that it keeps itself up to date. Psalter
// evaluates these rather than Navidrome, so something has to rebuild them when
// the things the rules read change.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const tagPlaylists = read("../../backend/services/tagPlaylistService.js");
const userLibraries = read("../../backend/services/userLibraryService.js");
const server = read("../../backend/server.js");

test("something rebuilds them even when Psalter is told nothing", () => {
  assert.match(tagPlaylists, /export function startTagPlaylistSweep/);
  assert.match(tagPlaylists, /reason: "regular sweep", fresh: true/);
  assert.match(server, /startTagPlaylistSweep\(\)/, "and it starts with the app");
});

test("a sweep re-reads the library rather than trusting the cached songs", () => {
  assert.match(tagPlaylists, /if \(fresh\) songsByOwner\.delete\(owner\);/);
  assert.match(tagPlaylists, /buildTagPlaylist\(id, \{ fresh \}\)/);
});

test("music joining someone's library rebuilds their playlists", () => {
  assert.match(userLibraries, /scheduleTagPlaylistRebuild\(entry\.username/);
  assert.match(userLibraries, /reason: "personal library changed"/);
  // The scan has to finish first, or the new songs are not there to be found.
  assert.match(userLibraries, /delayMs: 5 \* 60_000/);
});

test("a playlist Navidrome keeps by its own rules is left alone", () => {
  assert.match(tagPlaylists, /async function hasNavidromeRules/);
  assert.match(tagPlaylists, /is a Navidrome smart playlist/);
  assert.match(tagPlaylists, /return Boolean\(record\?\.rules\)/);
});
