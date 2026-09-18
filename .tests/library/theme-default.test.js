import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Psalter looks like iTunes for everyone, not only for whoever went looking
// in Settings.

const schema = readFileSync(new URL("../../backend/config/db-sqlite.js", import.meta.url), "utf8");
const theme = readFileSync(new URL("../../frontend/src/utils/theme.js", import.meta.url), "utf8");

test("a browser with nothing chosen shows the iTunes theme", () => {
  assert.match(theme, /export const INITIAL_THEME_ID = ITUNES_THEME_ID;/);
  assert.match(theme, /getThemeDefinition\(storedTheme\) \? storedTheme : INITIAL_THEME_ID/);
});

test("the Aurral theme keeps its own name", () => {
  // DEFAULT_THEME_ID names that theme, and the older storage format and the
  // follows-the-system case are written against it. Repointing it at iTunes
  // would have quietly changed what those mean.
  assert.match(theme, /export const DEFAULT_THEME_ID = "aurral";/);
});

test("themes already chosen are moved across once, keeping light or dark", () => {
  assert.match(schema, /key LIKE 'user:%:theme'/);
  assert.match(schema, /json_set\([\s\S]*?'\$\.themeId', 'itunes'\)/);
  // Only the theme changes; whatever they set for light, dark or system stays.
  assert.doesNotMatch(schema, /'\$\.appearance'/);
});

test("it is a one-time pass, so a later choice sticks", () => {
  assert.match(schema, /NOT EXISTS \(SELECT 1 FROM settings WHERE key = 'theme:itunesForEveryone:v1'\)/);
  assert.match(schema, /INSERT OR IGNORE INTO settings \(key, value\) VALUES \('theme:itunesForEveryone:v1'/);
});
