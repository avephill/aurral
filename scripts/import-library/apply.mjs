// Carries out an import plan made by plan.mjs. A dry run unless APPLY=1.
//
//   docker exec -i -e LABEL=bspang -e TAG=bspang [-e APPLY=1] [-e LIMIT=5] \
//     [-e BUCKETS=ready] aurral node --input-type=module < scripts/import-library/apply.mjs
//
// For each album in the chosen buckets (ready by default):
//
//   1. Its artist is added to Lidarr if Lidarr lacks them - album-only, with
//      no search - and the album is set unmonitored as soon as Lidarr lists
//      it, so Lidarr never goes looking to download it or to upgrade it.
//   2. Its files go through Lidarr's own Manual Import against that artist,
//      moved into the library. Only files Lidarr matched to this album with
//      no rejection are imported; anything else is left where it is and
//      reported.
//   3. The artist is tagged TAG, which puts them in that person's Psalter
//      library.
//
// Albums the plan found already on the server are not imported, but still go
// into the person's library: their Lidarr artist is tagged, or, for music
// only Navidrome has, the album itself is linked in.
//
// Writes results.json and results.txt beside the plan.

import fs from "node:fs/promises";
import path from "node:path";

const LABEL = process.env.LABEL || "import";
const TAG = (process.env.TAG || LABEL).toLowerCase();
const OUT_DIR = process.env.OUT_DIR || `/app/downloads/library-import/${LABEL}`;
const APPLY = process.env.APPLY === "1";
const BUCKETS = (process.env.BUCKETS || "ready").split(",").map((entry) => entry.trim()).filter(Boolean);
const LIMIT = Number(process.env.LIMIT || 0);
// Particular albums, one folder per line relative to the source - for a
// trial of chosen cases rather than whatever sorts first.
const FOLDERS = (process.env.FOLDERS || "").split("\n").map((entry) => entry.trim()).filter(Boolean);
// Lidarr refuses part of an album ("Has missing tracks"). With this set, a
// song is imported anyway when that is its only refusal - for a library of
// songs bought one at a time.
const IMPORT_PARTIAL = process.env.IMPORT_PARTIAL === "1";
const PARTIAL = /^Has missing tracks/i;
// Lidarr refuses a match it scores under 80%, usually because the tags credit
// a featured artist or say "(From Barbie The Album)". With this set, that is
// overridden - only for a file Lidarr itself matched to a track on the very
// album the plan identified. A file matched to some other album is still
// refused.
const ACCEPT_LOW_CONFIDENCE = process.env.ACCEPT_LOW_CONFIDENCE === "1";
const LOW_CONFIDENCE = /^(Album match is not close enough|Worst track match)/i;
const ALBUM_WAIT_MS = 3 * 60_000;
const COMMAND_WAIT_MS = 10 * 60_000;

const { lidarrClient } = await import("/app/backend/services/lidarrClient.js");
const { getAdminNavidromeClient } = await import("/app/backend/services/navidromeTrackResolver.js");
const { userOps } = await import("/app/backend/db/helpers/index.js");
const { addUserLibraryAlbums, albumFolderOf, reconcileUserLibrariesAndWait } = await import(
  "/app/backend/services/userLibraryService.js"
);

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lidarr = (endpoint, method = "GET", body = null) => lidarrClient.request(endpoint, method, body);

const normalize = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the /, "")
    .trim();
const EDITION = /[([][^)\]]*(deluxe|remaster|edition|expanded|anniversary|bonus|version|mono|stereo|reissue|special)[^)\]]*[)\]]/gi;
const stripEdition = (value) => normalize(String(value || "").replace(EDITION, " "));

// ---------------------------------------------------------------- Lidarr

async function albumsOf(artistId) {
  const albums = await lidarr(`/album?artistId=${artistId}`);
  return Array.isArray(albums) ? albums : [];
}

