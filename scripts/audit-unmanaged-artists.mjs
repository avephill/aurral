// Finds artist folders that Lidarr does not manage, and Lidarr artists whose
// recorded folder is not on disk.
//
//   docker exec -i aurral node --input-type=module \
//     < /home/avery/Docker_Apps/aurral/src/scripts/audit-unmanaged-artists.mjs
//
// Writes the full lists to /app/downloads/artist-audit.txt, which is on the
// host at Docker_Apps/aurral/aurral/downloads/artist-audit.txt.
//
// Three buckets come out of it:
//
//   ORPHANED FOLDER - a folder on disk with no Lidarr artist at all. Lidarr
//     never imported it, usually for metadata reasons. It plays fine in
//     Navidrome from the main library, but it cannot be tagged, so it can
//     never appear in anyone's personal library.
//
//   PATH MISMATCH - Lidarr knows the artist but points at a folder that does
//     not exist, while a near-identical folder does. These are the ones that
//     log "Skipping symlink for missing artist folder" and that make Lidarr
//     fire TrackFileDeletedEvent on a rescan. Fixing the path in Lidarr fixes
//     both.
//
//   MISSING - Lidarr's folder is absent and nothing on disk resembles it.

import fs from "node:fs/promises";
import path from "node:path";

const LIBRARY_ROOT = process.env.LIBRARY_ROOT || "/data/Music/Library";
const REPORT_PATH = process.env.REPORT_PATH || "/app/downloads/artist-audit.txt";

const { db } = await import("/app/backend/config/db-sqlite.js");

const normalize = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const entries = await fs.readdir(LIBRARY_ROOT, { withFileTypes: true });
const folders = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((e) => e.name);

const artists = db
  .prepare("SELECT name, json_extract(metadata_json, '$.path') AS path FROM library_artists")
  .all();

const folderSet = new Set(folders);
const byFolderName = new Map();
const byNormalized = new Map();
for (const folder of folders) {
  byFolderName.set(folder, folder);
  const key = normalize(folder);
  // A name with no ASCII letters or digits normalises to "", and every such
  // name would otherwise collide with every other: "近藤等則" matching "!!!".
  if (!key) continue;
  if (!byNormalized.has(key)) byNormalized.set(key, []);
  byNormalized.get(key).push(folder);
}

const claimedFolders = new Set();
const pathMismatch = [];
const missing = [];

for (const artist of artists) {
  const folder = artist.path ? path.basename(artist.path) : null;
  if (folder && folderSet.has(folder)) {
    claimedFolders.add(folder);
    continue;
  }
  // Lidarr's folder is not there. Something spelled almost the same usually is:
  // "AC+DC" vs "AC_DC", "R.E.M" vs "R.E.M_", a trailing dot dropped.
  const keys = [normalize(folder || ""), normalize(artist.name)].filter(Boolean);
  const candidates = keys
    .flatMap((key) => byNormalized.get(key) || [])
    .filter((candidate) => !claimedFolders.has(candidate));
  if (candidates.length) {
    claimedFolders.add(candidates[0]);
    pathMismatch.push({ artist: artist.name, lidarrPath: artist.path, onDisk: candidates[0] });
  } else {
    missing.push({ artist: artist.name, lidarrPath: artist.path });
  }
}

const orphaned = folders.filter((folder) => !claimedFolders.has(folder)).sort();

// How much music is actually stranded, so the number means something.
const AUDIO = new Set([".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".wma", ".aac", ".alac", ".aiff"]);
const countAudio = async (dir) => {
  let total = 0;
  const walk = async (current, depth) => {
    if (depth > 4) return;
    let list;
    try {
      list = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (AUDIO.has(path.extname(entry.name).toLowerCase())) total += 1;
    }
  };
  await walk(dir, 0);
  return total;
};

let orphanedTracks = 0;
const orphanedDetail = [];
for (const folder of orphaned) {
  const tracks = await countAudio(path.join(LIBRARY_ROOT, folder));
  orphanedTracks += tracks;
  orphanedDetail.push({ folder, tracks });
}
orphanedDetail.sort((a, b) => b.tracks - a.tracks);

const lines = [];
const say = (text) => {
  lines.push(text);
  console.log(text);
};

say(`Library root: ${LIBRARY_ROOT}`);
say(`Folders on disk: ${folders.length}   Lidarr artists: ${artists.length}\n`);
say(`ORPHANED FOLDERS (not in Lidarr at all): ${orphaned.length} folders, ${orphanedTracks} audio files`);
say(`PATH MISMATCHES (in Lidarr, folder named differently): ${pathMismatch.length}`);
say(`MISSING (in Lidarr, nothing resembling it on disk): ${missing.length}\n`);

say("--- PATH MISMATCHES (fix the path in Lidarr, or rename the folder) ---");
for (const row of pathMismatch) say(`  "${row.artist}"\n      lidarr: ${row.lidarrPath}\n      disk:   ${LIBRARY_ROOT}/${row.onDisk}`);

say("\n--- ORPHANED FOLDERS, largest first ---");
for (const row of orphanedDetail) say(`  ${String(row.tracks).padStart(5)} files  ${row.folder}`);

if (missing.length) {
  say("\n--- MISSING ---");
  for (const row of missing) say(`  "${row.artist}" -> ${row.lidarrPath}`);
}

try {
  await fs.writeFile(REPORT_PATH, `${lines.join("\n")}\n`, "utf8");
  console.log(`\nFull report written to ${REPORT_PATH}`);
} catch (error) {
  console.log(`\nCould not write ${REPORT_PATH}: ${error.message}`);
}
