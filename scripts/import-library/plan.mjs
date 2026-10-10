// Works out what importing a folder of someone's music into Lidarr would do,
// without doing any of it. Nothing is added, moved, tagged or imported.
//
//   docker exec -i -e SOURCE_ROOT=/data/Music/brother-library -e LABEL=bspang aurral \
//     node --input-type=module < scripts/import-library/plan.mjs
//
// Writes /app/downloads/library-import/<LABEL>/plan.json, which apply.mjs
// reads, and report.txt for a person. /app/downloads is on the host at
// Docker_Apps/aurral/aurral/downloads.
//
// Lidarr's own Manual Import can only match albums to artists it already has,
// so pointing it at a folder of new music rejects nearly everything. This asks
// Lidarr's metadata search instead, which knows every artist, and checks each
// match against what the server already holds - in Lidarr, and in Navidrome's
// main library, which also has music Lidarr does not manage.
//
// Every album lands in one bucket:
//
//   ready        identified, complete, and not on the server
//   onServer     the server already has it (Lidarr or Navidrome)
//   partial      the server has some of it; left for a person to decide
//   incomplete   identified, but fewer tracks than any release of it
//   unidentified the tags do not lead to one album with any confidence

import fs from "node:fs/promises";
import path from "node:path";

// Or a list of files already inside the library that Lidarr does not manage
// (a JSON array of absolute paths): they are planned where they are, and the
// server's own copies of them do not count as the album being on the server.
const FILE_LIST = process.env.FILE_LIST || "";
const SOURCE_ROOT = (process.env.SOURCE_ROOT || (FILE_LIST ? "/data/Music/Library" : "")).replace(/\/+$/, "");
const LABEL = process.env.LABEL || "import";
const OUT_DIR = process.env.OUT_DIR || `/app/downloads/library-import/${LABEL}`;
const LOOKUP_DELAY_MS = Number(process.env.LOOKUP_DELAY_MS || 400);
const LIMIT = Number(process.env.LIMIT || 0);
if (!SOURCE_ROOT) throw new Error("SOURCE_ROOT is required");

const AUDIO = /\.(mp3|m4a|flac|ogg|opus|wav|aiff?|alac|wma)$/i;
const LOSSLESS = /\.(flac|wav|aiff?|alac)$/i;

const mm = await import("music-metadata");

// A beets library, if the folder came with one. Beets knows each file by its
// path on the machine it ran on, so paths are matched on what follows the
// library folder. Where it matched an album to MusicBrainz, that is exact.
const BEETS_DB = process.env.BEETS_DB || `${SOURCE_ROOT}/library.db`;
const beetsReleaseGroups = await (async () => {
  const byRelative = new Map();
  try {
    await fs.access(BEETS_DB);
    const { default: Database } = await import("better-sqlite3");
    const beets = new Database(BEETS_DB, { readonly: true, fileMustExist: true });
    for (const row of beets.prepare("SELECT path, mb_releasegroupid AS rg FROM items WHERE mb_releasegroupid != ''").all()) {
      const parts = Buffer.from(row.path).toString().split("/");
      byRelative.set(parts.slice(-3).join("/"), row.rg);
    }
    beets.close();
  } catch {}
  return byRelative;
})();
const beetsReleaseGroup = (folder, file) =>
  beetsReleaseGroups.get([...folder.split("/").slice(-2), file].join("/")) || null;
const { lidarrClient } = await import("/app/backend/services/lidarrClient.js");
const { getAdminNavidromeClient } = await import("/app/backend/services/navidromeTrackResolver.js");

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- names

const normalize = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the /, "")
    .trim();

// "Blue (Deluxe Edition)", "Blue [2011 Remaster]" and "Blue" are one album
// for the purpose of whether we already have it.
const EDITION = /[([][^)\]]*(deluxe|remaster|edition|expanded|anniversary|bonus|version|mono|stereo|reissue|special)[^)\]]*[)\]]/gi;
const stripEdition = (value) => normalize(String(value || "").replace(EDITION, " "));

