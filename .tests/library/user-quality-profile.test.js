import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// What quality a person's requests are fetched at. Lidarr already held a
// per-user quality profile; what changed is whose call it is.

const routes = readFileSync(new URL("../../backend/routes/users.js", import.meta.url), "utf8");
const table = readFileSync(
  new URL("../../frontend/src/pages/Settings/components/SettingsUsersTab.jsx", import.meta.url),
  "utf8",
);

test("an admin sets it for someone else", () => {
  assert.match(routes, /router\.patch\("\/:id\/quality-profile", requireAuth, requireAdmin/);
  assert.match(routes, /router\.get\("\/lidarr-profiles", requireAuth, requireAdmin/);
});

test("and nobody sets their own any more", () => {
  // Previously anyone could pick their own through /me/lidarr-preferences.
  // Refused rather than quietly ignored, so a stale UI says something.
  assert.match(routes, /hasQualityProfileId && req\.user\.role !== "admin"/);
  assert.match(routes, /An admin chooses what quality your music is fetched at\./);
});

test("unset means the server's own default, which is a real answer", () => {
  assert.match(routes, /const wanted = raw === null \|\| raw === "" \|\| raw === undefined \? null : Number\(raw\)/);
  assert.match(routes, /lidarrQualityProfileId: wanted/);
});

test("a profile Lidarr does not have is refused", () => {
  assert.match(routes, /Unknown Lidarr quality profile/);
});

test("it sits beside the person in Settings", () => {
  assert.match(table, /<UserQualityProfile user=\{user\} onSaved=\{refreshUsers\} \/>/);
  assert.match(table, /<th scope="col">Quality<\/th>/);
});

test("playback is left alone", () => {
  // An earlier attempt at this transcoded what everyone heard. This one only
  // decides what gets fetched; nothing touches the stream.
  const stream = readFileSync(
    new URL("../../backend/routes/library/handlers/stream.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(stream, /maxBitRate|streamParams|format/);
});