// The album in Lidarr, adding it on its own when the artist's metadata
// profile leaves it out (most profiles here list studio albums only, so EPs,
// singles and soundtracks never appear by themselves). Added unmonitored.
// A new artist's albums arrive from Lidarr's refresh a little after the add,
// so it is looked for a while before being added by hand.
async function findOrAddAlbum(artistId, match, { justAdded }) {
  const until = Date.now() + (justAdded ? 30_000 : 0);
  for (;;) {
    const album = (await albumsOf(artistId)).find((entry) => entry.foreignAlbumId === match.releaseGroupId);
    if (album) return album;
    if (Date.now() >= until) break;
    await wait(5000);
  }
  if (!APPLY) return { id: null, wouldAdd: true };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await lidarrClient.addAlbum(artistId, match.releaseGroupId, match.title, { monitored: false, triggerSearch: false });
    } catch (error) {
      // Already there after all - the refresh got to it first.
      const again = (await albumsOf(artistId)).find((entry) => entry.foreignAlbumId === match.releaseGroupId);
      if (again) return again;
      if (attempt === 5) throw error;
      await wait(5000);
    }
  }
  return null;
}

async function runCommand(body) {
  const command = await lidarr("/command", "POST", body);
  const until = Date.now() + COMMAND_WAIT_MS;
  for (;;) {
    await wait(3000);
    const state = await lidarr(`/command/${command.id}`);
    if (["completed", "failed", "aborted", "cancelled"].includes(state.status)) return state;
    if (Date.now() > until) return { ...state, status: "timed out" };
  }
}

const fileExists = (file) => fs.access(file).then(() => true, () => false);

// ---------------------------------------------------------------- one album

