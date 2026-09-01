import test from "node:test";
import assert from "node:assert/strict";

import {
  DISCOVER_SECTION_IDS,
  getDefaultDiscoverLayout,
} from "../../backend/config/discoverLayoutDefaults.js";

test.beforeEach(() => {
  delete process.env.AURRAL_DISCOVER_DEFAULT_SECTIONS;
});

test.after(() => {
  delete process.env.AURRAL_DISCOVER_DEFAULT_SECTIONS;
});

test("default layout enables every section in the standard order", () => {
  assert.deepEqual(
    getDefaultDiscoverLayout(),
    DISCOVER_SECTION_IDS.map((id) => ({ id, enabled: true })),
  );
});

test("AURRAL_DISCOVER_DEFAULT_SECTIONS reorders and disables unlisted sections", () => {
  process.env.AURRAL_DISCOVER_DEFAULT_SECTIONS = "recentReleases, recentlyAdded";
  const layout = getDefaultDiscoverLayout();
  assert.deepEqual(layout.slice(0, 2), [
    { id: "recentReleases", enabled: true },
    { id: "recentlyAdded", enabled: true },
  ]);
  const rest = layout.slice(2);
  assert.equal(rest.length, DISCOVER_SECTION_IDS.length - 2);
  assert.ok(rest.every((item) => item.enabled === false));
  assert.ok(rest.some((item) => item.id === "globalTop"));
});

test("unknown ids and duplicates are ignored", () => {
  process.env.AURRAL_DISCOVER_DEFAULT_SECTIONS = "bogus,recommended,recommended";
  const layout = getDefaultDiscoverLayout();
  assert.deepEqual(layout[0], { id: "recommended", enabled: true });
  assert.equal(layout.filter((item) => item.id === "recommended").length, 1);
  assert.equal(layout.length, DISCOVER_SECTION_IDS.length);
});

test("a value with no valid ids falls back to all-enabled defaults", () => {
  process.env.AURRAL_DISCOVER_DEFAULT_SECTIONS = "nope,also-nope";
  assert.deepEqual(
    getDefaultDiscoverLayout(),
    DISCOVER_SECTION_IDS.map((id) => ({ id, enabled: true })),
  );
});
