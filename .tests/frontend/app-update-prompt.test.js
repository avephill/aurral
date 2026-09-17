import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  UPDATE_DISMISS_KEY,
  isPageAlreadyCurrent,
  readDismissedUpdate,
  rememberDismissedUpdate,
  shouldOfferUpdate,
} from "../../frontend/src/utils/appUpdate.js";

const OLD = "2.8.0-174";
const NEW = "2.8.0-180";

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
    shouldOfferUpdate({
      needRefresh: false,
      waitingVersion: NEW,
      dismissedVersion: "",
      runningVersion: OLD,
    }),
    false,
  );
});

test("a page already running what the server serves says nothing", () => {
  // The reload fetched the new build; only the worker is behind.
  assert.equal(
    shouldOfferUpdate({
      needRefresh: true,
      waitingVersion: NEW,
      dismissedVersion: "",
      runningVersion: NEW,
    }),
    false,
  );
  assert.equal(isPageAlreadyCurrent({ waitingVersion: NEW, runningVersion: `v${NEW}` }), true);
});

test("a tab left open across a deploy is genuinely stale, and is told", () => {
  assert.equal(
    shouldOfferUpdate({
      needRefresh: true,
      waitingVersion: NEW,
      dismissedVersion: "",
      runningVersion: OLD,
    }),
    true,
  );
});

test("an update already turned down stays quiet", () => {
  assert.equal(
    shouldOfferUpdate({
      needRefresh: true,
      waitingVersion: NEW,
      dismissedVersion: NEW,
      runningVersion: OLD,
    }),
    false,
  );
});

test("a newer build than the one turned down asks again", () => {
  assert.equal(
    shouldOfferUpdate({
      needRefresh: true,
      waitingVersion: "2.8.0-181",
      dismissedVersion: NEW,
      runningVersion: OLD,
    }),
    true,
  );
});

test("while the server has not said which build is waiting, it holds rather than flashing", () => {
  assert.equal(
    shouldOfferUpdate({
      needRefresh: true,
      waitingVersion: null,
      dismissedVersion: NEW,
      runningVersion: OLD,
    }),
    false,
  );
});

test("a server that will not name a version is asked about rather than hidden", () => {
  assert.equal(
    shouldOfferUpdate({
      needRefresh: true,
      waitingVersion: "",
      dismissedVersion: NEW,
      runningVersion: OLD,
    }),
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

test("the prompt hands over quietly when the page is already current", () => {
  const source = readFileSync(
    new URL("../../frontend/src/components/ReloadPrompt.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /isPageAlreadyCurrent\(\{ waitingVersion, runningVersion \}\)/);
  assert.match(source, /updateServiceWorker\(false\)/, "activate it without reloading the page");
  assert.match(source, /import\.meta\.env\.VITE_APP_VERSION/, "the build stamps its own version in");
});
