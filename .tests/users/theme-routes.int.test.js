import assert from "node:assert/strict";
import test from "node:test";

import bcrypt from "bcrypt";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "theme-routes",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

let server;
let userAToken;
let userBToken;

async function login(username, password) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json();
  return payload.token;
}

async function apiFetch(token, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  userOps.createUser("theme-user-a", bcrypt.hashSync("password123", 4), "user");
  userOps.createUser("theme-user-b", bcrypt.hashSync("password123", 4), "user");
  server = await startServerProcess();
  userAToken = await login("theme-user-a", "password123");
  userBToken = await login("theme-user-b", "password123");
});

test.after(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("GET /me/theme requires authentication", async () => {
  const { response } = await apiFetch(null, "/api/users/me/theme");
  assert.equal(response.status, 401);
});

test("a theme saved on one device is returned on the next", async () => {
  const { response: saved, payload: savedPayload } = await apiFetch(userAToken, "/api/users/me/theme", {
    method: "PATCH",
    body: JSON.stringify({ theme: { themeId: "itunes", appearance: "light" } }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(savedPayload.theme, { themeId: "itunes", appearance: "light" });

  // A different sign-in, as the same person, reads the stored choice back.
  const freshToken = await login("theme-user-a", "password123");
  const { payload: readBack } = await apiFetch(freshToken, "/api/users/me/theme");
  assert.deepEqual(readBack.theme, { themeId: "itunes", appearance: "light" });
});

test("one person's theme never reaches another account", async () => {
  const { payload } = await apiFetch(userBToken, "/api/users/me/theme");
  assert.equal(payload.theme, null);

  await apiFetch(userBToken, "/api/users/me/theme", {
    method: "PATCH",
    body: JSON.stringify({ theme: { themeId: "aurral", appearance: "dark" } }),
  });

  const { payload: stillA } = await apiFetch(userAToken, "/api/users/me/theme");
  assert.deepEqual(stillA.theme, { themeId: "itunes", appearance: "light" });
});

test("a nonsense appearance is refused rather than stored", async () => {
  const { response } = await apiFetch(userAToken, "/api/users/me/theme", {
    method: "PATCH",
    body: JSON.stringify({ theme: { themeId: "itunes", appearance: "sepia" } }),
  });
  assert.equal(response.status, 400);

  const { payload } = await apiFetch(userAToken, "/api/users/me/theme");
  assert.deepEqual(payload.theme, { themeId: "itunes", appearance: "light" });
});

test("a missing theme id is refused", async () => {
  const { response } = await apiFetch(userAToken, "/api/users/me/theme", {
    method: "PATCH",
    body: JSON.stringify({ theme: { appearance: "dark" } }),
  });
  assert.equal(response.status, 400);
});