const tokens = (value) => new Set(normalize(value).split(" ").filter(Boolean));

// Letter pairs, so a typo or a respelling costs a little rather than a whole
// word: "Six Sicks Exit" and "Six Sick Ex It" are the same album.
function bigramDice(a, b) {
  const pairs = (value) => {
    const text = normalize(value).replace(/ /g, "");
    const out = new Map();
    for (let i = 0; i < text.length - 1; i += 1) {
      const pair = text.slice(i, i + 2);
      out.set(pair, (out.get(pair) || 0) + 1);
    }
    return out;
  };
  const x = pairs(a);
  const y = pairs(b);
  let shared = 0;
  for (const [pair, count] of x) shared += Math.min(count, y.get(pair) || 0);
  const total = [...x.values(), ...y.values()].reduce((sum, count) => sum + count, 0);
  return total ? (2 * shared) / total : 0;
}

function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const sx = stripEdition(a);
  const sy = stripEdition(b);
  if (sx && sx === sy) return 0.95;
  // A title cut short, or missing its subtitle: "7th Heaven: Music of the
  // Spheres" is "7th Heaven: Music of the Spheres, the Complete Singles
  // Collection". Only for titles long enough not to match by accident.
  const [short, long] = sx.length <= sy.length ? [sx, sy] : [sy, sx];
  if (short.length >= 8 && long.startsWith(short)) return 0.9;
  const words = tokens(a);
  const other = tokens(b);
  const shared = [...words].filter((token) => other.has(token)).length;
  const jaccard = shared / Math.max(1, new Set([...words, ...other]).size);
  return Math.max(jaccard, bigramDice(sx || a, sy || b));
}

function artistSimilarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // "Gabby Pahinui, Atta Isaacs" is credited to Gabby Pahinui, and "Aaron
  // Frazer, The Flying Stars Of Brooklyn NY" to the Flying Stars.
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (` ${long} `.includes(` ${short} `) && short.length >= 4) return 0.85;
  return similarity(a, b);
}

// ---------------------------------------------------------------- what he has

