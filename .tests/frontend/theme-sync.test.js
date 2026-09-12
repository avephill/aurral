import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

// The theme is kept in localStorage so it can be applied before React mounts
// and still work signed out. That storage is per browser, so themeSync mirrors
// it onto the signed-in account: a choice made on one machine reaches the next.
const openThemeSyncHarness = async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const store = new Map();
  const originalLocalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  const originalMatchMedia = globalThis.matchMedia;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  t.after(() => {
    globalThis.localStorage = originalLocalStorage;
    globalThis.fetch = originalFetch;
    globalThis.matchMedia = originalMatchMedia;
  });

  const requests = [];
  let stored = null;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method, body });
    if (method === "PATCH") stored = body.theme;
    return new Response(JSON.stringify({ theme: stored }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  // Load both from the same module graph: a query string would give theme.js a
  // second instance, and themeSync's subscription would never see our changes.
  // Each test gets a fresh Vite server, so no cache busting is needed.
  const theme = await vite.ssrLoadModule("/src/utils/theme.js");
  const sync = await vite.ssrLoadModule("/src/utils/themeSync.js");
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    theme,
    sync,
    requests,
    settle,
    saved: () => requests.filter((r) => r.method === "PATCH"),
    setServerTheme: (value) => {
      stored = value;
    },
  };
};

test("the account's stored theme wins over whatever this browser had", async (t) => {
  const h = await openThemeSyncHarness(t);
  h.setServerTheme({ themeId: "itunes", appearance: "light" });
  h.theme.setThemeSelection("aurral", "dark");

  h.sync.startThemeSync(7);
  await h.settle();

  assert.deepEqual(h.theme.getThemeSettings(), { themeId: "itunes", appearance: "light" });
  // Receiving the server's own value must not echo it straight back.
  assert.equal(h.saved().length, 0);
});

test("picking a theme saves it to the account", async (t) => {
  const h = await openThemeSyncHarness(t);
  h.setServerTheme({ themeId: "aurral", appearance: "system" });

  h.sync.startThemeSync(7);
  await h.settle();
  h.theme.setThemeSelection("itunes", "light");
  await h.settle();

  assert.equal(h.saved().length, 1);
  assert.deepEqual(h.saved()[0].body.theme, { themeId: "itunes", appearance: "light" });
});

test("a first sign-in with nothing stored adopts this browser's choice", async (t) => {
  const h = await openThemeSyncHarness(t);
  h.setServerTheme(null);
  h.theme.setThemeSelection("itunes", "dark");

  h.sync.startThemeSync(7);
  await h.settle();

  assert.equal(h.saved().length, 1);
  assert.deepEqual(h.saved()[0].body.theme, { themeId: "itunes", appearance: "dark" });
  assert.deepEqual(h.theme.getThemeSettings(), { themeId: "itunes", appearance: "dark" });
});

test("a browser that has never had a theme picked claims nothing", async (t) => {
  const h = await openThemeSyncHarness(t);
  h.setServerTheme(null);
  // No setThemeSelection: this is a fresh browser showing the default.

  h.sync.startThemeSync(7);
  await h.settle();

  // Writing the default here would overwrite a choice made on another machine
  // the moment someone opens the app in a new browser.
  assert.equal(h.saved().length, 0);
});

test("signing out stops mirroring, so the next person's pick is not saved", async (t) => {
  const h = await openThemeSyncHarness(t);
  h.setServerTheme({ themeId: "aurral", appearance: "system" });

  h.sync.startThemeSync(7);
  await h.settle();
  h.sync.startThemeSync(null);
  h.theme.setThemeSelection("itunes", "light");
  await h.settle();

  assert.equal(h.saved().length, 0);
});
