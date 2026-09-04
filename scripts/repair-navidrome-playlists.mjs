// Rewrites hand-made Navidrome playlists so every entry points at the main
// library's copy of the file, and each file appears once.
//
// Run inside the aurral container, which already holds the Navidrome
// credentials:
//
//   # dry run - reports what would change, writes nothing
//   docker exec -i aurral node --input-type=module \
//     < /home/avery/Docker_Apps/aurral/src/scripts/repair-navidrome-playlists.mjs
//
//   # apply - repairs one small playlist first and stops if it does not verify
//   docker exec -i -e APPLY=1 aurral node --input-type=module \
//     < /home/avery/Docker_Apps/aurral/src/scripts/repair-navidrome-playlists.mjs
//
// Playlists generated from a file (.m3u album playlists, .NSP smart playlists)
// are always skipped: Navidrome re-syncs those from their source.
//
// Override the canonical library with CANONICAL_LIBRARY_ID=<n>. It defaults to
// the lowest-numbered library that is not a personal one, which is the main
// collection on this server.

const APPLY = process.env.APPLY === "1";

const { NavidromeClient } = await import("/app/backend/services/navidrome.js");
const { dbOps } = await import("/app/backend/db/helpers/index.js");
const { repairPlaylist } = await import("/app/backend/services/navidromePlaylistRepair.js");
const { classifyLibraries } = await import("/app/backend/services/navidromePlaylistPortability.js");
const { getUserLibrariesSettings } = await import("/app/backend/services/userLibraryService.js");

const nd = dbOps.getSettings().integrations?.navidrome || {};
const client = new NavidromeClient(nd.url, nd.username, nd.password);
if (!client.isConfigured()) {
  console.error("Navidrome is not configured in aurral's settings.");
  process.exit(1);
}

const libraries = await client.getLibraries();
const { shared } = classifyLibraries(libraries, getUserLibrariesSettings().navidromeRootPath);
const canonicalLibraryId = Number(
  process.env.CANONICAL_LIBRARY_ID ||
    shared.map((library) => Number(library.id)).sort((a, b) => a - b)[0],
);
const canonical = libraries.find((library) => Number(library.id) === canonicalLibraryId);
if (!canonical) {
  console.error(`No library with id ${canonicalLibraryId}.`);
  process.exit(1);
}

console.log(`Canonical library: ${canonicalLibraryId} "${canonical.name}" (${canonical.path})`);
console.log(APPLY ? "Mode: APPLY\n" : "Mode: DRY RUN (set APPLY=1 to write)\n");

const playlists = await client.getPlaylists();
const plans = [];
for (const playlist of playlists) {
  const summary = await repairPlaylist({ client, playlist, canonicalLibraryId, dryRun: true });
  if (summary.skipped || !summary.changed) continue;
  plans.push({ playlist, summary });
}

if (!plans.length) {
  console.log("Nothing to repair.");
  process.exit(0);
}

const pad = (value, width) => String(value).padStart(width);
for (const { summary } of plans) {
  console.log(
    `  ${String(summary.name).slice(0, 38).padEnd(38)} ${pad(summary.before, 5)} -> ${pad(summary.after, 5)}` +
      `   remapped=${pad(summary.remapped, 4)} duplicates=${pad(summary.duplicatesRemoved, 4)} unmapped=${summary.unmapped}`,
  );
}
console.log(`\n${plans.length} playlist(s) would change.`);

if (!APPLY) {
  console.log("Dry run only. Re-run with -e APPLY=1 to write.");
  process.exit(0);
}

// Smallest first: if something is wrong, it goes wrong on the least valuable
// playlist and nothing else is touched.
plans.sort((a, b) => a.summary.before - b.summary.before);
const [trial, ...rest] = plans;

console.log(`\nTrial: "${trial.summary.name}" (${trial.summary.before} tracks)`);
const before = await client.getPlaylistTracks(trial.playlist.id);
const originalPaths = [...new Set(before.map((track) => track.path))];

const applied = await repairPlaylist({
  client,
  playlist: trial.playlist,
  canonicalLibraryId,
  dryRun: false,
});
const after = await client.getPlaylistTracks(trial.playlist.id);
const keptEveryFile = originalPaths.every((path) => after.some((track) => track.path === path));
const onlyCanonical = after.every((track) => Number(track.libraryId) === canonicalLibraryId);

console.log(`  ${applied.before} -> ${after.length} tracks`);
console.log(`  every distinct file still present: ${keptEveryFile}`);
console.log(`  all entries now in the canonical library: ${onlyCanonical}`);

if (!applied.applied || after.length !== applied.after || !keptEveryFile || !onlyCanonical) {
  console.error("\nTrial did NOT verify. Stopping; no other playlist was touched.");
  process.exit(1);
}

console.log("\nTrial verified. Repairing the rest:\n");
let repaired = 1;
for (const { playlist } of rest) {
  try {
    const result = await repairPlaylist({ client, playlist, canonicalLibraryId, dryRun: false });
    if (!result.applied) continue;
    repaired += 1;
    console.log(
      `  "${String(result.name).slice(0, 38)}" ${result.before} -> ${result.verifiedCount}` +
        ` (remapped ${result.remapped}, duplicates ${result.duplicatesRemoved})`,
    );
  } catch (error) {
    console.error(`  "${playlist.name}" FAILED: ${error.message} (original entries were restored)`);
  }
}
console.log(`\nDone. ${repaired} playlist(s) repaired.`);
