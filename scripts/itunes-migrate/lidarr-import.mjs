// Import the album folders named in artists.list / compilations.list (from
// stage_missing.py) into Lidarr through its Manual Import API, in stages that
// each stop for review:
//
//   resolve   map each artist folder to a Lidarr artist or a MusicBrainz id; writes state.json
//   add       add the unambiguously resolved artists (tagged for USERNAME, nothing monitored, no search)
//   evaluate  ask Lidarr to match every album folder; classify clean vs needs-review
//   import    copy the clean folders into the library; leaves the originals in place
//
// Runs inside the aurral container so Lidarr's credentials never leave it:
//
//   docker exec -i -e STAGE=resolve aurral node --input-type=module - < scripts/itunes-migrate/lidarr-import.mjs
//
// Env: STAGE, IMPORT_ROOT (Lidarr-side path of the staged Music folder),
// LISTS_DIR (holds the .list files and state.json), USERNAME (tag owner).
// To accept an ambiguous artist, set its "mbid" and status "match" in state.json.

import fs from "node:fs/promises";

const { lidarrClient } = await import("/app/backend/services/lidarrClient.js");

const STAGE = process.env.STAGE || "resolve";
const IMPORT_ROOT = (process.env.IMPORT_ROOT || "/data/Music/Import-itunes/Music").replace(/\/$/, "");
const LISTS_DIR = process.env.LISTS_DIR || "/tmp/itunes-import";
const USERNAME = process.env.USERNAME || "dunshill";
const VA_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";
const STATE_PATH = `${LISTS_DIR}/state.json`;
const AUDIO = /\.(m4a|mp3|flac|ogg|opus|wav|aiff?|wma|aac)$/i;

const normalize = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, "");

async function readLists() {
  const folders = new Map();
  for (const [file, kind] of [["artists.list", "artist"], ["compilations.list", "compilation"]]) {
    let text = "";
    try {
      text = await fs.readFile(`${LISTS_DIR}/${file}`, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const parts = line.trim().split("/");
      if (parts.length < 3) continue;
      const [artistFolder, albumFolder] = parts;
      const key = `${artistFolder}/${albumFolder}`;
      if (!folders.has(key)) folders.set(key, { key, kind, artistFolder, albumFolder, files: [] });
      folders.get(key).files.push(parts.slice(2).join("/"));
    }
  }
  return folders;
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
  } catch {
    return { artists: {}, evaluation: {}, imported: {} };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 1));
}

async function lidarrArtists() {
  const artists = await lidarrClient.listArtists();
  const byName = new Map();
  const byMbid = new Map();
  for (const artist of artists) {
    byName.set(normalize(artist.artistName), artist);
    byMbid.set(artist.foreignArtistId, artist);
  }
  return { artists, byName, byMbid };
}

// ---------------------------------------------------------------- resolve

