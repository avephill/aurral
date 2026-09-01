import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, dbHelpers, authModule] = await setupIsolatedBackend(
  "playlists-disabled",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/middleware/auth.js",
);

const { userOps } = dbHelpers;
const { hasPermission, ensureExternalUser } = authModule;

test.beforeEach(() => {
  resetDatabase(db);
  delete process.env.AURRAL_PLAYLISTS_ENABLED;
});

test.after(async () => {
  delete process.env.AURRAL_PLAYLISTS_ENABLED;
  await cleanupIsolatedState(isolatedState);
});

test("accessFlow is granted normally while playlists are enabled", () => {
  assert.equal(hasPermission({ role: "admin", permissions: {} }, "accessFlow"), true);
  assert.equal(
    hasPermission({ role: "user", permissions: { accessFlow: true } }, "accessFlow"),
    true,
  );
});

test("AURRAL_PLAYLISTS_ENABLED=false denies accessFlow for everyone", () => {
  process.env.AURRAL_PLAYLISTS_ENABLED = "false";
  assert.equal(hasPermission({ role: "admin", permissions: {} }, "accessFlow"), false);
  assert.equal(
    hasPermission({ role: "user", permissions: { accessFlow: true } }, "accessFlow"),
    false,
  );
  assert.equal(hasPermission({ role: "admin", permissions: {} }, "addArtist"), true);
});

test("AURRAL_PLAYLISTS_ENABLED=false strips accessFlow from resolved permissions", () => {
  process.env.AURRAL_PLAYLISTS_ENABLED = "false";
  const admin = ensureExternalUser("gordon", "admin");
  assert.equal(admin.permissions.accessFlow, false);
  assert.equal(admin.permissions.addArtist, true);
  const regular = ensureExternalUser("jody", "user");
  assert.equal(regular.permissions.accessFlow, false);
  assert.equal(userOps.getAllUsers().length, 2);
});
