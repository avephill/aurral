import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { addTrackPerformers, resetTrackPerformerCache } = await import(
  "../../backend/services/trackPerformerTags.js"
);

// On a compilation every track's indexed artist is the album's ("Various
// Artists"); the song's own artist comes from its file's artist tag.

test("a song's artist tag is read from its file, once per version of the file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psalter-performer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tagged = path.join(dir, "01.flac");
  const untagged = path.join(dir, "02.flac");
  fs.writeFileSync(tagged, "x");
  fs.writeFileSync(untagged, "x");
  const tags = { [tagged]: { artist: "Rudy Vallée" }, [untagged]: { artist: "" } };
  let reads = 0;
  const reader = async (filePath) => {
    reads += 1;
    return { common: tags[filePath] || {} };
  };
  resetTrackPerformerCache();

  const tracks = [
    { id: 1, files: [{ path: tagged, available: true }] },
    { id: 2, files: [{ path: untagged, available: true }] },
    { id: 3, files: [{ path: path.join(dir, "missing.flac"), available: true }] },
    { id: 4, files: [{ path: tagged, available: false }] },
  ];
  await addTrackPerformers(tracks, { reader });
  assert.equal(tracks[0].performerName, "Rudy Vallée");
  assert.equal(tracks[1].performerName, undefined, "no artist tag, nothing added");
  assert.equal(tracks[2].performerName, undefined, "a missing file is skipped, not an error");
  assert.equal(tracks[3].performerName, undefined, "only available files are read");

  const readsSoFar = reads;
  const again = [{ id: 5, files: [{ path: tagged, available: true }] }];
  await addTrackPerformers(again, { reader });
  assert.equal(again[0].performerName, "Rudy Vallée");
  assert.equal(reads, readsSoFar, "an unchanged file is not read again");
});