async function resolve(folders, state) {
  const { byName } = await lidarrArtists();
  const artistFolders = [...new Set([...folders.values()].filter((f) => f.kind === "artist").map((f) => f.artistFolder))].sort();
  const counts = { exists: 0, match: 0, ambiguous: 0, nomatch: 0 };
  for (const folder of artistFolders) {
    const previous = state.artists[folder];
    if (previous && (previous.status === "exists" || previous.status === "added")) {
      counts.exists += 1;
      continue;
    }
    const existing = byName.get(normalize(folder));
    if (existing) {
      state.artists[folder] = { status: "exists", lidarrId: existing.id, mbid: existing.foreignArtistId, name: existing.artistName };
      counts.exists += 1;
      continue;
    }
    let candidates = [];
    try {
      const found = await lidarrClient.request(`/artist/lookup?term=${encodeURIComponent(folder)}`);
      candidates = (Array.isArray(found) ? found : []).slice(0, 5).map((a) => ({
        mbid: a.foreignArtistId,
        name: a.artistName,
        disambiguation: a.disambiguation || "",
        type: a.artistType || "",
        exact: normalize(a.artistName) === normalize(folder),
      }));
    } catch (error) {
      candidates = [{ error: error.message }];
    }
    const exact = candidates.filter((c) => c.exact);
    if (exact.length === 1) {
      state.artists[folder] = { status: "match", mbid: exact[0].mbid, name: exact[0].name, candidates };
      counts.match += 1;
    } else if (exact.length > 1) {
      state.artists[folder] = { status: "ambiguous", candidates };
      counts.ambiguous += 1;
    } else {
      state.artists[folder] = { status: "nomatch", candidates };
      counts.nomatch += 1;
    }
  }
  await saveState(state);
  console.log(`artists: ${JSON.stringify(counts)}`);
  for (const status of ["ambiguous", "nomatch"]) {
    const rows = Object.entries(state.artists).filter(([, a]) => a.status === status);
    if (!rows.length) continue;
    console.log(`\n${status} (${rows.length}):`);
    for (const [folder, a] of rows) {
      const options = (a.candidates || [])
        .map((c) => (c.error ? `error: ${c.error}` : `${c.name}${c.disambiguation ? ` (${c.disambiguation})` : ""} [${(c.mbid || "").slice(0, 8)}]`))
        .join(" | ");
      console.log(`  ${folder}  ->  ${options || "no candidates"}`);
    }
  }
}

// ---------------------------------------------------------------- add

async function add(folders, state) {
  const { byMbid } = await lidarrArtists();
  const todo = Object.entries(state.artists).filter(([, a]) => a.status === "match" && a.mbid);
  console.log(`adding ${todo.length} artists as ${USERNAME}, monitoring nothing, searching nothing`);
  let done = 0;
  const addedThisRun = new Map(); // two folders can resolve to one artist ("Riuichi Sakamoto", "Ryuichi Sakamoto & …")
  for (const [folder, a] of todo) {
    if (byMbid.has(a.mbid)) {
      state.artists[folder] = { ...a, status: "exists", lidarrId: byMbid.get(a.mbid).id };
      continue;
    }
    if (addedThisRun.has(a.mbid)) {
      state.artists[folder] = { ...a, status: "added", lidarrId: addedThisRun.get(a.mbid) };
      continue;
    }
    try {
      const created = await lidarrClient.addArtist(a.mbid, a.name || folder, {
        monitorOption: "none",
        albumOnly: true,
        triggerSearch: false,
        requestedByUsername: USERNAME,
      });
      addedThisRun.set(a.mbid, created?.id ?? null);
      state.artists[folder] = { ...a, status: "added", lidarrId: created?.id ?? null };
      done += 1;
      if (done % 10 === 0) {
        console.log(`  added ${done}/${todo.length}`);
        await saveState(state);
      }
    } catch (error) {
      state.artists[folder] = { ...a, status: "add-failed", error: String(error.message).split("\n")[0].slice(0, 200) };
      console.log(`  failed ${folder}: ${state.artists[folder].error}`);
    }
  }
  await saveState(state);
  console.log(`added ${done}; failed ${Object.values(state.artists).filter((a) => a.status === "add-failed").length}`);
}

// ---------------------------------------------------------------- evaluate

// Lidarr's rejections are written for automatic imports of whole releases.
// Here most folders deliberately complete an album Lidarr already has, so a
// partial import is the point, and a file Lidarr already holds is simply left out.
const ACCEPTABLE = /^has missing tracks$/i;
const ALREADY_HAVE = /^not an upgrade for existing/i;