async function importAlbum(entry, context) {
  const { match } = entry;
  const result = { folder: entry.folder, album: `${match.artistName} - ${match.title}`, files: entry.files.length };

  let artist = context.artistsByMbid.get(match.artistMbid);
  let added = false;
  if (!artist) {
    if (!APPLY) return { ...result, outcome: "would add artist and import" };
    const created = await lidarrClient.addArtist(match.artistMbid, match.artistName, {
      albumOnly: true,
      albumMbid: match.releaseGroupId,
      triggerSearch: false,
      savedRootFolderPath: context.person?.lidarrRootFolderPath || null,
      savedQualityProfileId: context.person?.lidarrQualityProfileId ?? null,
    });
    if (!created?.id) return { ...result, outcome: "failed", reason: `could not add the artist: ${created?.error || "no id returned"}` };
    artist = created;
    added = true;
    context.addedArtists.add(artist.id);
    context.artistsByMbid.set(match.artistMbid, artist);
    log(`  added artist ${match.artistName}`);
  }
  result.artistId = artist.id;

  const album = await findOrAddAlbum(artist.id, match, { justAdded: added });
  if (!album) return { ...result, outcome: "failed", reason: "Lidarr would not add this album" };
  if (album.wouldAdd) return { ...result, outcome: "would add album and import" };
  // Nothing brought in here should send Lidarr looking to download or upgrade.
  if (APPLY && album.monitored) await lidarr("/album/monitor", "PUT", { albumIds: [album.id], monitored: false });

  // Every copy goes to Lidarr, and Lidarr says which track each one is; one
  // file per track is kept. Choosing among copies by name alone keeps the
  // wrong one when copies are titled differently ("Things Behind the Barn",
  // "Behind the Barn").
  const all = [...entry.files, ...(entry.extraCopies || [])];
  const wanted = new Set(all.map((file) => path.join(entry.folder, file)));
  const offered = async () => (await lidarr(
    `/manualimport?folder=${encodeURIComponent(entry.folder)}&artistId=${artist.id}&filterExistingFiles=true&replaceExistingFiles=false`,
  )).filter((item) => wanted.has(item.path));
  let items = await offered();

  // "Has missing tracks" on a folder that holds a whole album means Lidarr is
  // matching against a longer edition - the deluxe, the 2CD. Choosing the
  // edition whose track count is what is here, as a person would on the
  // album's page in Lidarr, and matching again, fixes that.
  const missing = items.some((item) =>
    item.album?.id === album.id && (item.rejections || []).some((rejection) => PARTIAL.test(rejection.reason)));
  if (missing && !IMPORT_PARTIAL) {
    const full = await lidarr(`/album/${album.id}`);
    const current = (full.releases || []).find((release) => release.monitored);
    const fits = (full.releases || [])
      .filter((release) => release.trackCount === entry.files.length)
      .sort((a, b) => Number(/digital/i.test(b.format || "")) - Number(/digital/i.test(a.format || "")));
    if (fits.length && fits[0].id !== current?.id) {
      if (!APPLY) return { ...result, outcome: `would switch to the ${fits[0].trackCount}-track edition and import` };
      for (const release of full.releases) release.monitored = release.id === fits[0].id;
      await lidarr(`/album/${album.id}`, "PUT", full);
      result.edition = `${fits[0].title} (${fits[0].format || "?"}, ${fits[0].trackCount} tracks)`;
      items = await offered();
    }
  }

  const COPY = /\.\d+\.[a-z0-9]+$/i;
  const byTrack = new Map();
  const refused = [];
  for (const item of items) {
    const trackKey = (item.tracks || []).map((track) => track.id).sort().join(",");
    if (item.album?.id !== album.id || !trackKey) {
      refused.push({
        file: path.basename(item.path),
        reasons: [item.album?.id !== album.id
          ? `matched to ${item.album?.title ? `"${item.album.title}"` : "no album"}, not this one`
          : "not matched to a track"],
      });
      continue;
    }
    if (!byTrack.has(trackKey)) byTrack.set(trackKey, []);
    byTrack.get(trackKey).push(item);
  }
  const good = [];
  for (const copies of byTrack.values()) {
    copies.sort((a, b) =>
      Number(COPY.test(a.path)) - Number(COPY.test(b.path)) ||
      (b.quality?.quality?.id || 0) - (a.quality?.quality?.id || 0) ||
      (b.size || 0) - (a.size || 0));
    const [keep, ...rest] = copies;
    // "Has unmatched tracks" is about the folder as a whole: the copies being
    // left behind, and the files matched to nothing, reported above. Every
    // file sent here has matched a track of its own on this album, so that
    // refusal does not apply to what is imported.
    const reasons = (keep.rejections || [])
      .map((rejection) => rejection.reason)
      .filter((reason) => !/^Has unmatched tracks/i.test(reason))
      .filter((reason) => !(IMPORT_PARTIAL && PARTIAL.test(reason)))
      // Every file here matched a track on this album (checked above).
      .filter((reason) => !(ACCEPT_LOW_CONFIDENCE && LOW_CONFIDENCE.test(reason)));
    if (reasons.length) refused.push({ file: path.basename(keep.path), reasons });
    else good.push(keep);
    for (const copy of rest) refused.push({ file: path.basename(copy.path), reasons: ["another copy of a track being imported; left behind"] });
  }
  const unseen = all.length - items.length;
  if (unseen) refused.push({ file: `${unseen} file(s)`, reasons: ["Lidarr did not offer them for import"] });
  result.refused = refused;

  if (!good.length) return { ...result, outcome: "failed", reason: "no file matched cleanly", addedArtist: added };
  if (!APPLY) return { ...result, outcome: `would import ${good.length} of ${entry.files.length}` };

  const command = await runCommand({
    name: "ManualImport",
    importMode: "move",
    replaceExistingFiles: false,
    files: good.map((item) => ({
      path: item.path,
      artistId: artist.id,
      albumId: album.id,
      albumReleaseId: item.albumReleaseId,
      trackIds: item.tracks.map((track) => track.id),
      quality: item.quality,
      indexerFlags: item.indexerFlags || 0,
      disableReleaseSwitching: false,
    })),
  });
  // Lidarr marks the album monitored as it finishes setting up an artist it
  // has just added, which can land after the check above. Nothing brought in
  // here is for Lidarr to go and complete, so say it again once imported.
  // An artist that was already there keeps whatever someone asked for.
  if (added) await lidarr("/album/monitor", "PUT", { albumIds: [album.id], monitored: false });
  let moved = 0;
  for (const item of good) if (!(await fileExists(item.path))) moved += 1;
  context.tagArtists.add(artist.id);
  return {
    ...result,
    outcome: moved === good.length ? "imported" : moved ? "partly imported" : "failed",
    imported: moved,
    command: command.status,
    ...(moved < good.length ? { reason: `Lidarr's import ${command.status}; ${good.length - moved} file(s) still in place` } : {}),
  };
}