async function listDirs(dir) {
  return (await fs.readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

async function readTags(file) {
  try {
    const { common, format } = await mm.parseFile(file, { duration: false, skipCovers: true });
    return {
      artist: common.albumartist || common.artist || "",
      trackArtist: common.artist || "",
      album: common.album || "",
      title: common.title || "",
      track: common.track?.no ?? null,
      disc: common.disk?.no ?? null,
      releaseGroupId: common.musicbrainz_releasegroupid || null,
      bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
    };
  } catch (error) {
    return { error: error.message };
  }
}

const mostCommon = (values) => {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
};

// "Lusitania.mp3", "Lusitania.1.mp3" and "Lusitania.2.mp3" are one song
// copied three times - what macOS does to a file copied onto itself. Lidarr
// refuses an album holding them all, so one is kept: the unnumbered one, or
// else the best bitrate. The rest are reported and left behind.
const COPY_SUFFIX = /\.(\d+)(\.[a-z0-9]+)$/i;
function keepOneCopy(tags) {
  const bySong = new Map();
  for (const entry of tags) {
    const base = entry.file.replace(COPY_SUFFIX, "$2");
    // Disc and track number say which song it is on their own; the copies'
    // titles can differ ("Danse Caribe", "Danse Carribe").
    const key = entry.error
      ? `file:${base.toLowerCase()}`
      : entry.track
        ? `${entry.disc || 1}:${entry.track}`
        : `title:${normalize(entry.title) || normalize(base)}`;
    if (!bySong.has(key)) bySong.set(key, []);
    bySong.get(key).push(entry);
  }
  const kept = [];
  const extra = [];
  for (const copies of bySong.values()) {
    copies.sort((a, b) =>
      Number(COPY_SUFFIX.test(a.file)) - Number(COPY_SUFFIX.test(b.file)) ||
      (b.bitrate || 0) - (a.bitrate || 0) ||
      a.file.localeCompare(b.file));
    kept.push(copies[0]);
    extra.push(...copies.slice(1).map((entry) => entry.file));
  }
  return { kept: kept.sort((a, b) => a.file.localeCompare(b.file)), extra };
}

// One album: a folder of songs, or the songs sitting loose in an artist
// folder that share an album tag.
async function describeAlbum(folder, allFiles, { loose = false } = {}) {
  const read = [];
  for (const file of allFiles) read.push({ file, ...(await readTags(path.join(folder, file))) });
  const { kept: tags, extra } = keepOneCopy(read);
  const files = tags.map((entry) => entry.file);
  const readable = tags.filter((entry) => !entry.error);
  const albums = new Set(readable.map((entry) => normalize(entry.album)).filter(Boolean));
  return {
    folder,
    files,
    loose,
    artist: mostCommon(readable.map((entry) => entry.artist)) || path.basename(path.dirname(folder)),
    album: mostCommon(readable.map((entry) => entry.album)) || path.basename(folder),
    trackCount: files.length,
    extraCopies: extra,
    highestTrack: Math.max(0, ...readable.map((entry) => Number(entry.track) || 0)),
    unreadable: tags.length - readable.length,
    mixedAlbumTags: albums.size > 1,
    releaseGroupId:
      mostCommon(readable.map((entry) => entry.releaseGroupId)) ||
      mostCommon(files.map((file) => beetsReleaseGroup(folder, file))) ||
      null,
    lossless: files.some((file) => LOSSLESS.test(file)),
    bitrate: mostCommon(readable.map((entry) => entry.bitrate)) || null,
  };
}

async function collectListedAlbums() {
  const listed = JSON.parse(await fs.readFile(FILE_LIST, "utf8")).filter((file) => AUDIO.test(file));
  const byFolder = new Map();
  for (const file of listed) {
    const folder = path.dirname(file);
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(path.basename(file));
  }
  const albums = [];
  for (const [folder, files] of byFolder) {
    // Straight in an artist's folder: grouped by their album tag, as below.
    const loose = path.dirname(folder) === SOURCE_ROOT;
    if (!loose) {
      albums.push(await describeAlbum(folder, files.sort()));
    } else {
      const groups = new Map();
      for (const file of files.sort()) {
        const album = normalize((await readTags(path.join(folder, file))).album) || "(no album tag)";
        if (!groups.has(album)) groups.set(album, []);
        groups.get(album).push(file);
      }
      for (const group of groups.values()) albums.push(await describeAlbum(folder, group, { loose: true }));
    }
    if (LIMIT && albums.length >= LIMIT) break;
  }
  return albums;
}

async function collectAlbums() {
  if (FILE_LIST) return collectListedAlbums();
  const albums = [];
  for (const artistFolder of await listDirs(SOURCE_ROOT)) {
    const artistPath = path.join(SOURCE_ROOT, artistFolder);
    for (const albumFolder of await listDirs(artistPath)) {
      const albumPath = path.join(artistPath, albumFolder);
      const files = (await fs.readdir(albumPath)).filter((file) => AUDIO.test(file)).sort();
      if (files.length) albums.push(await describeAlbum(albumPath, files));
    }
    const loose = (await fs.readdir(artistPath)).filter((file) => AUDIO.test(file)).sort();
    if (loose.length) {
      const groups = new Map();
      for (const file of loose) {
        const album = normalize((await readTags(path.join(artistPath, file))).album) || "(no album tag)";
        if (!groups.has(album)) groups.set(album, []);
        groups.get(album).push(file);
      }
      for (const files of groups.values()) albums.push(await describeAlbum(artistPath, files, { loose: true }));
    }
    if (LIMIT && albums.length >= LIMIT) break;
  }
  return albums;
}

// ---------------------------------------------------------------- what the server has

async function serverAlbums() {
  // Straight from Lidarr and Navidrome: Psalter's index can run behind both.
  const lidarrAlbums = await lidarrClient.request("/album");
  const lidarrArtists = await lidarrClient.request("/artist");
  const nd = getAdminNavidromeClient();
  const navidrome = [];
  for (let start = 0; ; start += 500) {
    const page = await nd._nativeRequest("GET", `/api/album?_start=${start}&_end=${start + 500}&_sort=name&_order=ASC`);
    if (!Array.isArray(page) || !page.length) break;
    navidrome.push(...page.filter((album) => Number(album.libraryId) === 1 && !album.missing));
    if (page.length < 500) break;
  }
  // Planning files already in the library: an album Navidrome knows only
  // from those very files is not the server having it.
  let onlyListed = new Set();
  if (FILE_LIST) {
    const listed = new Set(JSON.parse(await fs.readFile(FILE_LIST, "utf8")).map((file) => file.slice(SOURCE_ROOT.length + 1)));
    // Only the albums these files belong to need checking: each listed file's
    // album, and whether it holds anything else.
    const albumIds = new Set();
    for (const file of listed) {
      const songs = await nd.findSongsByPath(file).catch(() => []);
      for (const song of songs) if (Number(song.libraryId) === 1 && song.path === file) albumIds.add(song.albumId);
    }
    for (const albumId of albumIds) {
      const songs = await nd._nativeRequest("GET", `/api/song?album_id=${encodeURIComponent(albumId)}&library_id=1&_start=0&_end=500`).catch(() => null);
      if (Array.isArray(songs) && songs.every((song) => Number(song.libraryId) !== 1 || listed.has(song.path))) onlyListed.add(albumId);
    }
    log(`${onlyListed.size} Navidrome albums are only the listed files; they do not count as on the server`);
  }
  const byRg = new Map();
  for (const album of lidarrAlbums) byRg.set(album.foreignAlbumId, album);
  const ndByRg = new Map();
  const ndByName = new Map();
  for (const album of navidrome) {
    if (onlyListed.has(album.id)) continue;
    if (album.mbzReleaseGroupId) ndByRg.set(album.mbzReleaseGroupId, album);
    const key = `${normalize(album.albumArtist)}|${stripEdition(album.name)}`;
    if (!ndByName.has(key)) ndByName.set(key, album);
  }
  const artistByMbid = new Map(lidarrArtists.map((artist) => [artist.foreignArtistId, artist]));
  log(`server: ${lidarrAlbums.length} Lidarr albums, ${lidarrArtists.length} Lidarr artists, ${navidrome.length} Navidrome albums`);
  return { byRg, ndByRg, ndByName, artistByMbid };
}

// ---------------------------------------------------------------- matching

// Lidarr's metadata server fails some searches every time - anything with
// "Adventure Time" in it, however worded - and others now and then. Asked
// through Psalter's Lidarr client, three failures in a minute stop every
// call for a minute (its circuit breaker), so one bad term stalled the terms
// after it. So Lidarr is asked directly here, a failing term is tried twice,
// and then the album goes to MusicBrainz instead.
const { lidarrUrl, lidarrKey } = await (async () => {
  await lidarrClient.request("/system/status");
  return { lidarrUrl: lidarrClient.config.url.replace(/\/+$/, ""), lidarrKey: lidarrClient.config.apiKey.trim() };
})();

async function lookup(term) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${lidarrUrl}/api/v1/album/lookup?term=${encodeURIComponent(term)}`, {
      headers: { "X-Api-Key": lidarrKey },
    }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));
    if (response.ok) {
      await wait(LOOKUP_DELAY_MS);
      const results = await response.json();
      return Array.isArray(results) ? results : [];
    }
    if (attempt === 1) throw new Error(`Lidarr search failed (${response.status}): ${(await response.text()).slice(0, 120)}`);
    await wait(3000);
  }
}

// ---------------------------------------------------------------- MusicBrainz

// Where Lidarr's search cannot help, MusicBrainz itself - which is where
// Lidarr's metadata comes from, so the ids are the ones Lidarr will accept.
// One request a second, named, as MusicBrainz asks of everyone.
const { getMusicBrainzContact } = await import("/app/backend/services/apiClients/config.js");
const MB_AGENT = `Psalter/1.0 ( ${getMusicBrainzContact()} )`;
let lastMb = 0;
async function musicbrainz(endpoint) {
  const gap = 1100 - (Date.now() - lastMb);
  if (gap > 0) await wait(gap);
  lastMb = Date.now();
  const response = await fetch(`https://musicbrainz.org/ws/2${endpoint}`, {
    headers: { "User-Agent": MB_AGENT, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`MusicBrainz ${response.status}`);
  return response.json();
}

const luceneQuote = (value) => `"${String(value || "").replace(/["\\]/g, " ").trim()}"`;

// The same shape Lidarr's lookup gives, so matching and the plan need not
// care which answered.
async function musicbrainzCandidates(album) {
  const query = `releasegroup:${luceneQuote(album.album)} AND artist:${luceneQuote(album.artist)}`;
  const found = await musicbrainz(`/release-group?query=${encodeURIComponent(query)}&limit=8&fmt=json`);
  const candidates = [];
  for (const group of (found["release-groups"] || []).slice(0, 4)) {
    const releases = await musicbrainz(`/release?release-group=${group.id}&inc=media&limit=25&fmt=json`);
    const credit = group["artist-credit"]?.[0];
    candidates.push({
      foreignAlbumId: group.id,
      title: group.title,
      albumType: group["primary-type"] || "Other",
      secondaryTypes: group["secondary-types"] || [],
      artist: { artistName: credit?.artist?.name || credit?.name, foreignArtistId: credit?.artist?.id },
      releases: (releases.releases || []).map((release) => ({
        trackCount: (release.media || []).reduce((sum, medium) => sum + (medium["track-count"] || 0), 0),
      })),
    });
  }
  return candidates;
}

async function identify(album) {
  if (album.releaseGroupId) {
    const [exact] = await lookup(`lidarr:${album.releaseGroupId}`);
    if (exact) return { candidate: exact, score: 1, how: "musicbrainz tag" };
  }
  const score = (results) => {
    let best = null;
    for (const result of results) {
      const title = similarity(album.album, result.title);
      const artist = artistSimilarity(album.artist, result.artist?.artistName);
      const counts = (result.releases || []).map((release) => release.trackCount);
      const fits = counts.includes(album.trackCount) ? 1 : 0;
      // Track 5 cannot come from a one-track single of the same name.
      const tooShort = album.highestTrack && counts.length && album.highestTrack > Math.max(...counts);
      // An album and a single often share a title; the album is the usual
      // home of a song someone has, so it wins a tie.
      const isAlbum = result.albumType === "Album" ? 1 : 0;
      const total = title * 0.6 + artist * 0.3 + fits * 0.05 + isAlbum * 0.06 - (tooShort ? 0.5 : 0);
      if (!best || total > best.score) best = { candidate: result, score: total, title, artist };
    }
    return best;
  };
  const confident = (best) => best && best.title >= 0.85 && best.artist >= 0.8;
  let best = null;
  let lidarrFailed = null;
  try {
    best = score(await lookup(`${album.artist} ${album.album}`));
    // The artist's name in the search can crowd out the album; by title
    // alone, checked against the artist, often finds it.
    if (!confident(best)) {
      const byTitle = score(await lookup(album.album));
      if (byTitle && (!best || byTitle.score > best.score)) best = byTitle;
    }
  } catch (error) {
    lidarrFailed = error;
  }
  if (lidarrFailed || !confident(best)) {
    try {
      const fromMb = score(await musicbrainzCandidates(album));
      if (fromMb && confident(fromMb) && (!best || fromMb.score >= best.score)) {
        return { ...fromMb, how: "name, via MusicBrainz" };
      }
    } catch (error) {
      if (lidarrFailed) throw new Error(`${lidarrFailed.message}; MusicBrainz too: ${error.message}`);
    }
  }
  if (lidarrFailed) throw lidarrFailed;
  if (!best) return { candidate: null, score: 0, how: "no results" };
  return { ...best, how: confident(best) ? "name" : "not confident" };
}

// ---------------------------------------------------------------- the plan

const summarize = (candidate) => candidate && ({
  releaseGroupId: candidate.foreignAlbumId,
  title: candidate.title,
  type: [candidate.albumType, ...(candidate.secondaryTypes || [])].filter(Boolean).join(" / "),
  artistName: candidate.artist?.artistName,
  artistMbid: candidate.artist?.foreignArtistId,
  trackCounts: [...new Set((candidate.releases || []).map((release) => release.trackCount))].sort((a, b) => a - b),
});

// Match one album and say which bucket it belongs in.
async function planAlbum(album, server) {
  let match;
  try {
    match = await identify(album);
  } catch (error) {
    match = { candidate: null, score: 0, how: `lookup failed: ${error.message}` };
  }
  const candidate = summarize(match.candidate);
  const entry = { ...album, match: candidate, score: Number(match.score.toFixed(2)), how: match.how };
  delete entry.bucket;
  delete entry.where;

  const ndName = server.ndByName.get(`${normalize(album.artist)}|${stripEdition(album.album)}`);
  if (!candidate || match.how === "not confident" || match.how === "no results" || match.how.startsWith("lookup failed")) {
    // Not identified - but if Navidrome already has an album of that name
    // by that artist, it is still a duplicate, and that is the more useful
    // thing to know.
    if (ndName) {
      entry.bucket = "onServer";
      entry.where = `Navidrome: ${ndName.albumArtist} - ${ndName.name} (${ndName.songCount} songs)`;
    } else {
      entry.bucket = "unidentified";
    }
    return entry;
  }

  const inLidarr = server.byRg.get(candidate.releaseGroupId);
  const inNavidrome = server.ndByRg.get(candidate.releaseGroupId) || ndName;
  const lidarrArtist = server.artistByMbid.get(candidate.artistMbid);
  entry.artistInLidarr = Boolean(lidarrArtist);
  entry.lidarrArtistId = lidarrArtist?.id ?? null;

  const files = inLidarr?.statistics?.trackFileCount || 0;
  const total = inLidarr?.statistics?.totalTrackCount || inLidarr?.statistics?.trackCount || 0;
  if (inLidarr && files > 0 && files < total && album.trackCount > files) {
    entry.bucket = "partial";
    entry.where = `Lidarr has ${files} of ${total} tracks`;
  } else if ((inLidarr && files > 0) || inNavidrome) {
    entry.bucket = "onServer";
    entry.where = inLidarr && files > 0
      ? `Lidarr (${files} tracks)`
      : `Navidrome: ${inNavidrome.albumArtist} - ${inNavidrome.name} (${inNavidrome.songCount} songs)`;
    entry.maybeBetter = album.lossless;
  } else if (candidate.trackCounts.length && album.trackCount < candidate.trackCounts[0]) {
    entry.bucket = "incomplete";
    entry.missing = candidate.trackCounts[0] - album.trackCount;
  } else {
    entry.bucket = "ready";
  }
  return entry;
}

async function writePlan(plan) {
  await fs.writeFile(path.join(OUT_DIR, "plan.json"), JSON.stringify({ source: SOURCE_ROOT, label: LABEL, made: new Date().toISOString(), albums: plan }, null, 1));
  await fs.writeFile(path.join(OUT_DIR, "report.txt"), report(plan));
  log(`wrote ${OUT_DIR}/plan.json and report.txt`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  // RETRY_FAILED=1 matches again only the albums whose lookup failed last
  // time - Lidarr's metadata server was down, so they were never tried - and
  // leaves the rest of the plan as it was.
  if (process.env.RETRY_FAILED === "1") {
    const existing = JSON.parse(await fs.readFile(path.join(OUT_DIR, "plan.json"), "utf8")).albums;
    const failed = existing.filter((entry) => String(entry.how).startsWith("lookup failed"));
    log(`retrying ${failed.length} albums whose lookup failed`);
    const server = await serverAlbums();
    const plan = [];
    for (const entry of existing) {
      plan.push(failed.includes(entry) ? await planAlbum(entry, server) : entry);
    }
    const still = plan.filter((entry) => String(entry.how).startsWith("lookup failed")).length;
    log(`${failed.length - still} matched this time, ${still} failed again`);
    await writePlan(plan);
    return;
  }

  log(`reading ${SOURCE_ROOT}${beetsReleaseGroups.size ? ` (beets knows ${beetsReleaseGroups.size} songs' albums)` : ""}`);
  const albums = await collectAlbums();
  log(`${albums.length} albums, ${albums.reduce((sum, album) => sum + album.trackCount, 0)} songs`);
  const server = await serverAlbums();

  const plan = [];
  for (const [index, album] of albums.entries()) {
    if (index % 50 === 0) log(`matching ${index}/${albums.length}`);
    plan.push(await planAlbum(album, server));
  }
  await writePlan(plan);
}

function report(plan) {
  const buckets = ["ready", "onServer", "partial", "incomplete", "unidentified"];
  const titles = {
    ready: "READY - identified, complete, not on the server",
    onServer: "ALREADY ON THE SERVER - will not be imported",
    partial: "PARTLY ON THE SERVER - the server has some tracks; decide by hand",
    incomplete: "INCOMPLETE - fewer tracks than any release of the album",
    unidentified: "CAN'T IDENTIFY - tags do not lead to one album; fix the tags and run again",
  };
  const lines = [`Import plan for ${SOURCE_ROOT} (${LABEL}), ${new Date().toISOString()}`, ""];
  for (const bucket of buckets) {
    const entries = plan.filter((entry) => entry.bucket === bucket);
    lines.push(`${titles[bucket]}: ${entries.length} albums, ${entries.reduce((sum, entry) => sum + entry.trackCount, 0)} songs`);
  }
  const newArtists = new Set(plan.filter((entry) => entry.bucket === "ready" && !entry.artistInLidarr).map((entry) => entry.match.artistMbid));
  lines.push("", `Importing READY would add ${newArtists.size} artists to Lidarr (album-only: nothing else of theirs is monitored or searched for).`);
  const extra = plan.reduce((sum, entry) => sum + (entry.extraCopies?.length || 0), 0);
  if (extra) lines.push(`${extra} files are extra copies of a song in the same folder; one copy of each is used and the rest are left behind.`);
  const better = plan.filter((entry) => entry.maybeBetter);
  if (better.length) lines.push(`${better.length} albums already on the server are lossless in this folder and may be better copies; marked [lossless] below.`);
  for (const bucket of buckets) {
    const entries = plan.filter((entry) => entry.bucket === bucket);
    if (!entries.length) continue;
    lines.push("", "=".repeat(78), titles[bucket], "=".repeat(78));
    for (const entry of entries.sort((a, b) => a.folder.localeCompare(b.folder))) {
      const rel = entry.folder.slice(SOURCE_ROOT.length + 1) + (entry.loose ? "  (loose files)" : "");
      lines.push(`${rel}  [${entry.trackCount} songs]${entry.maybeBetter ? " [lossless]" : ""}`);
      if (entry.match) lines.push(`    -> ${entry.match.artistName} - ${entry.match.title} (${entry.match.type}; releases of ${entry.match.trackCounts.join("/")} tracks; ${entry.how}, score ${entry.score})`);
      else lines.push(`    tags say: ${entry.artist} - ${entry.album} (${entry.how})`);
      if (entry.where) lines.push(`    on server: ${entry.where}`);
      if (entry.missing) lines.push(`    missing at least ${entry.missing} tracks`);
      if (entry.mixedAlbumTags) lines.push("    note: songs in this folder carry different album tags");
      if (entry.extraCopies?.length) lines.push(`    extra copies, left behind: ${entry.extraCopies.join(", ")}`);
      if (entry.unreadable) lines.push(`    note: ${entry.unreadable} files could not be read`);
    }
  }
  return `${lines.join("\n")}\n`;
}

await main();
process.exit(0);