function classify(items, files) {
  const audio = items.filter((item) => AUDIO.test(item.path || ""));
  const reasons = new Set();
  if (!audio.length) return { status: "absent", reasons: ["lidarr listed no audio files"], audio: [], importable: [] };
  const albumIds = new Set();
  const trackIds = new Set();
  const importable = [];
  let duplicateTrack = false;
  let alreadyHave = 0;
  for (const item of audio) {
    const rejections = (item.rejections || []).map((r) => r.reason || String(r));
    if (rejections.some((r) => ALREADY_HAVE.test(r))) {
      alreadyHave += 1;
      continue;
    }
    if (!item.album?.id) reasons.add("no album match");
    else albumIds.add(item.album.id);
    if (!item.artist?.id) reasons.add("no artist match");
    if (!item.tracks?.length) reasons.add("no track match");
    for (const track of item.tracks || []) {
      if (trackIds.has(track.id)) duplicateTrack = true;
      trackIds.add(track.id);
    }
    for (const r of rejections) if (!ACCEPTABLE.test(r)) reasons.add(r);
    importable.push(item);
  }
  if (albumIds.size > 1) reasons.add("files matched more than one album");
  if (duplicateTrack) reasons.add("two files matched the same track");
  if (audio.length < files.filter((f) => AUDIO.test(f)).length) reasons.add("lidarr listed fewer audio files than staged");
  if (!importable.length) return { status: "have-all", reasons: [`lidarr already has all ${alreadyHave} files`], audio, importable };
  return { status: reasons.size ? "review" : "clean", reasons: [...reasons], audio, importable, alreadyHave };
}

const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

async function evaluateFolder(folder, state, { va, byMbid, byName }) {
  // Hand-set statuses in state.json: "va" files the folder under Various
  // Artists (Putumayo, soundtracks), "skip" leaves it for the UI, and
  // "useExisting" names a Lidarr artist to import under (typos, joint credits).
  const known = state.artists[folder.artistFolder];
  if (known?.status === "skip") return "skipped";
  let artistId = null;
  if (folder.kind === "compilation" || known?.status === "va") {
    artistId = va?.id ?? null;
  } else if (known?.useExisting) {
    artistId = byName.get(normalize(known.useExisting))?.id ?? null;
  } else {
    artistId = known?.lidarrId ?? byMbid.get(known?.mbid)?.id ?? byName.get(normalize(folder.artistFolder))?.id ?? null;
  }
  const lidarrPath = `${IMPORT_ROOT}/${folder.artistFolder}/${folder.albumFolder}`;
  const query = new URLSearchParams({ folder: lidarrPath, filterExistingFiles: "true" });
  if (artistId) query.set("artistId", String(artistId));
  try {
    const items = await lidarrClient.request(`/manualimport?${query.toString()}`);
    const result = classify(Array.isArray(items) ? items : [], folder.files);
    state.evaluation[folder.key] = {
      kind: folder.kind,
      status: result.status,
      reasons: result.reasons,
      artistId,
      album: result.audio[0]?.album?.title || null,
      alreadyHave: result.alreadyHave || 0,
      files: result.importable.map((item) => ({
        path: item.path,
        artistId: item.artist?.id,
        albumId: item.album?.id,
        albumReleaseId: item.albumReleaseId,
        trackIds: (item.tracks || []).map((t) => t.id),
        quality: item.quality,
        rejections: (item.rejections || []).map((r) => r.reason || String(r)),
      })),
    };
    return result.status;
  } catch (error) {
    state.evaluation[folder.key] = { kind: folder.kind, status: "error", reasons: [String(error.message).split("\n")[0].slice(0, 160)], artistId };
    return "error";
  }
}

