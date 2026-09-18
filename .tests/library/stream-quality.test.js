import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  DEFAULT_STREAM_QUALITY,
  STREAM_QUALITIES,
  isStreamQuality,
  streamParams,
  streamQuality,
} from "../../backend/services/streamQuality.js";

// How good the audio is, per person, set by an admin. Navidrome does the
// transcoding; this only says what to ask it for.

test("Standard is what someone gets without a word being said", () => {
  assert.equal(DEFAULT_STREAM_QUALITY, "standard");
  assert.equal(streamQuality(null).id, "standard");
  assert.equal(streamQuality("nonsense").id, "standard", "an unknown name is not an error to play music over");
});

test("a capped quality asks for a format and a ceiling", () => {
  assert.deepEqual(streamParams("standard"), { format: "mp3", maxBitRate: 192 });
  assert.deepEqual(streamParams("high"), { format: "mp3", maxBitRate: 320 });
});

test("Original asks for the file itself and no ceiling at all", () => {
  // Subsonic reads an absent maxBitRate as no limit; sending 0 would be a
  // different claim about the same thing.
  assert.deepEqual(streamParams("original"), { format: "raw" });
});

test("nothing here promises to make a file into 16-bit FLAC", () => {
  const original = STREAM_QUALITIES.find((quality) => quality.id === "original");
  assert.equal(original.format, "raw", "the file as it is, whatever that is");
  assert.match(original.detail, /nothing is converted or downsampled/i);
});

test("only a known quality can be saved", () => {
  assert.equal(isStreamQuality("original"), true);
  assert.equal(isStreamQuality("lossless"), false);
  assert.equal(isStreamQuality(""), false);
});

test("the listener's quality goes on the stream, read per request", () => {
  const handler = readFileSync(
    new URL("../../backend/routes/library/handlers/stream.js", import.meta.url),
    "utf8",
  );
  assert.match(handler, /streamParams\(dbOps\.getUserStreamQuality\(req\.user\?\.id\)\)/);
});

test("setting it is an admin's job, and listing the choices too", () => {
  const routes = readFileSync(new URL("../../backend/routes/users.js", import.meta.url), "utf8");
  assert.match(routes, /router\.patch\("\/:id\/stream-quality", requireAuth, requireAdmin/);
  assert.match(routes, /router\.get\("\/stream-qualities", requireAuth, requireAdmin/);
  assert.match(routes, /streamQuality: dbOps\.getUserStreamQuality\(user\.id\) \|\| DEFAULT_STREAM_QUALITY/);
});
