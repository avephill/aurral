import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// Being shown around the app once: the tour marks itself done, and an admin
// can give it back to someone after setting their account up for them.

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "walkthrough",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

let dad;
let admin;

test.before(() => {
  resetDatabase(db);
  admin = userOps.getUserById(userOps.createUser("avery", "hash", "admin").id);
  dad = userOps.getUserById(userOps.createUser("dunshill", "hash").id);
});

test.after(() => cleanupIsolatedState(isolatedState));

test("someone who has never been shown around is owed the tour", () => {
  assert.equal(dbOps.getUserWalkthrough(dad.id), null);
  assert.equal(dbOps.getUserWalkthrough(admin.id), null);
});

test("finishing it is remembered, and only for that person", () => {
  dbOps.setUserWalkthrough(dad.id, { completedAt: Date.now() });
  assert.ok(dbOps.getUserWalkthrough(dad.id)?.completedAt, "his is done");
  assert.equal(dbOps.getUserWalkthrough(admin.id), null, "nobody else's is");
});

test("an admin can hand it back", () => {
  dbOps.setUserWalkthrough(dad.id, null);
  assert.equal(dbOps.getUserWalkthrough(dad.id), null);
});