// Already on the server: nothing to import, but it belongs in their library.
async function claimExisting(entry, context) {
  const result = { folder: entry.folder, album: entry.match ? `${entry.match.artistName} - ${entry.match.title}` : `${entry.artist} - ${entry.album}` };
  const lidarrAlbum = entry.match ? context.lidarrAlbumsByRg.get(entry.match.releaseGroupId) : null;
  if (lidarrAlbum?.statistics?.trackFileCount > 0) {
    context.tagArtists.add(lidarrAlbum.artistId);
    return { ...result, outcome: APPLY ? "artist tagged" : "would tag artist" };
  }
  const nd = context.navidromeAlbum(entry);
  if (!nd) return { ...result, outcome: "failed", reason: "no longer found on the server" };
  const songs = await context.navidrome._nativeRequest("GET", `/api/song?album_id=${encodeURIComponent(nd.id)}&_start=0&_end=1`);
  const folder = albumFolderOf(songs?.[0]?.path || "");
  if (!folder) return { ...result, outcome: "failed", reason: "could not tell which folder the server's copy is in" };
  if (APPLY) addUserLibraryAlbums(TAG, [folder], "their own library");
  return { ...result, outcome: APPLY ? "linked album" : "would link album", serverFolder: folder };
}

// Loose songs share their artist folder with other groups, so the first file
// is part of what names an album.
const albumKey = (entry) => `${entry.folder}|${entry.files[0]}`;

// ---------------------------------------------------------------- run

