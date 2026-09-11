import assert from "node:assert/strict";
import test from "node:test";

import { importFromRepo } from "../helpers/backendTestHarness.js";

const { publicLibraryJsonReplacer, stripFilesystemPaths } = await importFromRepo(
  "backend/routes/library/handlers/canonical.js",
);

// Where a file sits on the server is nobody's business but the server's, and
// any key named like a path is dropped on the way out. One key only looks like
// one: streamPath is a URL on Aurral's own API, and dropping it left callers
// with a track they could see and could not play.

test("real filesystem paths never leave the server", () => {
  const payload = {
    title: "A New Day Yesterday",
    path: "/data/Music/Library/Jethro Tull/Stand Up/01 A New Day Yesterday.flac",
    rootPath: "/data/Music",
    libraryPath: "/music",
    files: [{ path: "/data/Music/x.flac", size: 10 }],
  };
  const stripped = stripFilesystemPaths(payload);
  assert.equal(stripped.path, undefined);
  assert.equal(stripped.rootPath, undefined);
  assert.equal(stripped.libraryPath, undefined);
  assert.equal(stripped.files[0].path, undefined);
  assert.equal(stripped.files[0].size, 10);
  assert.equal(stripped.title, payload.title);
});

test("the stream URL is kept, because it is a URL and not a path", () => {
  const track = { title: "Hunting", streamPath: "/library/canonical-stream/29703/235669" };
  assert.equal(stripFilesystemPaths(track).streamPath, track.streamPath);
  assert.equal(
    JSON.parse(JSON.stringify(track, publicLibraryJsonReplacer)).streamPath,
    track.streamPath,
  );
});

test("the same rule applies whichever way a response is serialised", () => {
  const payload = { path: "/data/Music/x.flac", streamPath: "/library/canonical-stream/1/2" };
  const viaReplacer = JSON.parse(JSON.stringify(payload, publicLibraryJsonReplacer));
  const viaStrip = stripFilesystemPaths(payload);
  assert.deepEqual(viaReplacer, viaStrip);
  assert.deepEqual(viaReplacer, { streamPath: "/library/canonical-stream/1/2" });
});
