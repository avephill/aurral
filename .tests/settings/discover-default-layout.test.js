import test from "node:test";
import assert from "node:assert/strict";

import {
  DISCOVER_SECTION_IDS,
  LIBRARY_RECOMMENDATION_SECTION_IDS,
  getDefaultDiscoverLayout,
} from "../../backend/config/discoverLayoutDefaults.js";

test.beforeEach(() => {
  delete process.env.AURRAL_DISCOVER_DEFAULT_SECTIONS;
  delete process.env.AURRAL_LIBRARY_RECOMMENDATIONS_ENABLED;
});

test.after(() => {
  delete process.env.AURRAL_DISCOVER_DEFAULT_SECTIONS;
  delete process.env.AURRAL_LIBRARY_RECOMMENDATIONS_ENABLED;
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

test("the recommendation rails leave the layout when the engine is off", () => {
  process.env.AURRAL_LIBRARY_RECOMMENDATIONS_ENABLED = "false";
  const layout = getDefaultDiscoverLayout();
  const ids = layout.map((item) => item.id);
  // Dropped outright, not offered as a switch with nothing behind it.
  for (const id of LIBRARY_RECOMMENDATION_SECTION_IDS) {
    assert.ok(!ids.includes(id), `${id} should not be offered`);
  }
  assert.equal(layout.length, DISCOVER_SECTION_IDS.length - LIBRARY_RECOMMENDATION_SECTION_IDS.length);
  assert.ok(layout.every((item) => item.enabled === true));
  assert.ok(ids.includes("recentReleases"));
  assert.ok(ids.includes("recommendedShows"));
});

test("an explicit default naming only disabled rails falls back to what is left", () => {
  process.env.AURRAL_LIBRARY_RECOMMENDATIONS_ENABLED = "false";
  process.env.AURRAL_DISCOVER_DEFAULT_SECTIONS = "recommended,genreSections";
  const layout = getDefaultDiscoverLayout();
  assert.ok(layout.length > 0);
  assert.ok(layout.every((item) => !LIBRARY_RECOMMENDATION_SECTION_IDS.includes(item.id)));
});