async function evaluate(folders, state) {
  const { byMbid, byName } = await lidarrArtists();
  const context = { va: byMbid.get(VA_MBID), byMbid, byName };
  const counts = { clean: 0, review: 0, "have-all": 0, absent: 0, skipped: 0, error: 0 };
  const queue = [...folders.values()].filter((folder) => !state.imported[folder.key]);
  let n = 0;
  const worker = async () => {
    while (queue.length) {
      const folder = queue.shift();
      const status = await evaluateFolder(folder, state, context);
      counts[status] = (counts[status] || 0) + 1;
      n += 1;
      if (n % 25 === 0) {
        console.log(`  evaluated ${n}/${folders.size}: ${JSON.stringify(counts)}`);
        await saveState(state);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await saveState(state);
  console.log(`evaluated ${folders.size} folders: ${JSON.stringify(counts)}`);
  const reasonCounts = {};
  const report = [];
  for (const [key, e] of Object.entries(state.evaluation)) {
    if (!["review", "error"].includes(e.status)) continue;
    for (const r of e.reasons) reasonCounts[r.replace(/\[.*$/, "").trim()] = (reasonCounts[r.replace(/\[.*$/, "").trim()] || 0) + 1;
    report.push(`${e.status.padEnd(7)} ${key}  ->  ${e.reasons.join("; ")}`);
  }
  console.log("review reasons:", JSON.stringify(reasonCounts, null, 1));
  await fs.writeFile(`${LISTS_DIR}/evaluate.txt`, report.sort().join("\n") + "\n");
  const clean = Object.values(state.evaluation).filter((e) => e.status === "clean");
  console.log(`clean folders: ${clean.length} (${clean.reduce((s, e) => s + e.files.length, 0)} files to import, ${clean.reduce((s, e) => s + (e.alreadyHave || 0), 0)} already held); review list in ${LISTS_DIR}/evaluate.txt`);
}

// ---------------------------------------------------------------- import

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCommand(id) {
  for (let i = 0; i < 600; i += 1) {
    const command = await lidarrClient.request(`/command/${id}`);
    if (["completed", "failed", "aborted", "cancelled"].includes(command?.status)) return command;
    await sleep(2000);
  }
  return { status: "timeout" };
}

async function doImport(folders, state) {
  const clean = Object.entries(state.evaluation).filter(([key, e]) => e.status === "clean" && !state.imported[key]);
  console.log(`importing ${clean.length} clean folders (copy mode; originals untouched)`);
  const counts = { completed: 0, failed: 0 };
  for (const [key, e] of clean) {
    const files = e.files.map((f) => ({
      path: f.path,
      artistId: f.artistId,
      albumId: f.albumId,
      albumReleaseId: f.albumReleaseId,
      trackIds: f.trackIds,
      quality: f.quality,
      disableReleaseSwitching: false,
    }));
    try {
      const command = await lidarrClient.request("/command", "POST", {
        name: "ManualImport",
        importMode: "copy",
        replaceExistingFiles: false,
        files,
      });
      const finished = await waitForCommand(command.id);
      if (finished.status === "completed") {
        state.imported[key] = { at: new Date().toISOString(), files: files.length, album: e.album };
        counts.completed += 1;
      } else {
        state.evaluation[key].status = "import-failed";
        state.evaluation[key].reasons = [finished.status, finished.message || ""].filter(Boolean);
        counts.failed += 1;
        console.log(`  failed ${key}: ${finished.status} ${finished.message || ""}`);
      }
    } catch (error) {
      state.evaluation[key].status = "import-failed";
      state.evaluation[key].reasons = [String(error.message).split("\n")[0].slice(0, 160)];
      counts.failed += 1;
      console.log(`  failed ${key}: ${state.evaluation[key].reasons[0]}`);
    }
    if ((counts.completed + counts.failed) % 20 === 0) {
      console.log(`  ${counts.completed + counts.failed}/${clean.length}`);
      await saveState(state);
    }
  }
  await saveState(state);
  console.log(`imported ${counts.completed} folders, ${counts.failed} failed`);
}

// ---------------------------------------------------------------- main

const folders = await readLists();
const state = await loadState();
console.log(`${folders.size} album folders in the lists (${[...folders.values()].filter((f) => f.kind === "compilation").length} compilations); stage: ${STAGE}`);
const stages = { resolve, add, evaluate, import: doImport };
if (!stages[STAGE]) {
  console.error(`unknown STAGE ${STAGE}; use ${Object.keys(stages).join("|")}`);
  process.exit(2);
}
await stages[STAGE](folders, state);
