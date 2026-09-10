import assert from "node:assert/strict";
import test from "node:test";

import { createMockHttpServer, importFromRepo } from "../helpers/backendTestHarness.js";

const { NavidromeClient } = await importFromRepo("backend/services/navidrome.js");

const ZERO_TIME = "0001-01-01T00:00:00Z";

// One fake Navidrome whose native library list and Subsonic scan status can be
// steered independently, so the fallback path can be exercised.
function createFakeNavidrome() {
  const state = {
    libraries: [],
    nativeStatus: 200,
    subsonicScanning: false,
    subsonicStatus: 200,
    nativeCalls: 0,
    subsonicCalls: 0,
  };
  const handler = (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const reply = (body, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/auth/login") return reply({ token: "admin-token" });
    if (url.pathname === "/api/library") {
      state.nativeCalls += 1;
      if (state.nativeStatus !== 200) return reply({ error: "nope" }, state.nativeStatus);
      return reply(state.libraries);
    }
    if (url.pathname === "/rest/getScanStatus") {
      state.subsonicCalls += 1;
      if (state.subsonicStatus !== 200) {
        return reply({
          "subsonic-response": {
            status: "failed",
            version: "1.16.1",
            error: { code: 40, message: "Wrong username or password" },
          },
        });
      }
      return reply({
        "subsonic-response": {
          status: "ok",
          version: "1.16.1",
          scanStatus: { scanning: state.subsonicScanning, count: 7 },
        },
      });
    }
    return reply({ error: "not found" }, 404);
  };
  return { state, handler };
}

let server;
let fake;
let client;

test.before(async () => {
  fake = createFakeNavidrome();
  server = await createMockHttpServer(fake.handler);
  client = new NavidromeClient(server.url, "avery", "secret");
});

test.after(async () => {
  await server?.close();
});

test("an idle library reads as not scanning", async () => {
  fake.state.libraries = [
    { id: 1, name: "Music Library", fullScanInProgress: false, lastScanAt: "2026-09-10T20:29:54Z", lastScanStartedAt: ZERO_TIME },
    { id: 4, name: "avery", fullScanInProgress: false, lastScanAt: "2026-09-10T20:29:54Z", lastScanStartedAt: ZERO_TIME },
  ];
  assert.deepEqual(await client.getScanStatus(), { scanning: false, count: 2 });
  assert.equal(fake.state.subsonicCalls, 0, "the native list answers without touching Subsonic");
});

test("a full scan on any library reads as scanning", async () => {
  fake.state.libraries = [
    { id: 1, fullScanInProgress: false, lastScanAt: "2026-09-10T20:29:54Z", lastScanStartedAt: ZERO_TIME },
    { id: 4, fullScanInProgress: true, lastScanAt: "2026-09-10T20:29:54Z", lastScanStartedAt: ZERO_TIME },
  ];
  assert.equal((await client.getScanStatus()).scanning, true);
});

test("a quick scan in flight reads as scanning", async () => {
  // Navidrome moves lastScanAt only when the scan finishes.
  fake.state.libraries = [
    { id: 1, fullScanInProgress: false, lastScanAt: "2026-09-10T20:29:54Z", lastScanStartedAt: "2026-09-10T21:05:00Z" },
  ];
  assert.equal((await client.getScanStatus()).scanning, true);

  fake.state.libraries = [
    { id: 1, fullScanInProgress: false, lastScanAt: "2026-09-10T21:06:00Z", lastScanStartedAt: "2026-09-10T21:05:00Z" },
  ];
  assert.equal((await client.getScanStatus()).scanning, false);
});

test("Subsonic answers when the native API refuses", async () => {
  fake.state.nativeStatus = 401;
  fake.state.subsonicScanning = true;
  const before = fake.state.subsonicCalls;
  assert.deepEqual(await client.getScanStatus(), { scanning: true, count: 7 });
  assert.equal(fake.state.subsonicCalls, before + 1);
});

test("when neither answers, the wait reports an unknown state instead of a free database", async () => {
  fake.state.nativeStatus = 401;
  fake.state.subsonicStatus = 401;
  await assert.rejects(() => client.getScanStatus());
  assert.deepEqual(await client.waitForScanToFinish({ timeoutMs: 10, intervalMs: 1 }), {
    waited: false,
    scanning: null,
  });
  fake.state.nativeStatus = 200;
  fake.state.subsonicStatus = 200;
});
