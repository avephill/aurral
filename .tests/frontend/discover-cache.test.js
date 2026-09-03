import assert from "node:assert/strict";
import test from "node:test";
import {
  getStoredRecentlyAddedAt,
  isStoredRecentlyAddedFresh,
  readStoredRecentlyAdded,
} from "../../frontend/src/pages/discoverUtils.js";

const withFakeStorage = (run) => {
  const originalStorage = globalThis.localStorage;
  const originalNow = Date.now;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  Date.now = () => 1_000_000;
  try {
    run();
  } finally {
    Date.now = originalNow;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
};

test("a user's discover cache reads only that user's key", () => {
  withFakeStorage(() => {
    // Written before caches were keyed per user, so it holds the whole
    // server's rails. Reading it for a signed-in user would paint artists
    // outside their personal library, or another account's on a shared browser.
    localStorage.setItem("discoverRecentlyAdded", JSON.stringify([{ id: 1 }]));
    localStorage.setItem("discoverRecentlyAdded:at", "999000");
    assert.equal(readStoredRecentlyAdded(7), null);
    assert.equal(getStoredRecentlyAddedAt(7), 0);

    localStorage.setItem("discoverRecentlyAdded:7", JSON.stringify([{ id: 2 }]));
    localStorage.setItem("discoverRecentlyAdded:7:at", "999000");
    assert.deepEqual(readStoredRecentlyAdded(7), [{ id: 2 }]);
    assert.equal(getStoredRecentlyAddedAt(7), 999000);
  });
});

test("discover cache freshness rejects future timestamps", () => {
  withFakeStorage(() => {
    localStorage.setItem("discoverRecentlyAdded", JSON.stringify([{ id: 1 }]));
    localStorage.setItem("discoverRecentlyAdded:at", "999000");
    assert.equal(isStoredRecentlyAddedFresh(), true);

    localStorage.setItem("discoverRecentlyAdded:at", "1001000");
    assert.equal(isStoredRecentlyAddedFresh(), false);
  });
});
