import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveRoots,
  joinRoot,
  lookupSuffix,
  navidromeRelativePath,
  relativeToRoot,
  sharedSuffixLength,
} from "../../backend/services/navidromePathMapping.js";

test("derives both roots when Navidrome reports a library-relative path", () => {
  const roots = deriveRoots(
    "/data/Music/Jethro Tull/Stand Up/01 A New Day Yesterday.flac",
    "Jethro Tull/Stand Up/01 A New Day Yesterday.flac",
  );
  assert.deepEqual(roots, {
    aurralRoot: "/data/Music",
    navidromeRoot: "",
    relative: "Jethro Tull/Stand Up/01 A New Day Yesterday.flac",
  });
});

test("derives both roots when Navidrome reports an absolute path under its own mount", () => {
  const roots = deriveRoots(
    "/data/Music/Jethro Tull/Stand Up/01 A New Day Yesterday.flac",
    "/music/Jethro Tull/Stand Up/01 A New Day Yesterday.flac",
  );
  assert.deepEqual(roots, {
    aurralRoot: "/data/Music",
    navidromeRoot: "/music",
    relative: "Jethro Tull/Stand Up/01 A New Day Yesterday.flac",
  });
});

test("a matching filename alone is not enough to trust", () => {
  assert.equal(sharedSuffixLength("/a/b/01 Track.flac", "/x/y/01 Track.flac"), 1);
  assert.equal(deriveRoots("/a/b/01 Track.flac", "/x/y/01 Track.flac"), null);
});

test("paths that share nothing derive nothing", () => {
  assert.equal(deriveRoots("/data/Music/A/B/c.flac", "D/E/f.flac"), null);
});

test("relativeToRoot only answers for paths under the root", () => {
  assert.equal(relativeToRoot("/data/Music/A/B/c.flac", "/data/Music"), "A/B/c.flac");
  assert.equal(relativeToRoot("/other/A/B/c.flac", "/data/Music"), null);
  assert.equal(relativeToRoot("/data/Music/A/B/c.flac", ""), "data/Music/A/B/c.flac");
});

test("navidromeRelativePath strips an absolute Navidrome root and leaves relative paths alone", () => {
  assert.equal(navidromeRelativePath("/music/A/B/c.flac", "/music"), "A/B/c.flac");
  assert.equal(navidromeRelativePath("A/B/c.flac", "/music"), "A/B/c.flac");
  assert.equal(navidromeRelativePath("A/B/c.flac", ""), "A/B/c.flac");
});

test("joinRoot and lookupSuffix round-trip a relative path", () => {
  assert.equal(joinRoot("/data/Music", "A/B/c.flac"), "/data/Music/A/B/c.flac");
  assert.equal(lookupSuffix("/music/A/B/c.flac"), "B/c.flac");
  assert.equal(lookupSuffix("c.flac"), "c.flac");
});
