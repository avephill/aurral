import crypto from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { db } from "../config/db-sqlite.js";
import { userOps } from "../db/helpers/index.js";
import { logger } from "./logger.js";

/**
 * A copy of what each person has made of their library, so a mistake can be
 * put back: their playlists, ratings, favourites, tags, and which of the
 * server's music is theirs.
 *
 * None of it is music - nobody but an admin can delete files - so a copy is
 * small: about 2.75 MB compressed for a library of 96 playlists and 44,000
 * ratings. Each part is stored once, by its contents, however many snapshots
 * share it; a day on which nothing changed adds nothing, and a day on which
 * only ratings changed stores only ratings.
 *
 * Songs are recorded by their path in the library, never by Navidrome's song
 * id: an upgrade renumbered every song once, and a copy keyed on ids would not
 * have survived it.
 *
 * A snapshot is taken daily, and before every restore, so a restore can
 * itself be undone. Kept: everything from the last 30 days, and the last of
 * each month for a year. Restoring is an admin's job, part by part.
 */

const DAY = 24 * 60 * 60 * 1000;
const DAILY_DAYS = 30;
const MONTHLY_MONTHS = 12;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const SECTIONS = ["playlists", "ratings", "favourites", "tags", "library"];

export class LibraryHistoryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "LibraryHistoryError";
    this.status = status;
  }
}

// ---------------------------------------------------------------- reading what someone has

const sortObject = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));