async function main() {
  const plan = JSON.parse(await fs.readFile(path.join(OUT_DIR, "plan.json"), "utf8"));
  const person = userOps.getUserByUsername(TAG);
  if (!person) log(`note: no Psalter user called ${TAG}; artists are still tagged, but nobody's library follows the tag`);

  const artists = await lidarrClient.listArtists({ forceRefresh: true });
  const lidarrAlbums = await lidarr("/album");
  const navidrome = getAdminNavidromeClient();
  const ndAlbums = [];
  for (let start = 0; ; start += 500) {
    const page = await navidrome._nativeRequest("GET", `/api/album?_start=${start}&_end=${start + 500}&_sort=name&_order=ASC`);
    if (!Array.isArray(page) || !page.length) break;
    ndAlbums.push(...page.filter((album) => Number(album.libraryId) === 1 && !album.missing));
    if (page.length < 500) break;
  }
  const ndByRg = new Map(ndAlbums.filter((album) => album.mbzReleaseGroupId).map((album) => [album.mbzReleaseGroupId, album]));
  const ndByName = new Map(ndAlbums.map((album) => [`${normalize(album.albumArtist)}|${stripEdition(album.name)}`, album]));

  const context = {
    person,
    navidrome,
    artistsByMbid: new Map(artists.map((artist) => [artist.foreignArtistId, artist])),
    lidarrAlbumsByRg: new Map(lidarrAlbums.map((album) => [album.foreignAlbumId, album])),
    navidromeAlbum: (entry) =>
      (entry.match && ndByRg.get(entry.match.releaseGroupId)) ||
      ndByName.get(`${normalize(entry.artist)}|${stripEdition(entry.album)}`) ||
      (entry.match && ndByName.get(`${normalize(entry.match.artistName)}|${stripEdition(entry.match.title)}`)),
    tagArtists: new Set(),
    addedArtists: new Set(),
  };

  // What an earlier run imported is not tried again: its files have moved.
  const resultsPath = path.join(OUT_DIR, "results.json");
  const earlier = JSON.parse(await fs.readFile(resultsPath, "utf8").catch(() => "[]"));
  const done = new Set(earlier.filter((entry) => ["imported", "artist tagged", "linked album"].includes(entry.outcome)).map((entry) => entry.key));

  let chosen = plan.albums
    .filter((entry) => BUCKETS.includes(entry.bucket))
    .filter((entry) => !done.has(albumKey(entry)))
    .filter((entry) => !FOLDERS.length || FOLDERS.includes(path.relative(plan.source, entry.folder)));
  if (LIMIT) chosen = chosen.slice(0, LIMIT);
  log(`${APPLY ? "APPLYING" : "dry run"}: ${chosen.length} albums from ${BUCKETS.join(", ")}, tag ${TAG}`);

  const results = [];
  for (const [index, entry] of chosen.entries()) {
    log(`${index + 1}/${chosen.length} ${path.relative(plan.source, entry.folder)}`);
    let result;
    try {
      result = entry.bucket === "onServer"
        ? await claimExisting(entry, context)
        : entry.match
          ? await importAlbum(entry, context)
          : { folder: entry.folder, outcome: "skipped", reason: "not identified" };
    } catch (error) {
      result = { folder: entry.folder, outcome: "failed", reason: error.message };
    }
    log(`  ${result.outcome}${result.reason ? ` - ${result.reason}` : ""}`);
    results.push({ key: albumKey(entry), bucket: entry.bucket, at: new Date().toISOString(), ...result });
  }

  // Lidarr finishes setting up a new artist in the background, and marks the
  // album it was added for as monitored when it does - which can be after the
  // import, and after the album was unmonitored. In the full run five albums
  // that had imported were monitored again this way, and fifteen whose import
  // failed had never been unmonitored at all. So once everything is done,
  // every album of every artist this run added is unmonitored: nothing here is
  // for Lidarr to go and download.
  if (APPLY && context.addedArtists.size) {
    await wait(30_000);
    const ids = [];
    for (const artistId of context.addedArtists) {
      for (const album of await albumsOf(artistId)) if (album.monitored) ids.push(album.id);
    }
    if (ids.length) await lidarr("/album/monitor", "PUT", { albumIds: ids, monitored: false });
    log(`unmonitored ${ids.length} album(s) on the ${context.addedArtists.size} artist(s) added`);
  }

  const tagId = APPLY ? await lidarrClient.ensureUserTag(TAG) : await lidarrClient.findTagId(TAG);
  if (APPLY && context.tagArtists.size && tagId !== null) {
    await lidarrClient.updateArtistsTags([...context.tagArtists], [tagId], "add");
    log(`tagged ${context.tagArtists.size} artists ${TAG}`);
  }
  if (APPLY && person) {
    log("bringing personal libraries up to date");
    await reconcileUserLibrariesAndWait();
  }

  // A real run adds to what earlier runs did; a dry run stands alone.
  await fs.writeFile(
    path.join(OUT_DIR, `results${APPLY ? "" : "-dry-run"}.json`),
    JSON.stringify(APPLY ? [...earlier, ...results] : results, null, 1),
  );
  await fs.writeFile(path.join(OUT_DIR, `results${APPLY ? "" : "-dry-run"}.txt`), summary(results, context));
  log(`wrote results${APPLY ? "" : "-dry-run"}.txt`);
}

function summary(results, context) {
  const counts = new Map();
  for (const result of results) counts.set(result.outcome, (counts.get(result.outcome) || 0) + 1);
  const lines = [
    `${APPLY ? "Import" : "Dry run"} for ${LABEL} (tag ${TAG}), ${new Date().toISOString()}`,
    "",
    ...[...counts].map(([outcome, count]) => `${outcome}: ${count}`),
    `artists to tag ${TAG}: ${context.tagArtists.size}`,
  ];
  for (const result of results.filter((entry) => entry.reason || entry.refused?.length)) {
    lines.push("", `${result.folder}`, `  ${result.outcome}${result.reason ? ` - ${result.reason}` : ""}`);
    for (const refusal of result.refused || []) lines.push(`    ${refusal.file}: ${refusal.reasons.join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}

await main();
process.exit(0);
