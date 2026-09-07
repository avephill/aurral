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

// Keeps every script's letters, so 坂本龍一 stays distinct from anything else;
// a name that strips to nothing ("!!!") matches nothing rather than everything.
const normalize = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/^the\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "") || `raw:${String(value || "").trim()}`;

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
    // Only entries nobody has decided on get (re)looked up; a hand-set match,
    // use-existing, va or skip must survive a rerun.
    const previous = state.artists[folder];
    if (previous && !["ambiguous", "nomatch"].includes(previous.status)) {
      counts[previous.status] = (counts[previous.status] || 0) + 1;
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

// Which positions of each album already hold a file. Keyed by album, disc and
// track number rather than track id: Lidarr may match the staged files to a
// different release of the album than the one it monitors, and track ids are
// per release, so ids from the two sides never meet. The manualimport response's
// own hasFile flag is stale in both directions and is not consulted.
const slot = (albumId, t) => `${albumId}:${t.mediumNumber || 1}:${String(t.trackNumber ?? t.absoluteTrackNumber ?? "").replace(/^0+/, "")}`;

async function tracksWithFiles(items) {
  const filed = new Set();
  for (const albumId of new Set(items.map((item) => item.album?.id).filter(Boolean))) {
    for (const track of (await lidarrClient.request(`/track?albumId=${albumId}`)) || []) {
      if (track.hasFile) filed.add(slot(albumId, track));
    }
  }
  return filed;
}

function classify(items, files, filed = new Set()) {
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
    // This fills gaps; it never upgrades. Lidarr's quality ladder ranks a
    // 128 kbps AAC above a 190 kbps MP3, so a track that already has a file
    // is left alone whatever Lidarr thinks of the new one.
    const alreadyFiled = (item.tracks || []).length > 0 && (item.tracks || []).every((t) => filed.has(slot(item.album?.id, t)));
    if (alreadyFiled || rejections.some((r) => ALREADY_HAVE.test(r))) {
      alreadyHave += 1;
      continue;
    }
    if (!item.album?.id) reasons.add("no album match");
    else albumIds.add(item.album.id);
    if (!item.artist?.id) reasons.add("no artist match");
    if (!item.tracks?.length) reasons.add("no track match");
    // A file Lidarr maps to several tracks claims all of them on import; one file, one track.
    if ((item.tracks || []).length > 1) reasons.add("one file maps to several tracks");
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
    const result = classify(Array.isArray(items) ? items : [], folder.files, await tracksWithFiles(Array.isArray(items) ? items : []));
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
  const only = process.env.ONLY || "";
  const queue = [...folders.values()].filter((folder) => !state.imported[folder.key] && (!only || folder.key.includes(only)));
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

// ---------------------------------------------------------------- albums

// Lidarr can only match a folder to an album it already tracks, and it tracks
// nothing under Various Artists, nor EPs and singles outside the metadata
// profile, until something adds the release. This is what the Manual Import UI
// does when you search for the album by hand: look the release group up, add
// it unmonitored under its artist, then match the folder against it.
const NEEDS_ALBUM = /no album match|Couldn't find similar album|Album match is not close enough/i;

function pickAlbum(candidates, folder, wantArtistMbid) {
  const title = normalize(folder.albumFolder.replace(/_/g, " "));
  const nFiles = folder.files.filter((f) => AUDIO.test(f)).length;
  const scored = [];
  for (const c of candidates) {
    const cTitle = normalize(c.title);
    const titleScore = cTitle === title ? 2 : cTitle.startsWith(title) || title.startsWith(cTitle) ? 1 : 0;
    if (!titleScore) continue;
    const artistScore = wantArtistMbid ? (c.artist?.foreignArtistId === wantArtistMbid ? 2 : 0) : c.artist?.foreignArtistId === VA_MBID ? 2 : 1;
    if (wantArtistMbid && !artistScore) continue;
    const tracks = c.statistics?.trackCount ?? c.releases?.[0]?.trackCount ?? 0;
    const sizeScore = tracks >= nFiles ? 1 : tracks >= nFiles / 2 ? 0 : -2;
    scored.push({ score: titleScore + artistScore + sizeScore, tracks, c });
  }
  scored.sort((a, b) => b.score - a.score || Math.abs(a.tracks - nFiles) - Math.abs(b.tracks - nFiles));
  return scored[0]?.score >= 2 ? scored[0].c : null;
}

async function albums(folders, state) {
  const { byMbid, byName, artists } = await lidarrArtists();
  const byId = new Map(artists.map((a) => [a.id, a]));
  const va = byMbid.get(VA_MBID);
  const todo = [...folders.values()].filter((f) => {
    const e = state.evaluation[f.key];
    return e && e.status === "review" && e.reasons.some((r) => NEEDS_ALBUM.test(r));
  });
  console.log(`looking up albums for ${todo.length} folders`);
  const counts = { clean: 0, review: 0, "have-all": 0, "no-candidate": 0, "needs-artist": 0, error: 0 };
  let n = 0;
  for (const folder of todo) {
    n += 1;
    const e = state.evaluation[folder.key];
    const known = state.artists[folder.artistFolder];
    const folderArtist = e.artistId ? byId.get(e.artistId) : null;
    const wantArtistMbid = folder.kind === "compilation" || known?.status === "va" ? null : folderArtist?.foreignArtistId || known?.mbid || null;
    const term = folder.kind === "compilation" || known?.status === "va" ? folder.albumFolder : `${folderArtist?.artistName || folder.artistFolder} ${folder.albumFolder}`;
    try {
      // Lidarr's metadata server answers some searches with 503, and a burst
      // of those trips aurral's circuit breaker; go gently and wait it out.
      const found = await withRetries(() => lidarrClient.request(`/album/lookup?term=${encodeURIComponent(term.replace(/_/g, " "))}`));
      const pick = pickAlbum(Array.isArray(found) ? found : [], folder, wantArtistMbid);
      if (!pick) {
        e.albumLookup = { term, status: "no-candidate", top: (found || []).slice(0, 3).map((c) => `${c.title} — ${c.artist?.artistName}`) };
        counts["no-candidate"] += 1;
        continue;
      }
      let albumId = pick.id || null;
      let artistId = pick.artist?.id || byMbid.get(pick.artist?.foreignArtistId)?.id || null;
      if (!albumId) {
        if (!artistId) {
          e.albumLookup = { term, status: "needs-artist", album: pick.title, artist: pick.artist?.artistName, artistMbid: pick.artist?.foreignArtistId };
          counts["needs-artist"] += 1;
          continue;
        }
        const added = await lidarrClient.addAlbum(artistId, pick.foreignAlbumId, pick.title, { monitored: false });
        albumId = added?.id || null;
      }
      if (!albumId) throw new Error("album add returned no id");
      e.albumLookup = { term, status: "added", album: pick.title, artist: pick.artist?.artistName, albumId, artistId };
      const lidarrPath = `${IMPORT_ROOT}/${folder.artistFolder}/${folder.albumFolder}`;
      const query = new URLSearchParams({ folder: lidarrPath, filterExistingFiles: "true", artistId: String(artistId), albumId: String(albumId) });
      const items = await lidarrClient.request(`/manualimport?${query.toString()}`);
      const result = classify(Array.isArray(items) ? items : [], folder.files, await tracksWithFiles(Array.isArray(items) ? items : []));
      Object.assign(e, {
        status: result.status,
        reasons: result.reasons,
        artistId,
        albumId,
        album: pick.title,
        alreadyHave: result.alreadyHave || 0,
        files: result.importable.map((item) => ({
          path: item.path,
          artistId: item.artist?.id || artistId,
          albumId: item.album?.id || albumId,
          albumReleaseId: item.albumReleaseId,
          trackIds: (item.tracks || []).map((t) => t.id),
          quality: item.quality,
          rejections: (item.rejections || []).map((r) => r.reason || String(r)),
        })),
      });
      counts[result.status] = (counts[result.status] || 0) + 1;
    } catch (error) {
      e.albumLookup = { term, status: "error", error: String(error.message).split("\n")[0].slice(0, 160) };
      counts.error += 1;
    }
    if (n % 10 === 0) {
      console.log(`  albums ${n}/${todo.length}: ${JSON.stringify(counts)}`);
      await saveState(state);
    }
    await sleep(1500);
  }
  await saveState(state);
  console.log(`albums stage: ${JSON.stringify(counts)}`);
  const clean = Object.values(state.evaluation).filter((x) => x.status === "clean");
  console.log(`clean folders now: ${clean.length} (${clean.reduce((s, x) => s + x.files.length, 0)} files)`);
  for (const [key, x] of Object.entries(state.evaluation)) {
    if (x.albumLookup?.status === "needs-artist") console.log(`  needs artist: ${key} -> ${x.albumLookup.album} by ${x.albumLookup.artist}`);
  }
}

// ---------------------------------------------------------------- trim

// A folder lands in review when Lidarr cannot match *dad's files* to a release;
// that says nothing about whether Lidarr already holds the album from another
// source. This splits the review list by what Lidarr actually has, so folders
// whose album is already complete drop out of the to-do.
async function trim(folders, state) {
  const { byMbid, byName, artists } = await lidarrArtists();
  const byId = new Map(artists.map((a) => [a.id, a]));
  const va = byMbid.get(VA_MBID);
  const albumCache = new Map();
  const albumsOf = async (artistId) => {
    if (!albumCache.has(artistId)) albumCache.set(artistId, (await lidarrClient.request(`/album?artistId=${artistId}`)) || []);
    return albumCache.get(artistId);
  };
  const groups = { complete: [], partial: [], absent: [] };
  for (const folder of folders.values()) {
    const e = state.evaluation[folder.key];
    if (!e || !["review", "error"].includes(e.status)) continue;
    const known = state.artists[folder.artistFolder];
    let artistId = e.artistId ?? null;
    if (!artistId) {
      if (folder.kind === "compilation" || known?.status === "va") artistId = va?.id ?? null;
      else if (known?.useExisting) artistId = byName.get(normalize(known.useExisting))?.id ?? null;
      else artistId = known?.lidarrId ?? byMbid.get(known?.mbid)?.id ?? byName.get(normalize(folder.artistFolder))?.id ?? null;
    }
    let album = null;
    if (artistId) {
      const albums = await albumsOf(artistId);
      // The name comes first: a folder is in review because Lidarr's guess at
      // its release was poor, so that guess (e.albumId) is only a last resort.
      const albumId = e.albumId ?? e.files?.[0]?.albumId;
      const wanted = normalize(folder.albumFolder.replace(/_/g, " "));
      album =
        albums.find((a) => normalize(a.title) === wanted) ||
        albums.find((a) => normalize(a.title).startsWith(wanted) || wanted.startsWith(normalize(a.title))) ||
        albums.find((a) => a.id === albumId);
    }
    const staged = folder.files.filter((f) => AUDIO.test(f)).length;
    const line = `${folder.key}  (${staged} staged files)`;
    if (!album) {
      groups.absent.push(`${line}  ->  ${e.reasons.join("; ")}`);
      continue;
    }
    const have = album.statistics?.trackFileCount ?? 0;
    const total = album.statistics?.totalTrackCount ?? album.statistics?.trackCount ?? 0;
    const tag = `Lidarr has ${have}/${total} of '${album.title}'${album.monitored ? "" : " (unmonitored)"} under ${byId.get(artistId)?.artistName}`;
    if (total && have >= total) groups.complete.push(`${line}  ->  ${tag}`);
    else if (have > 0) groups.partial.push(`${line}  ->  ${tag}  |  ${e.reasons.join("; ")}`);
    else groups.absent.push(`${line}  ->  ${tag}  |  ${e.reasons.join("; ")}`);
  }
  const out = [
    `# NEEDS IMPORT — album absent or empty in Lidarr (${groups.absent.length})`,
    ...groups.absent.sort(),
    "",
    `# PARTIAL — Lidarr has some tracks; dad's folder may fill the rest (${groups.partial.length})`,
    ...groups.partial.sort(),
    "",
    `# ALREADY COMPLETE IN LIDARR — nothing to import (${groups.complete.length})`,
    ...groups.complete.sort(),
    "",
  ].join("\n");
  await fs.writeFile(`${LISTS_DIR}/review-trimmed.txt`, out);
  console.log(`review folders: needs import ${groups.absent.length}, partial ${groups.partial.length}, already complete ${groups.complete.length} -> ${LISTS_DIR}/review-trimmed.txt`);
}

// ---------------------------------------------------------------- import

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetries(fn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = String(error.message || "");
      if (attempt < 3 && /circuit open/i.test(message)) {
        await sleep(60000);
        continue;
      }
      if (attempt < 2 && /503/.test(message)) {
        await sleep(5000);
        continue;
      }
      throw error;
    }
  }
}

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
      disableReleaseSwitching: true,
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
const stages = { resolve, add, evaluate, albums, trim, import: doImport };
if (!stages[STAGE]) {
  console.error(`unknown STAGE ${STAGE}; use ${Object.keys(stages).join("|")}`);
  process.exit(2);
}
await stages[STAGE](folders, state);
