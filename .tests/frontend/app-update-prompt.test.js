import test from "node:test";
import assert from "node:assert/strict";
import {
  UPDATE_DISMISS_KEY,
  readDismissedUpdate,
  rememberDismissedUpdate,
  shouldOfferUpdate,
} from "../../frontend/src/utils/appUpdate.js";

const makeStorage = (initial = {}) => {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    store,
  };
};

test("nothing to say when no update is waiting", () => {
  assert.equal(
    shouldOfferUpdate({ needRefresh: false, waitingVersion: "2.8.0-174", dismissedVersion: "" }),
    false,
  );
});

test("a first update asks straight away, without waiting on the server", () => {
  assert.equal(
    shouldOfferUpdate({ needRefresh: true, waitingVersion: null, dismissedVersion: "" }),
    true,
  );
});

test("an update already turned down stays quiet", () => {
  assert.equal(
    shouldOfferUpdate({
      needRefresh: true,
      waitingVersion: "2.8.0-174",
      dismissedVersion: "2.8.0-174",
    }),
    false,
  );
});

test("a newer build than the one turned down asks again", () => {
  assert.equal(
    shouldOfferUpdate({
      needRefresh: true,
      waitingVersion: "2.8.0-175",
      dismissedVersion: "2.8.0-174",
    }),
    true,
  );
});

test("while the server has not said which build is waiting, it holds rather than flashing", () => {
  assert.equal(
    shouldOfferUpdate({ needRefresh: true, waitingVersion: null, dismissedVersion: "2.8.0-174" }),
    false,
  );
});

test("a server that will not name a version is asked about rather than hidden", () => {
  assert.equal(
    shouldOfferUpdate({ needRefresh: true, waitingVersion: "", dismissedVersion: "2.8.0-174" }),
    true,
  );
});

test("dismissal is remembered, and an unknown version is not written down", () => {
  const storage = makeStorage();
  rememberDismissedUpdate(storage, "2.8.0-174");
  assert.equal(readDismissedUpdate(storage), "2.8.0-174");
  rememberDismissedUpdate(storage, "");
  assert.equal(storage.store.get(UPDATE_DISMISS_KEY), "2.8.0-174");
});

test("storage that throws leaves the prompt working", () => {
  const storage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.equal(readDismissedUpdate(storage), "");
  assert.doesNotThrow(() => rememberDismissedUpdate(storage, "2.8.0-174"));
});
