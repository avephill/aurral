import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFlowTrack, shouldRecordListen } from "../../frontend/src/utils/audioQueue.js";

const track = {
  id: "flow-track",
  trackName: "Track",
  artistName: "Artist",
  streamUrl: "/stream/flow-track",
};

test("flow playback can opt out of listening history", () => {
  assert.equal(normalizeFlowTrack(track).recordHistory, true);
  assert.equal(
    normalizeFlowTrack(track, { recordHistory: false }).recordHistory,
    false,
  );
});

// When a listen counts as a play. Recording only at a track's natural end
// missed every song someone skips out of, and a play in the app then never
// reached Navidrome at all.
test("a listen counts at half the track, or four minutes of a long one", () => {
  const listen = (heardSeconds, totalSeconds) => shouldRecordListen({ heardSeconds, totalSeconds });

  // A three minute song: halfway counts, a sample does not.
  assert.equal(listen(30, 180), false);
  assert.equal(listen(89, 180), false);
  assert.equal(listen(90, 180), true);
  assert.equal(listen(180, 180), true);

  // A twenty minute piece counts at four minutes rather than ten.
  assert.equal(listen(239, 1200), false);
  assert.equal(listen(240, 1200), true);

  // Too short to judge by halves; only finishing it counts, via onend.
  assert.equal(listen(20, 20), false);

  // Nothing known about the track yet.
  assert.equal(listen(10, 0), false);
  assert.equal(shouldRecordListen(), false);
});
