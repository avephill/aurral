/**
 * Applies the plan from smart_playlists.py: for each playlist, a set of rules
 * Navidrome will keep up to date.
 *
 * Runs inside the Aurral container, because that is where both connections to
 * Navidrome live. A playlist is created as its owner through their own
 * connection, so it belongs to them, and the rules are attached through the
 * admin one, which is the only connection allowed to write rules.
 *
 *   docker exec -i -e PLAN=/tmp/plan.json -e OWNER=dunshill aurral \
 *     node --input-type=module - < scripts/itunes-migrate/apply-smart-playlists.mjs
 *
 * Nothing is written without APPLY=true. Without it this prints what it would
 * do, which is the safer thing to read first.
 */

import fs from "node:fs/promises";

const planPath = process.env.PLAN || "/tmp/smart-playlists.json";
const apply = process.env.APPLY === "true";
const only = process.env.ONLY || "";

const { userOps } = await import("/app/backend/db/helpers/index.js");
const { createNavidromeUserClient } = await import("/app/backend/services/navidromeUserClient.js");
const { getAdminNavidromeClient } = await import("/app/backend/services/navidromeTrackResolver.js");
const { toNavidromeRules } = await import("/app/backend/services/navidromeSmartPlaylists.js");

const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
const ownerName = process.env.OWNER || plan.owner;
if (!ownerName) throw new Error("Set OWNER, or put an owner in the plan");

const owner = userOps.getUserByUsername(ownerName);
if (!owner) throw new Error(`No Aurral user called ${ownerName}`);

const userClient = createNavidromeUserClient(owner);
const admin = getAdminNavidromeClient();
if (!userClient) throw new Error("Navidrome is not configured for per-user access");
if (!admin?.isConfigured?.()) throw new Error("The Navidrome connection in Settings is needed to write rules");

// Existing playlists by name, so a second run changes rules rather than
// making a second playlist with the same name.
const existing = new Map();
for (const playlist of await userClient.getSubsonicPlaylists()) {
  if (String(playlist.owner || "").toLowerCase() !== ownerName.toLowerCase()) continue;
  existing.set(String(playlist.name || "").trim().toLowerCase(), playlist);
}

/**
 * What a set of rules would actually match, without touching the real
 * playlist. Navidrome only evaluates rules when a playlist is read, so the
 * only honest way to ask is to put them on a throwaway one and read it.
 *
 * This is the difference between a preview and a guess: rules that are
 * perfectly valid can still match nothing, because iTunes' genre names are not
 * the ones in the file tags, or match far too much, because Navidrome
 * evaluates over every library the owner can see and not just their own.
 */
async function countMatches(rules) {
  const probe = await userClient.createPlaylist(`zz-preview-${Date.now()}`, []);
  try {
    await admin.setPlaylistRules(probe.id, { name: "zz-preview", rules });
    const read = await userClient.getSubsonicPlaylist(probe.id);
    const entries = read?.entry || [];
    // Which library each match came from is the thing worth seeing, and the
    // Subsonic entry does not say, so the songs are looked up natively.
    const ids = entries.map((entry) => String(entry.id));
    const libraries = {};
    for (let index = 0; index < ids.length; index += 100) {
      for (const song of await admin.getSongsByIds(ids.slice(index, index + 100))) {
        const library = song.libraryName || song.libraryId || "?";
        libraries[library] = (libraries[library] || 0) + 1;
      }
    }
    return { total: entries.length, libraries };
  } finally {
    await userClient.deletePlaylist(probe.id).catch(() => {});
  }
}

const wanted = plan.playlists.filter((entry) => !only || entry.name === only);
console.log(`${wanted.length} playlist(s) to ${apply ? "apply" : "check"} for ${ownerName}`);
if (!apply) console.log("  (counting what each rule matches; this reads every playlist once)\n");

const summary = { created: 0, updated: 0, unchanged: 0, failed: 0 };

for (const entry of wanted) {
  const name = String(entry.name || "").trim();
  let rules;
  try {
    rules = toNavidromeRules(entry.rules);
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    summary.failed += 1;
    continue;
  }

  const found = existing.get(name.toLowerCase());
  const action = found ? "update" : "create";
  if (!apply) {
    let preview;
    try {
      preview = await countMatches(rules);
    } catch (error) {
      console.log(`  ✗ ${name}: could not be previewed: ${error.message}`);
      summary.failed += 1;
      continue;
    }
    const now = found ? Number(found.songCount ?? 0) : null;
    const change = now === null ? "new" : `${now} -> ${preview.total}`;
    // Nothing at all, or many times what it holds today, is the shape of a
    // rule that has quietly gone wrong rather than one that has simply moved on.
    const flag = preview.total === 0
      ? "  MATCHES NOTHING"
      : now && preview.total > now * 1.5
        ? "  much larger than it is now"
        : "";
    console.log(`  would ${action}: ${name.padEnd(34)} ${change.padStart(14)}  by library ${JSON.stringify(preview.libraries)}${flag}`);
    summary[action === "create" ? "created" : "updated"] += 1;
    continue;
  }

  try {
    let playlistId = found?.id;
    if (!playlistId) {
      const created = await userClient.createPlaylist(name, []);
      playlistId = created?.id;
      if (!playlistId) throw new Error("Navidrome did not return a playlist id");
    }
    await admin.setPlaylistRules(playlistId, { name, rules });
    // Reading it as the owner is what makes Navidrome evaluate the rules.
    const read = await userClient.getSubsonicPlaylist(playlistId);
    console.log(`  ✓ ${action}d ${name}: ${read?.songCount ?? "?"} track(s)`);
    summary[action === "create" ? "created" : "updated"] += 1;
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    summary.failed += 1;
  }
}

console.log(JSON.stringify(summary));
if (!apply) console.log("nothing was written; set APPLY=true to write");