async function readPlaylists(user) {
  const { createNavidromeUserClient } = await import("./navidromeUserClient.js");
  const { getAdminNavidromeClient } = await import("./navidromeTrackResolver.js");
  const { keptPlaylistsByNavidromeId } = await import("./tagPlaylistService.js");
  const { getPlaylistFolders } = await import("./navidromePlaylistFolders.js");
  const { normalizePath } = await import("./navidromePathMapping.js");
  const client = createNavidromeUserClient(user);
  const admin = getAdminNavidromeClient();
  if (!client || !admin?.isConfigured?.()) throw new LibraryHistoryError("Navidrome is not reachable", 503);
  const mine = (await client.getSubsonicPlaylists()).filter((playlist) => playlist.owner === client.user);
  const records = new Map((await admin.getPlaylistRecords()).map((record) => [String(record.id), record]));
  const kept = keptPlaylistsByNavidromeId(client.user);
  const folders = getPlaylistFolders(user.id);
  const playlists = [];
  for (const playlist of mine) {
    const id = String(playlist.id);
    const base = { name: playlist.name || "", folder: folders.get(id) || "", comment: playlist.comment || "" };
    if (kept.has(id)) {
      playlists.push({ ...base, kind: "kept", rules: kept.get(id).rules });
    } else if (records.get(id)?.rules) {
      playlists.push({ ...base, kind: "smart", rules: records.get(id).rules });
    } else {
      const rows = await admin.getPlaylistTracks(id);
      playlists.push({
        ...base,
        kind: "list",
        songs: rows.map((row) => normalizePath(row?.path ?? row?.mediaFile?.path ?? "")).filter(Boolean),
      });
    }
  }
  return playlists.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

// Paths relative to the library, the one identity a song keeps everywhere.
async function songIdsToPaths(songIds) {
  const { mediaPathsForNavidromeSongIds, getNavidromeRoots } = await import("./navidromeTrackResolver.js");
  const { relativeToRoot } = await import("./navidromePathMapping.js");
  const absolute = await mediaPathsForNavidromeSongIds(songIds, { maxLookups: Number.POSITIVE_INFINITY });
  const root = getNavidromeRoots().aurralRoot;
  const paths = new Map();
  for (const [songId, path] of absolute) {
    const relative = root ? relativeToRoot(path, root) : null;
    if (relative) paths.set(songId, relative);
  }
  return paths;
}

async function readRatings(user) {
  const { createNavidromeUserClient } = await import("./navidromeUserClient.js");
  const { readRatedSongIds } = await import("./navidromeUserRatings.js");
  const client = createNavidromeUserClient(user);
  if (!client) throw new LibraryHistoryError("Navidrome is not reachable", 503);
  const { rated } = await readRatedSongIds(client);
  const paths = await songIdsToPaths([...rated.keys()]);
  const ratings = {};
  for (const [songId, rating] of rated) {
    const path = paths.get(songId);
    // A file in two libraries is two songs; ratings are written to every
    // copy, so the higher covers one that missed a write.
    if (path) ratings[path] = Math.max(ratings[path] || 0, rating);
  }
  return sortObject(ratings);
}

async function readFavourites(user) {
  const { getStarredIdentityKeys } = await import("./subsonicLibraryService.js");
  return [...getStarredIdentityKeys(user)].sort();
}

async function readTags(user) {
  const { readOwnTagRows } = await import("./trackTagService.js");
  return readOwnTagRows(user.username);
}

async function readLibrary(user) {
  const { getUserLibrariesSettings, getUserLibraryMembership, listUserLibraryAlbums } = await import("./userLibraryService.js");
  if (!getUserLibrariesSettings().enabled) return { enabled: false, artists: [], albums: [] };
  const membership = await getUserLibraryMembership(user);
  return {
    enabled: true,
    artists: membership.artists
      .filter((artist) => artist.mbid)
      .map((artist) => ({ mbid: artist.mbid, name: artist.artistName || "" }))
      .sort((a, b) => a.mbid.localeCompare(b.mbid)),
    albums: listUserLibraryAlbums(user.username).map((album) => album.folder).sort(),
  };
}

export const defaultHistoryDeps = {
  read: {
    playlists: readPlaylists,
    ratings: readRatings,
    favourites: readFavourites,
    tags: readTags,
    library: readLibrary,
  },
};

// ---------------------------------------------------------------- storing

const hashOf = (text) => crypto.createHash("sha256").update(text).digest("hex");

function storePart(section, value) {
  const text = JSON.stringify(value);
  const hash = hashOf(`${section}\n${text}`);
  db.prepare(`
    INSERT OR IGNORE INTO library_snapshot_parts (hash, section, data, raw_bytes, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(hash, section, gzipSync(text), Buffer.byteLength(text), Date.now());
  return hash;
}

function loadPart(hash) {
  const row = db.prepare("SELECT data FROM library_snapshot_parts WHERE hash = ?").get(hash);
  return row ? JSON.parse(gunzipSync(row.data).toString("utf8")) : null;
}

const snapshotRow = (id) => db.prepare("SELECT * FROM library_snapshots WHERE id = ?").get(Number(id));
const latestFor = (username) =>
  db.prepare("SELECT * FROM library_snapshots WHERE username = ? ORDER BY taken_at DESC, id DESC LIMIT 1").get(username);

async function readEverything(user, deps) {
  const sections = {};
  for (const section of SECTIONS) sections[section] = await deps.read[section](user);
  return sections;
}

/**
 * Take a snapshot of one person's library now. One that matches the last
 * exactly still gets a row - a few bytes, since its parts are stored already -
 * so the list says plainly that nothing changed that day, and the daily check
 * knows it has looked.
 */
export async function takeSnapshot(user, { reason = "daily", deps = defaultHistoryDeps, now = Date.now() } = {}) {
  const sections = await readEverything(user, deps);
  const parts = {};
  for (const section of SECTIONS) parts[section] = storePart(section, sections[section]);
  const previous = latestFor(user.username);
  const { lastInsertRowid: id } = db.prepare(
    "INSERT INTO library_snapshots (username, taken_at, reason, parts_json) VALUES (?, ?, ?, ?)",
  ).run(user.username, now, reason, JSON.stringify(parts));
  return { id: Number(id), unchanged: Boolean(previous && previous.parts_json === JSON.stringify(parts)), sections };
}

/**
 * Keep the last 30 days, and the newest snapshot of each month for a year;
 * never the newest one of all. Parts no snapshot uses any more go too.
 */
export function pruneSnapshots({ now = Date.now() } = {}) {
  const rows = db.prepare("SELECT id, username, taken_at FROM library_snapshots ORDER BY username, taken_at DESC, id DESC").all();
  const keep = new Set();
  const newest = new Map();
  const monthly = new Map();
  for (const row of rows) {
    if (!newest.has(row.username)) {
      newest.set(row.username, row.id);
      keep.add(row.id);
    }
    if (now - row.taken_at <= DAILY_DAYS * DAY) keep.add(row.id);
    const date = new Date(row.taken_at);
    const month = `${row.username}|${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (now - row.taken_at <= MONTHLY_MONTHS * 31 * DAY && !monthly.has(month)) {
      monthly.set(month, row.id);
      keep.add(row.id);
    }
  }
  const drop = rows.filter((row) => !keep.has(row.id)).map((row) => row.id);
  db.transaction(() => {
    const remove = db.prepare("DELETE FROM library_snapshots WHERE id = ?");
    for (const id of drop) remove.run(id);
    const used = new Set(db.prepare("SELECT parts_json FROM library_snapshots").all()
      .flatMap((row) => Object.values(JSON.parse(row.parts_json))));
    const dropPart = db.prepare("DELETE FROM library_snapshot_parts WHERE hash = ?");
    for (const { hash } of db.prepare("SELECT hash FROM library_snapshot_parts").all()) {
      if (!used.has(hash)) dropPart.run(hash);
    }
  })();
  return { removed: drop.length };
}

// ---------------------------------------------------------------- what changed

function comparePlaylists(then, now) {
  const before = new Map(then.map((playlist) => [playlist.name, playlist]));
  const after = new Map(now.map((playlist) => [playlist.name, playlist]));
  const changes = [];
  for (const [name, old] of before) {
    const current = after.get(name);
    if (!current) {
      changes.push({ name, change: "gone", kind: old.kind, songs: old.songs?.length ?? null });
      continue;
    }
    if (old.kind !== current.kind || JSON.stringify(old.rules ?? null) !== JSON.stringify(current.rules ?? null)) {
      changes.push({ name, change: old.kind === "list" ? "kind" : "rules", kind: old.kind });
      continue;
    }
    if (old.kind === "list" && JSON.stringify(old.songs) !== JSON.stringify(current.songs)) {
      const had = new Set(old.songs);
      const has = new Set(current.songs);
      changes.push({
        name,
        change: "songs",
        kind: "list",
        removed: old.songs.filter((path) => !has.has(path)).length,
        added: current.songs.filter((path) => !had.has(path)).length,
        then: old.songs.length,
        now: current.songs.length,
      });
    } else if (old.folder !== current.folder) {
      changes.push({ name, change: "folder", kind: old.kind, then: old.folder, now: current.folder });
    }
  }
  for (const [name, current] of after) {
    if (!before.has(name)) changes.push({ name, change: "new", kind: current.kind, songs: current.songs?.length ?? null });
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}

function compareRatings(then, now) {
  let changed = 0;
  let cleared = 0;
  let added = 0;
  for (const [path, rating] of Object.entries(then)) {
    if (!now[path]) cleared += 1;
    else if (now[path] !== rating) changed += 1;
  }
  for (const path of Object.keys(now)) if (!then[path]) added += 1;
  return { changed, cleared, added, total: changed + cleared + added };
}

function compareFavourites(then, now) {
  const before = new Set(then);
  const after = new Set(now);
  return {
    removed: then.filter((id) => !after.has(id)).length,
    added: now.filter((id) => !before.has(id)).length,
  };
}

function compareTags(then, now) {
  const tally = (rows) => {
    const counts = new Map();
    for (const tags of Object.values(rows)) for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    return counts;
  };
  let songs = 0;
  for (const id of new Set([...Object.keys(then.tracks), ...Object.keys(now.tracks)])) {
    if (JSON.stringify([...(then.tracks[id] || [])].sort()) !== JSON.stringify([...(now.tracks[id] || [])].sort())) songs += 1;
  }
  let albums = 0;
  for (const id of new Set([...Object.keys(then.albums), ...Object.keys(now.albums)])) {
    if (JSON.stringify([...(then.albums[id] || [])].sort()) !== JSON.stringify([...(now.albums[id] || [])].sort())) albums += 1;
  }
  const before = tally(then.tracks);
  const after = tally(now.tracks);
  const tags = [];
  for (const tag of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(tag) || 0) - (before.get(tag) || 0);
    if (delta) tags.push({ tag: tag.startsWith("-") ? `not ${tag.slice(1)}` : tag, then: before.get(tag) || 0, now: after.get(tag) || 0 });
  }
  tags.sort((a, b) => Math.abs(b.now - b.then) - Math.abs(a.now - a.then) || a.tag.localeCompare(b.tag));
  return { songs, albums, tags: tags.slice(0, 20), moreTags: Math.max(0, tags.length - 20) };
}

function compareLibrary(then, now) {
  const mbids = (side) => new Set(side.artists.map((artist) => artist.mbid));
  const before = mbids(then);
  const after = mbids(now);
  return {
    artistsRemoved: then.artists.filter((artist) => !after.has(artist.mbid)).map((artist) => artist.name),
    artistsAdded: now.artists.filter((artist) => !before.has(artist.mbid)).map((artist) => artist.name),
    albumsRemoved: then.albums.filter((folder) => !now.albums.includes(folder)),
    albumsAdded: now.albums.filter((folder) => !then.albums.includes(folder)),
  };
}

const COMPARE = {
  playlists: comparePlaylists,
  ratings: compareRatings,
  favourites: compareFavourites,
  tags: compareTags,
  library: compareLibrary,
};

/** What is different now from one snapshot, section by section. */
/**
 * A snapshot's songs as they would be named after files moved: each path in
 * the map stands for the one it moved to. Ratings and playlists are kept by
 * path, so a move - Lidarr renaming a folder, files imported into their
 * artist's folder - would otherwise read as everything taken out and
 * something new put in. Favourites, tags and the library are kept by what the
 * music is, not where, and pass through.
 */
export function movedPaths(section, then, pathMap) {
  if (!pathMap?.size || then == null) return then;
  const to = (songPath) => pathMap.get(songPath) || songPath;
  if (section === "ratings") return Object.fromEntries(Object.entries(then).map(([songPath, rating]) => [to(songPath), rating]));
  if (section === "playlists") {
    return then.map((playlist) => (playlist.songs ? { ...playlist, songs: playlist.songs.map(to) } : playlist));
  }
  return then;
}

export async function compareWithNow(user, snapshotId, { deps = defaultHistoryDeps, pathMap = null } = {}) {
  const row = snapshotRow(snapshotId);
  if (!row || row.username !== user.username) throw new LibraryHistoryError("No such snapshot", 404);
  const parts = JSON.parse(row.parts_json);
  const now = await readEverything(user, deps);
  const differences = {};
  for (const section of SECTIONS) {
    const then = movedPaths(section, loadPart(parts[section]), pathMap);
    differences[section] = then == null ? null : COMPARE[section](then, now[section]);
  }
  return { snapshot: describe(row), differences };
}

function describe(row) {
  const parts = JSON.parse(row.parts_json);
  const sizes = db.prepare(
    `SELECT section, length(data) AS bytes FROM library_snapshot_parts WHERE hash IN (${Object.values(parts).map(() => "?").join(",")})`,
  ).all(...Object.values(parts));
  return {
    id: row.id,
    takenAt: row.taken_at,
    reason: row.reason,
    bytes: sizes.reduce((sum, part) => sum + part.bytes, 0),
  };
}

/** Someone's snapshots, newest first, and which parts each changed from the one before. */
export function listSnapshots(username) {
  const rows = db.prepare("SELECT * FROM library_snapshots WHERE username = ? ORDER BY taken_at DESC, id DESC").all(username);
  return rows.map((row, index) => {
    const parts = JSON.parse(row.parts_json);
    const older = rows[index + 1] ? JSON.parse(rows[index + 1].parts_json) : null;
    return {
      ...describe(row),
      changed: older ? SECTIONS.filter((section) => parts[section] !== older[section]) : SECTIONS,
    };
  });
}

/** How much room everyone's snapshots take, stored once per distinct part. */
export function snapshotStorage() {
  const row = db.prepare("SELECT COUNT(*) AS parts, COALESCE(SUM(length(data)), 0) AS bytes FROM library_snapshot_parts").get();
  return { parts: row.parts, bytes: row.bytes };
}

// ---------------------------------------------------------------- putting back

async function songIdsForPaths(user, paths) {
  const { resolveCopiesForUser } = await import("./socialService.js");
  // Their own copy first, then the main library's - which is where most of a
  // playlist's songs point once Psalter has normalised it. Leaving out a song
  // they could not open themselves would take it out of the playlist.
  return resolveCopiesForUser({ username: user.username, paths, canonicalAlways: true });
}

// Rewriting goes through the one place that does it safely; exported here too
// for the tests that pin the restore's behaviour.
export { rewritePlaylistEntries } from "./navidromePlaylistWrites.js";

async function restorePlaylists(user, playlists, names) {
  const { createNavidromeUserClient } = await import("./navidromeUserClient.js");
  const { getAdminNavidromeClient } = await import("./navidromeTrackResolver.js");
  const tagPlaylists = await import("./tagPlaylistService.js");
  const { setPlaylistFolder } = await import("./navidromePlaylistFolders.js");
  const { rewritePlaylistEntries } = await import("./navidromePlaylistWrites.js");
  const client = createNavidromeUserClient(user);
  const admin = getAdminNavidromeClient();
  const wanted = playlists.filter((playlist) => names.includes(playlist.name));
  const current = (await client.getSubsonicPlaylists()).filter((playlist) => playlist.owner === client.user);
  const records = new Map((await admin.getPlaylistRecords()).map((record) => [String(record.id), record]));
  const results = [];
  for (const entry of wanted) {
    const existing = current.find((playlist) => playlist.name === entry.name) || null;
    const existingId = existing ? String(existing.id) : null;
    const keptNow = existingId ? tagPlaylists.keptPlaylistFor(client.user, existingId) : null;
    const smartNow = existingId ? Boolean(records.get(existingId)?.rules) : false;
    let playlistId = existingId;
    let missing = 0;

    if (entry.kind === "list") {
      const copies = await songIdsForPaths(user, entry.songs);
      const songIds = entry.songs.map((path) => copies.get(path)).filter(Boolean);
      missing = entry.songs.length - songIds.length;
      if (keptNow) tagPlaylists.forgetKept(keptNow);
      if (smartNow) {
        // Navidrome will not take songs into a playlist it keeps by rules.
        await client.deletePlaylist(existingId);
        playlistId = null;
      }
      // Made empty and then filled: a long list of songs does not fit in the
      // one request that creates a playlist.
      if (!playlistId) playlistId = (await client.createPlaylist(entry.name, []))?.id || null;
      if (playlistId) await rewritePlaylistEntries(admin, playlistId, songIds);
    } else if (entry.kind === "smart") {
      if (keptNow) tagPlaylists.forgetKept(keptNow);
      if (!playlistId) playlistId = (await client.createPlaylist(entry.name, []))?.id || null;
      if (playlistId) await admin.setPlaylistRules(playlistId, { name: entry.name, rules: entry.rules });
    } else if (entry.kind === "kept") {
      if (keptNow) {
        await tagPlaylists.updateKeptRules(keptNow, entry.rules);
      } else {
        if (smartNow) {
          await client.deletePlaylist(existingId);
          playlistId = null;
        }
        if (playlistId) {
          // Keep it under its present id: Psalter writes into it from here on.
          const at = Date.now();
          db.prepare(`
            INSERT INTO tag_playlists (owner, name, rules_json, enabled, made_here, navidrome_playlist_id, created_at, updated_at)
            VALUES (?, ?, ?, 1, 1, ?, ?, ?)
            ON CONFLICT (owner, name) DO UPDATE SET rules_json = excluded.rules_json, enabled = 1,
              navidrome_playlist_id = excluded.navidrome_playlist_id, updated_at = excluded.updated_at
          `).run(client.user, entry.name, JSON.stringify(entry.rules), playlistId, at, at);
          const { id } = db.prepare("SELECT id FROM tag_playlists WHERE owner = ? AND name = ?").get(client.user, entry.name);
          await tagPlaylists.buildTagPlaylist(id);
        } else {
          playlistId = (await tagPlaylists.createKeptPlaylist({ owner: client.user, name: entry.name, rules: entry.rules })).playlistId;
        }
      }
    }
    if (playlistId && entry.folder) setPlaylistFolder(user.id, playlistId, entry.folder);
    results.push({ name: entry.name, restored: Boolean(playlistId), missing });
  }
  return results;
}

async function restoreRatings(user, then) {
  const { createNavidromeUserClient } = await import("./navidromeUserClient.js");
  const { getAdminNavidromeClient } = await import("./navidromeTrackResolver.js");
  const { forgetUserTrackRatings } = await import("./navidromeUserRatings.js");
  const { normalizePath } = await import("./navidromePathMapping.js");
  const now = await readRatings(user);
  const client = createNavidromeUserClient(user);
  const admin = getAdminNavidromeClient();
  const changes = [];
  for (const [path, rating] of Object.entries(then)) if (now[path] !== rating) changes.push([path, rating]);
  for (const path of Object.keys(now)) if (!then[path]) changes.push([path, 0]);
  let written = 0;
  let notFound = 0;
  for (const [path, rating] of changes) {
    // Every copy of the file they can reach, as a rating set by hand is.
    const copies = (await admin.findSongsByPath(path)).filter((song) => normalizePath(song?.path) === path);
    let any = false;
    for (const song of copies) {
      try {
        await client.setRating(song.id, rating);
        any = true;
      } catch {
        // A copy in someone else's personal library is refused, as it should be.
      }
    }
    if (any) written += 1;
    else notFound += 1;
  }
  forgetUserTrackRatings(client.user);
  const { scheduleTagPlaylistRebuild } = await import("./tagPlaylistService.js");
  scheduleTagPlaylistRebuild(user.username, { reason: "ratings restored", fresh: true });
  return { changed: written, notFound };
}

async function restoreFavourites(user, then) {
  const { starMany, unstarMany } = await import("./subsonicLibraryService.js");
  const { mirrorFavoritesToNavidrome } = await import("./navidromeAnnotations.js");
  const now = await readFavourites(user);
  const add = then.filter((id) => !now.includes(id));
  const remove = now.filter((id) => !then.includes(id));
  if (add.length) {
    starMany(user, add, { skipCanonicalValidation: true });
    await mirrorFavoritesToNavidrome(user, add, true).catch(() => {});
  }
  if (remove.length) {
    unstarMany(user, remove);
    await mirrorFavoritesToNavidrome(user, remove, false).catch(() => {});
  }
  return { added: add.length, removed: remove.length };
}

async function restoreTags(user, then) {
  const { writeOwnTagRows } = await import("./trackTagService.js");
  writeOwnTagRows(user.username, then);
  return { songs: Object.keys(then.tracks).length, albums: Object.keys(then.albums).length };
}

async function restoreLibrary(user, then) {
  if (!then.enabled) return { skipped: true };
  const {
    setUserLibraryMembership, listUserLibraryAlbums, addUserLibraryAlbums, removeUserLibraryAlbums,
  } = await import("./userLibraryService.js");
  const now = await readLibrary(user);
  const had = new Set(then.artists.map((artist) => artist.mbid));
  const has = new Set(now.artists.map((artist) => artist.mbid));
  const add = [...had].filter((mbid) => !has.has(mbid));
  const remove = [...has].filter((mbid) => !had.has(mbid));
  if (add.length) await setUserLibraryMembership(user, add, true);
  if (remove.length) await setUserLibraryMembership(user, remove, false);
  const albumsNow = listUserLibraryAlbums(user.username).map((album) => album.folder);
  const albumsAdd = then.albums.filter((folder) => !albumsNow.includes(folder));
  const albumsRemove = albumsNow.filter((folder) => !then.albums.includes(folder));
  if (albumsAdd.length) addUserLibraryAlbums(user.username, albumsAdd, "a restored snapshot");
  if (albumsRemove.length) removeUserLibraryAlbums(user.username, albumsRemove);
  return { artistsAdded: add.length, artistsRemoved: remove.length, albumsAdded: albumsAdd.length, albumsRemoved: albumsRemove.length };
}

export const defaultRestoreDeps = {
  playlists: restorePlaylists,
  ratings: restoreRatings,
  favourites: restoreFavourites,
  tags: restoreTags,
  library: restoreLibrary,
};

/**
 * Put parts of a snapshot back. A snapshot of how things are now is taken
 * first, so the restore itself can be undone. `playlists` names which ones;
 * the other sections are all or nothing.
 */
export async function restoreSnapshot(user, snapshotId, {
  sections = [],
  playlists = [],
  deps = defaultHistoryDeps,
  restore = defaultRestoreDeps,
  // Old path -> new, for files that have moved since: see movedPaths.
  pathMap = null,
} = {}) {
  const row = snapshotRow(snapshotId);
  if (!row || row.username !== user.username) throw new LibraryHistoryError("No such snapshot", 404);
  const chosen = sections.filter((section) => SECTIONS.includes(section));
  if (!chosen.length) throw new LibraryHistoryError("Choose something to restore");
  if (chosen.includes("playlists") && !playlists.length) throw new LibraryHistoryError("Choose which playlists to restore");

  const before = await takeSnapshot(user, { reason: "before restore", deps });
  const parts = JSON.parse(row.parts_json);
  const results = {};
  for (const section of chosen) {
    const then = movedPaths(section, loadPart(parts[section]), pathMap);
    if (then == null) {
      results[section] = { skipped: true };
      continue;
    }
    results[section] = section === "playlists"
      ? await restore.playlists(user, then, playlists)
      : await restore[section](user, then);
  }
  logger.info("library", `[History] Restored ${chosen.join(", ")} for ${user.username} from snapshot ${row.id}`);
  return { restoredFrom: row.id, undoSnapshot: before.id, results };
}

// ---------------------------------------------------------------- daily

let timer = null;

/** Everyone whose last snapshot is a day old, or who has none, gets one. */
export async function snapshotEveryoneDue({ deps = defaultHistoryDeps, now = Date.now() } = {}) {
  const taken = [];
  for (const user of userOps.getAllUsers()) {
    const last = latestFor(user.username);
    if (last && now - last.taken_at < DAY) continue;
    try {
      const result = await takeSnapshot(user, { reason: "daily", deps, now });
      taken.push({ username: user.username, unchanged: result.unchanged });
    } catch (error) {
      logger.warn("library", `[History] Could not take ${user.username}'s snapshot: ${error.message}`);
    }
  }
  pruneSnapshots({ now });
  return taken;
}

export function startLibraryHistory({ intervalMs = CHECK_EVERY_MS } = {}) {
  if (timer) return;
  const run = () => snapshotEveryoneDue().catch((error) => {
    logger.warn("library", `[History] Daily snapshots failed: ${error.message}`);
  });
  // Not straight away: the server has enough to do on starting.
  setTimeout(run, 10 * 60 * 1000).unref?.();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
}

export function stopLibraryHistory() {
  if (timer) clearInterval(timer);
  timer = null;
}
