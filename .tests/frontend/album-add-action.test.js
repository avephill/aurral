import test from "node:test";
import assert from "node:assert/strict";

import {
  getAlbumAddButtonLabel,
  isAlbumCompleteInLibrary,
  shouldTriggerAlbumSearch,
} from "../../frontend/src/utils/albumAddAction.js";

test("shouldTriggerAlbumSearch follows monitored state", () => {
  assert.equal(shouldTriggerAlbumSearch({ status: "available" }), false);
  assert.equal(shouldTriggerAlbumSearch({ status: "unmonitored", inLibrary: true }), false);
  assert.equal(shouldTriggerAlbumSearch({ status: "monitored" }), true);
  assert.equal(shouldTriggerAlbumSearch({ inLibrary: true, monitored: true }), true);
  assert.equal(shouldTriggerAlbumSearch({ inLibrary: true, monitored: false }), false);
  assert.equal(shouldTriggerAlbumSearch({ status: "inLibrary", monitored: true }), true);
  assert.equal(shouldTriggerAlbumSearch({ status: "inLibrary", monitored: false }), false);
});

test("getAlbumAddButtonLabel matches trigger semantics", () => {
  assert.equal(getAlbumAddButtonLabel({ status: "monitored" }), "Search again");
  assert.equal(getAlbumAddButtonLabel({ status: "unmonitored" }), "Request");
  assert.equal(getAlbumAddButtonLabel({ inLibrary: true, monitored: false }), "Request");
});

test("isAlbumCompleteInLibrary only treats on-disk albums as complete", () => {
  assert.equal(isAlbumCompleteInLibrary({ status: "monitored" }), false);
  assert.equal(isAlbumCompleteInLibrary({ status: "available" }), true);
  assert.equal(isAlbumCompleteInLibrary({ sizeOnDisk: 1 }), true);
});
