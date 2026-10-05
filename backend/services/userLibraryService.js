import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { dbOps, userOps } from "../db/helpers/index.js";
import { lidarrClient } from "./lidarrClient.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import { NavidromeClient } from "./navidrome.js";
import {
  getCanonicalAlbumCountsByArtistMbid,
  getCanonicalArtistProjection,
  getCanonicalNewlyAvailableAlbums,
} from "./libraryQueryService.js";
import { logger } from "./logger.js";
import { getNavidromeRootMapping, isPlaylistNormalizeEnabled } from "../config/featureFlags.js";
import { db } from "../config/db-sqlite.js";

const RECONCILE_DEBOUNCE_MS = 3000;
const RECONCILE_STARTUP_DELAY_MS = 20000;
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NEW_TO_SERVER_DEFAULT_DAYS = 90;
const NEW_TO_SERVER_MAX_DAYS = 365;
const NEW_TO_SERVER_DEFAULT_LIMIT = 24;
const NEW_TO_SERVER_MAX_LIMIT = 60;

let reconcileTimer = null;
let periodicTimer = null;
let startupTimer = null;
let reconcileInFlight = null;
let reconcileQueued = false;

const cleanRootPath = (value) => String(value || "").trim().replace(/[\\/]+$/, "");

export function getUserLibrariesSettings(settings = null) {
  const current = settings || dbOps.getSettings();
  const config = current?.userLibraries || {};
  return {
    enabled: config.enabled === true,
    rootPath: cleanRootPath(config.rootPath),
    // Create/assign a Navidrome library per user folder from the reconciler.
    manageNavidrome: config.manageNavidrome !== false,
    // The libraries folder as Navidrome sees it; blank means same path as Psalter.
    navidromeRootPath: cleanRootPath(config.navidromeRootPath),
    // Compilations are picked one album at a time rather than taken whole
    // with the Various Artists folder. Off until each person's picks have been
    // seeded, so turning it on never takes compilations away from anyone.
    compilationsByAlbum: config.compilationsByAlbum === true,
  };
}

export function normalizeUserLibrariesSettings(input, existing = {}) {
  const pick = (key, fallback) => (input?.[key] !== undefined ? input[key] : existing?.[key] ?? fallback);
  return {
    enabled: pick("enabled", false) === true,
    rootPath: cleanRootPath(pick("rootPath", "")),
    manageNavidrome: pick("manageNavidrome", true) !== false,
    navidromeRootPath: cleanRootPath(pick("navidromeRootPath", "")),
    compilationsByAlbum: pick("compilationsByAlbum", false) === true,
  };
}

export function sanitizeUserFolderName(username, userId = null) {
  const cleaned = String(username || "")
    .trim()
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^\.+/, "")
    .trim();
  if (cleaned) return cleaned;
  return userId != null ? `user-${userId}` : null;
}

export function getUserLibraryDir(username, userId = null, settings = null) {
  const config = getUserLibrariesSettings(settings);
  if (!config.rootPath) return null;
  const folderName = sanitizeUserFolderName(username, userId);
  if (!folderName) return null;
  return path.join(config.rootPath, folderName);
}

const getUserTagLabel = (username) => String(username || "").trim().toLowerCase();

// MusicBrainz's Various Artists. Everything filed under it is a compilation,
// and nobody wants all of them, so once compilations are picked by album it is
// never part of a personal library whole - whatever Lidarr's tags say.
export const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

export function isWholeArtistAllowed(mbid, settings = null) {
  return !(getUserLibrariesSettings(settings).compilationsByAlbum
    && String(mbid || "").toLowerCase() === VARIOUS_ARTISTS_MBID);
}

const holdsWhole = (artist, tagId, settings = null) =>
  artistHasTag(artist, tagId) && isWholeArtistAllowed(artist?.foreignArtistId, settings);

function artistHasTag(artist, tagId) {
  return Array.isArray(artist?.tags) && artist.tags.some((id) => Number(id) === Number(tagId));
}

const buildTagLabelsById = (tagsRaw) =>
  new Map(
    (Array.isArray(tagsRaw) ? tagsRaw : [])
      .filter((tag) => tag && typeof tag.label === "string")
      .map((tag) => [Number(tag.id), tag.label.trim().toLowerCase()]),
  );

// Maps a Lidarr artist's tag ids to the Psalter usernames whose personal
// libraries include it. Returns [labels, libraries].
function resolveArtistLibraries(artist, tagLabelsById, userTags) {
  const labels = (Array.isArray(artist?.tags) ? artist.tags : [])
    .map((id) => tagLabelsById.get(Number(id)))
    .filter(Boolean);
  const libraries = labels.filter((label) => userTags.has(label)).map((label) => userTags.get(label));
  return [labels, libraries];
}

const buildUserTags = (usernames) =>
  new Map(
    usernames
      .map((username) => [getUserTagLabel(username), username])
      .filter(([label]) => label),
  );

function mapMemberArtist(artist) {
  return {
    mbid: artist.foreignArtistId || null,
    artistId: artist.id,
    artistName: artist.artistName || null,
    folderName: artist.path ? path.basename(String(artist.path).replace(/[\\/]+$/, "")) : null,
  };
}

async function requireConfiguredLidarr() {
  if (!lidarrClient || !lidarrClient.isConfigured()) {
    const error = new Error("Lidarr is not configured");
    error.statusCode = 503;
    throw error;
  }
  return lidarrClient;
}

export async function getUserLibraryMembership(user, { forceRefresh = false } = {}) {
  const config = getUserLibrariesSettings();
  if (!config.enabled) return { enabled: false, artists: [] };
  const lidarr = await requireConfiguredLidarr();
  const tagId = await lidarr.findTagId(getUserTagLabel(user.username));
  if (tagId === null) return { enabled: true, artists: [] };
  const artists = await lidarr.listArtists({ forceRefresh });
  return {
    enabled: true,
    artists: artists.filter((artist) => holdsWhole(artist, tagId)).map(mapMemberArtist),
  };
}

// Narrow a list of Lidarr artists to the ones in this user's personal library.
// Returns the list untouched when personal libraries are off, so callers can
// apply it unconditionally. Artists carry their own tags, so this needs one
// tag lookup rather than a per-artist check.
export async function filterArtistsToUserLibrary(artists, user) {
  const list = Array.isArray(artists) ? artists : [];
  const config = getUserLibrariesSettings();
  if (!config.enabled || !user?.username) return list;
  try {
    const lidarr = await requireConfiguredLidarr();
    const tagId = await lidarr.findTagId(getUserTagLabel(user.username));
    if (tagId === null) return [];
    // Match on MBID rather than tags: callers pass aurral's normalized artists,
    // which carry no tag field, and Lidarr artists match on the same id anyway.
    const memberMbids = new Set(
      (await lidarr.listArtists())
        .filter((artist) => holdsWhole(artist, tagId))
        .map((artist) => String(artist.foreignArtistId || ""))
        .filter(Boolean),
    );
    if (!memberMbids.size) return [];
    return list.filter((artist) =>
      memberMbids.has(String(artist.foreignArtistId || artist.mbid || "")),
    );
  } catch (error) {
    logger.warn("library", `[UserLibraries] Could not filter to personal library: ${error.message}`);
    return list;
  }
}

// The viewer's personal library as canonical artists, for the Discover
// sections that are seeded from "the library" (releases, shows, genres).
// Returns null when personal libraries are off so callers keep their existing
// whole-library behaviour instead of silently narrowing to nothing.
export async function scopeCanonicalArtistsToUser(user) {
  const config = getUserLibrariesSettings();
  if (!config.enabled || !user?.username) return null;
  try {
    const lidarr = await requireConfiguredLidarr();
    const tagId = await lidarr.findTagId(getUserTagLabel(user.username));
    if (tagId === null) return [];
    const mbids = (await lidarr.listArtists())
      .filter((artist) => holdsWhole(artist, tagId))
      .map((artist) => String(artist.foreignArtistId || ""))
      .filter(Boolean);
    if (!mbids.length) return [];
    return getCanonicalArtistProjection({ mbids });
  } catch (error) {
    logger.warn("library", `[UserLibraries] Could not scope artists: ${error.message}`);
    return null;
  }
}

export async function setUserLibraryMembership(user, mbids, member) {
  const config = getUserLibrariesSettings();
  if (!config.enabled) {
    const error = new Error("User libraries are not enabled");
    error.statusCode = 400;
    throw error;
  }
  const lidarr = await requireConfiguredLidarr();
  const requested = (Array.isArray(mbids) ? mbids : [mbids])
    .map((mbid) => String(mbid || "").trim())
    .filter(Boolean);
  if (!requested.length) {
    const error = new Error("No artist MBIDs provided");
    error.statusCode = 400;
    throw error;
  }

  const tagId = member
    ? await lidarr.ensureUserTag(user.username)
    : await lidarr.findTagId(getUserTagLabel(user.username));
  if (tagId === null) {
    if (!member) return { changed: [], missing: [] };
    const error = new Error("Could not resolve a Lidarr tag for this user");
    error.statusCode = 502;
    throw error;
  }

  const artists = await lidarr.listArtists();
  const byMbid = new Map(
    artists
      .filter((artist) => artist?.foreignArtistId)
      .map((artist) => [String(artist.foreignArtistId), artist]),
  );

  const missing = [];
  const refused = [];
  const targets = [];
  for (const mbid of requested) {
    const artist = byMbid.get(mbid);
    if (!artist) {
      missing.push(mbid);
      continue;
    }
    // Compilations are added one at a time; taking the tag off is still fine.
    if (member && !isWholeArtistAllowed(mbid)) {
      refused.push(mbid);
      continue;
    }
    if (artistHasTag(artist, tagId) !== member) {
      targets.push(artist);
    }
  }

  if (targets.length) {
    await lidarr.updateArtistsTags(
      targets.map((artist) => artist.id),
      [tagId],
      member ? "add" : "remove",
    );
    scheduleUserLibraryReconcile();
  }

  return {
    changed: targets.map(mapMemberArtist),
    missing,
    refused,
  };
}

// Every Lidarr artist with the viewer's membership and which other users hold
// it, for the bulk add/remove page. Pure so it can be tested without Lidarr.
export function selectUserLibraryCatalog({
  lidarrArtists = [],
  tagLabelsById = new Map(),
  usernames = [],
  viewerUsername = "",
  albumCountsByMbid = new Map(),
  compilationsByAlbum = false,
} = {}) {
  const viewerTag = getUserTagLabel(viewerUsername);
  const userTags = buildUserTags(usernames);
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  return lidarrArtists
    .filter((artist) => artist?.foreignArtistId)
    // Its albums are listed one by one under Compilations instead.
    .filter((artist) => !compilationsByAlbum || String(artist.foreignArtistId).toLowerCase() !== VARIOUS_ARTISTS_MBID)
    .map((artist) => {
      const [labels, libraries] = resolveArtistLibraries(artist, tagLabelsById, userTags);
      const stats = artist.statistics || {};
      return {
        mbid: artist.foreignArtistId,
        artistId: artist.id,
        artistName: artist.artistName || "",
        sortName: artist.sortName || artist.artistName || "",
        albumCount: Number(stats.albumCount) || 0,
        libraryAlbumCount: albumCountsByMbid.get(String(artist.foreignArtistId)) || 0,
        trackFileCount: Number(stats.trackFileCount) || 0,
        added: artist.added || null,
        inLibrary: !!viewerTag && labels.includes(viewerTag),
        libraries: libraries.filter((username) => getUserTagLabel(username) !== viewerTag),
      };
    })
    .sort((a, b) => collator.compare(a.sortName, b.sortName));
}

export async function getUserLibraryCatalog(user) {
  const config = getUserLibrariesSettings();
  if (!config.enabled) return { enabled: false, artists: [] };
  const lidarr = await requireConfiguredLidarr();
  const [tagsRaw, lidarrArtists] = await Promise.all([lidarr.getTags(), lidarr.listArtists()]);
  return {
    enabled: true,
    artists: selectUserLibraryCatalog({
      lidarrArtists,
      tagLabelsById: buildTagLabelsById(tagsRaw),
      usernames: userOps.getAllUsers().map((entry) => entry.username),
      viewerUsername: user?.username,
      albumCountsByMbid: getCanonicalAlbumCountsByArtistMbid(),
      compilationsByAlbum: config.compilationsByAlbum,
    }),
  };
}

// Pure selection so the filtering rules can be unit-tested without Lidarr:
// keep albums whose artist is in Lidarr but not tagged for the viewer, and
// annotate each with the other users whose personal libraries hold it.
export function selectNewToServerAlbums({
  albums = [],
  lidarrArtists = [],
  tagLabelsById = new Map(),
  usernames = [],
  viewerUsername = "",
  limit = NEW_TO_SERVER_DEFAULT_LIMIT,
} = {}) {
  const viewerTag = getUserTagLabel(viewerUsername);
  const userTags = buildUserTags(usernames);
  const artistsByMbid = new Map();
  for (const artist of lidarrArtists) {
    const mbid = String(artist?.foreignArtistId || "").trim();
    if (mbid) artistsByMbid.set(mbid, artist);
  }

  const results = [];
  for (const album of albums) {
    const artist =
      artistsByMbid.get(String(album?.foreignArtistId || "").trim()) ||
      artistsByMbid.get(String(album?.artistMbid || "").trim());
    if (!artist) continue;
    const [labels, libraries] = resolveArtistLibraries(artist, tagLabelsById, userTags);
    if (viewerTag && labels.includes(viewerTag)) continue;
    results.push({
      ...album,
      artistMbid: artist.foreignArtistId,
      foreignArtistId: artist.foreignArtistId,
      artistName: album.artistName || artist.artistName,
      libraries,
    });
    if (results.length >= limit) break;
  }
  return results;
}

export async function getNewToServer(user, { days, limit } = {}) {
  const config = getUserLibrariesSettings();
  if (!config.enabled) return { enabled: false, albums: [] };
  if (!lidarrClient || !lidarrClient.isConfigured()) return { enabled: true, albums: [] };

  const windowDays = Math.min(
    NEW_TO_SERVER_MAX_DAYS,
    Math.max(1, Number.parseInt(days, 10) || NEW_TO_SERVER_DEFAULT_DAYS),
  );
  const boundedLimit = Math.min(
    NEW_TO_SERVER_MAX_LIMIT,
    Math.max(1, Number.parseInt(limit, 10) || NEW_TO_SERVER_DEFAULT_LIMIT),
  );

  // Over-fetch so the viewer's own albums can be filtered out and still fill the rail.
  const albums = getCanonicalNewlyAvailableAlbums({
    since: Date.now() - windowDays * 24 * 60 * 60 * 1000,
    limit: boundedLimit * 4,
  });
  if (!albums.length) return { enabled: true, albums: [] };

  const [tagsRaw, lidarrArtists] = await Promise.all([
    lidarrClient.getTags(),
    lidarrClient.listArtists(),
  ]);

  return {
    enabled: true,
    albums: selectNewToServerAlbums({
      albums,
      lidarrArtists,
      tagLabelsById: buildTagLabelsById(tagsRaw),
      usernames: userOps.getAllUsers().map((entry) => entry.username),
      viewerUsername: user?.username,
      limit: boundedLimit,
    }),
  };
}

async function pruneStaleSymlinks(userDir, desired) {
  let changes = 0;
  let entries;
  try {
    entries = await fsp.readdir(userDir, { withFileTypes: true });
  } catch {
    return changes;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(userDir, entry.name);
    const target = desired.get(entry.name);
    if (target) {
      try {
        const currentTarget = path.resolve(userDir, await fsp.readlink(linkPath));
        // A link whose target has since been renamed or removed stays dangling
        // forever otherwise, and every scan reports it as an invalid symlink.
        if (currentTarget === path.resolve(target) && fs.existsSync(currentTarget)) continue;
      } catch {}
    }
    try {
      await fsp.unlink(linkPath);
      changes += 1;
      if (target) {
        // Still wanted, so it is rebuilt below once its target is back. Worth
        // logging: this is the line that accounts for a link a scanner has
        // been reporting as broken.
        desired.set(entry.name, target);
        logger.info("library", `[UserLibraries] Removed broken symlink ${linkPath}`);
      } else {
        logger.info("library", `[UserLibraries] Removed stale symlink ${linkPath}`);
      }
    } catch (error) {
      logger.warn("library", `[UserLibraries] Failed to remove symlink ${linkPath}: ${error.message}`);
    }
  }
  return changes;
}

// ---------------------------------------------------------------- single albums

/**
 * The unit a song is added to a personal library by: its album folder, the
 * first two segments of its path in the main library ("Artist/Album"). A disc
 * subfolder belongs to its album. A song sitting loose in an artist folder is
 * its own unit, since the folder above it is the whole artist.
 */
export function albumFolderOf(relativePath) {
  const parts = String(relativePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2 || parts.some((part) => part === "." || part === "..")) return null;
  return parts.slice(0, 2).join("/");
}

const musicRootOf = () => getNavidromeRootMapping()?.aurralRoot || null;

// A path in the main library as Psalter's index stores it, made relative.
function relativeToRoot(filePath, musicRoot) {
  const relative = path.relative(musicRoot, String(filePath || ""));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
}

// GLOB rather than LIKE: it is case-sensitive, so it can use the index on
// path, and folder names are full of the underscores LIKE treats as wildcards.
const globEscape = (value) => String(value).replace(/[[*?]/g, (char) => `[${char}]`);

/**
 * Where each album is now, by its MusicBrainz release group: the folder most
 * of its files are in. Lidarr decides where files live, so when it renames a
 * folder or settles on another edition, the album is still found.
 */
export function currentAlbumFolders(releaseGroupMbids, musicRoot = musicRootOf()) {
  const found = new Map();
  const wanted = [...new Set((releaseGroupMbids || []).map((mbid) => String(mbid || "").trim()).filter(Boolean))];
  if (!wanted.length || !musicRoot) return found;
  const files = db.prepare(`
    SELECT file.path FROM library_albums AS album
    JOIN library_media_files AS file ON file.album_id = album.id AND file.available = 1
    WHERE album.release_group_mbid = ?
  `);
  for (const mbid of wanted) {
    const counts = new Map();
    for (const row of files.all(mbid)) {
      const folder = albumFolderOf(relativeToRoot(row.path, musicRoot));
      if (folder) counts.set(folder, (counts.get(folder) || 0) + 1);
    }
    const [best] = [...counts].sort((a, b) => b[1] - a[1]);
    if (best) found.set(mbid, best[0]);
  }
  return found;
}

/**
 * The album a folder holds, when every file Lidarr knows in it belongs to one
 * album. A folder Lidarr knows nothing about has none, and keeps being found
 * by its path alone.
 */
export function releaseGroupsForFolders(folders, musicRoot = musicRootOf()) {
  const found = new Map();
  if (!musicRoot) return found;
  const albums = db.prepare(`
    SELECT DISTINCT album.release_group_mbid AS mbid
    FROM library_media_files AS file
    JOIN library_albums AS album ON album.id = file.album_id
    WHERE file.available = 1 AND (file.path = ? OR file.path GLOB ?)
  `);
  for (const folder of new Set(folders || [])) {
    const absolute = path.join(musicRoot, folder);
    const mbids = albums.all(absolute, `${globEscape(absolute)}/*`).map((row) => row.mbid);
    if (mbids.length === 1 && mbids[0]) found.set(folder, mbids[0]);
  }
  return found;
}

export function listUserLibraryAlbums(username) {
  return db.prepare(`
    SELECT entry.folder, entry.added_for AS addedFor, entry.added_at AS addedAt,
           entry.release_group_mbid AS releaseGroupMbid,
           EXISTS (
             SELECT 1 FROM library_albums AS album
             JOIN library_artists AS artist ON artist.id = album.artist_id
             WHERE album.release_group_mbid = entry.release_group_mbid AND lower(artist.mbid) = ?
           ) AS compilation
    FROM user_library_albums AS entry WHERE entry.username = ? ORDER BY entry.folder COLLATE NOCASE
  `).all(VARIOUS_ARTISTS_MBID, username).map((row) => ({ ...row, compilation: row.compilation === 1 }));
}

/**
 * Record albums as part of someone's library. Nothing reaches the disk until
 * the next reconcile; the caller decides whether to wait for one.
 */
export function addUserLibraryAlbums(username, folders, addedFor = null) {
  const wanted = [...new Set(folders || [])].filter((folder) => albumFolderOf(folder) === folder);
  const mbids = releaseGroupsForFolders(wanted);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO user_library_albums (username, folder, added_for, added_at, release_group_mbid)
    VALUES (?, ?, ?, ?, ?)
  `);
  const at = Date.now();
  let added = 0;
  db.transaction(() => {
    for (const folder of wanted) added += insert.run(username, folder, addedFor, at, mbids.get(folder) || null).changes;
  })();
  return added;
}

/**
 * Add albums by their MusicBrainz release group, which is how anything picked
 * from Lidarr's catalog is kept. An album with no files on the server cannot
 * be linked, and is reported back rather than recorded.
 */
export function addUserLibraryAlbumsByMbid(username, releaseGroupMbids, addedFor = null) {
  const folders = currentAlbumFolders(releaseGroupMbids);
  const insert = db.prepare(`
    INSERT INTO user_library_albums (username, folder, added_for, added_at, release_group_mbid)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (username, folder) DO UPDATE SET release_group_mbid = excluded.release_group_mbid
  `);
  const held = db.prepare("SELECT 1 FROM user_library_albums WHERE username = ? AND release_group_mbid = ?");
  const at = Date.now();
  let added = 0;
  const missing = [];
  db.transaction(() => {
    for (const mbid of new Set(releaseGroupMbids || [])) {
      const folder = folders.get(mbid);
      if (!folder) {
        missing.push(mbid);
        continue;
      }
      if (held.get(username, mbid)) continue;
      insert.run(username, folder, addedFor, at, mbid);
      added += 1;
    }
  })();
  if (added) scheduleUserLibraryReconcile();
  return { added, missing };
}

export function removeUserLibraryAlbums(username, folders) {
  const remove = db.prepare("DELETE FROM user_library_albums WHERE username = ? AND folder = ?");
  let removed = 0;
  db.transaction(() => {
    for (const folder of new Set(folders || [])) removed += remove.run(username, folder).changes;
  })();
  if (removed) scheduleUserLibraryReconcile();
  return removed;
}

export function removeUserLibraryAlbumsByMbid(username, releaseGroupMbids) {
  const remove = db.prepare("DELETE FROM user_library_albums WHERE username = ? AND release_group_mbid = ?");
  let removed = 0;
  db.transaction(() => {
    for (const mbid of new Set(releaseGroupMbids || [])) removed += remove.run(username, mbid).changes;
  })();
  if (removed) scheduleUserLibraryReconcile();
  return removed;
}

/** Give rows recorded by folder alone the album they hold, where it is known. */
export function backfillAlbumReleaseGroups(musicRoot = musicRootOf()) {
  const rows = db.prepare("SELECT DISTINCT folder FROM user_library_albums WHERE release_group_mbid IS NULL").all();
  if (!rows.length || !musicRoot) return 0;
  const found = releaseGroupsForFolders(rows.map((row) => row.folder), musicRoot);
  const update = db.prepare("UPDATE user_library_albums SET release_group_mbid = ? WHERE folder = ? AND release_group_mbid IS NULL");
  let changed = 0;
  db.transaction(() => {
    for (const [folder, mbid] of found) changed += update.run(mbid, folder).changes;
  })();
  return changed;
}

/**
 * Someone's single albums with the folder each one links to, or null when the
 * main library's location is not configured. Null is not "none": it leaves
 * the album folders on disk as they are rather than tearing them down.
 *
 * An album known by its release group is looked up where it is now, and the
 * row remembers the new folder; one Lidarr cannot place yet keeps its last.
 */
export function albumTargetsFor(username) {
  const rows = listUserLibraryAlbums(username);
  if (!rows.length) return [];
  const musicRoot = musicRootOf();
  if (!musicRoot) {
    logger.warn(
      "library",
      `[UserLibraries] ${username} has single albums, but AURRAL_NAVIDROME_MUSIC_ROOT is not set; leaving them as they are`,
    );
    return null;
  }
  const now = currentAlbumFolders(rows.map((row) => row.releaseGroupMbid), musicRoot);
  const move = db.prepare("UPDATE OR IGNORE user_library_albums SET folder = ? WHERE username = ? AND folder = ?");
  const drop = db.prepare("DELETE FROM user_library_albums WHERE username = ? AND folder = ?");
  const targets = new Map();
  for (const row of rows) {
    let folder = row.folder;
    const current = row.releaseGroupMbid ? now.get(row.releaseGroupMbid) : null;
    if (current && current !== folder) {
      // Two rows can arrive at one folder; the one already there stands.
      if (!move.run(current, username, folder).changes) drop.run(username, folder);
      logger.info("library", `[UserLibraries] ${username}'s ${folder} is now at ${current}`);
      folder = current;
    }
    targets.set(folder, path.join(musicRoot, folder));
  }
  return [...targets].map(([folder, target]) => ({ folder, target }));
}

/**
 * Every compilation on the server - an album Lidarr files under Various
 * Artists that has files - with whether the viewer has it and who else does.
 */
export function selectCompilationCatalog(viewerUsername) {
  const albums = db.prepare(`
    SELECT album.id, album.release_group_mbid AS mbid, album.title, album.release_date AS releaseDate,
           COUNT(DISTINCT file.track_id) AS trackCount
    FROM library_albums AS album
    JOIN library_artists AS artist ON artist.id = album.artist_id
    JOIN library_media_files AS file ON file.album_id = album.id AND file.available = 1
    WHERE lower(artist.mbid) = ? AND album.release_group_mbid IS NOT NULL
    GROUP BY album.id
  `).all(VARIOUS_ARTISTS_MBID);
  const holders = new Map();
  for (const row of db.prepare(`
    SELECT release_group_mbid AS mbid, username FROM user_library_albums WHERE release_group_mbid IS NOT NULL
  `).all()) {
    if (!holders.has(row.mbid)) holders.set(row.mbid, []);
    holders.get(row.mbid).push(row.username);
  }
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  return albums
    .map((album) => {
      const people = holders.get(album.mbid) || [];
      return {
        id: String(album.id),
        mbid: album.mbid,
        title: album.title,
        year: String(album.releaseDate || "").slice(0, 4) || null,
        trackCount: Number(album.trackCount) || 0,
        inLibrary: people.includes(viewerUsername),
        libraries: people.filter((name) => name !== viewerUsername),
      };
    })
    .sort((a, b) => collator.compare(a.title, b.title));
}

export function getCompilationCatalog(user) {
  const config = getUserLibrariesSettings();
  if (!config.enabled || !config.compilationsByAlbum) return { enabled: false, compilations: [] };
  return { enabled: true, compilations: selectCompilationCatalog(user?.username) };
}

// A folder Psalter made to hold single albums carries this file, so a folder
// anyone else put in a personal library is never mistaken for one and pruned.
const ALBUM_HOLDER_MARKER = ".psalter-albums";

function isAlbumHolder(dirPath) {
  return fs.existsSync(path.join(dirPath, ALBUM_HOLDER_MARKER));
}

// Remove the links in an album holder that are no longer wanted or no longer
// resolve, and the holder itself once nothing is left in it.
async function pruneAlbumHolder(dirPath, wanted) {
  let changes = 0;
  for (const entry of await fsp.readdir(dirPath, { withFileTypes: true })) {
    if (entry.name === ALBUM_HOLDER_MARKER || !entry.isSymbolicLink()) continue;
    const linkPath = path.join(dirPath, entry.name);
    const target = wanted?.get(entry.name);
    if (target) {
      try {
        const current = path.resolve(dirPath, await fsp.readlink(linkPath));
        if (current === path.resolve(target) && fs.existsSync(current)) continue;
      } catch {}
    }
    try {
      await fsp.unlink(linkPath);
      changes += 1;
      logger.info("library", `[UserLibraries] Removed album link ${linkPath}`);
    } catch (error) {
      logger.warn("library", `[UserLibraries] Failed to remove album link ${linkPath}: ${error.message}`);
    }
  }
  const left = (await fsp.readdir(dirPath)).filter((name) => name !== ALBUM_HOLDER_MARKER);
  if (!left.length) {
    await fsp.unlink(path.join(dirPath, ALBUM_HOLDER_MARKER)).catch(() => {});
    await fsp.rmdir(dirPath).catch(() => {});
  }
  return changes;
}

export async function materializeUserLibrary(userDir, memberArtists, mappings, albums = []) {
  let changes = 0;
  await fsp.mkdir(userDir, { recursive: true });

  const desired = new Map();
  for (const artist of memberArtists) {
    const remotePath = String(artist?.path || "").trim();
    if (!remotePath) continue;
    const localPath = resolveLocalPath(remotePath, mappings);
    const linkName = path.basename(localPath.replace(/[\\/]+$/, ""));
    if (!linkName || linkName === "." || linkName === "..") continue;
    // A target inside the farm itself would produce a symlink pointing at its
    // own path - "Geologist" -> "Geologist" - which resolves forever and makes
    // a scanner give up with ELOOP. It means Lidarr's artist path is already
    // inside a personal library, so there is nothing here worth linking.
    const relativeToUserDir = path.relative(userDir, localPath);
    if (relativeToUserDir && !relativeToUserDir.startsWith("..") && !path.isAbsolute(relativeToUserDir)) {
      logger.warn(
        "library",
        `[UserLibraries] Skipping ${localPath}: artist folder is inside the personal library`,
      );
      continue;
    }
    desired.set(linkName, localPath);
  }

  // Single albums go in a real folder named for the artist, one link per
  // album. An artist who is in the library whole already has them all.
  const albumHolders = new Map();
  for (const album of albums || []) {
    const [artistFolder, albumName] = String(album.folder).split("/");
    if (!artistFolder || !albumName || desired.has(artistFolder)) continue;
    if (!albumHolders.has(artistFolder)) albumHolders.set(artistFolder, new Map());
    albumHolders.get(artistFolder).set(albumName, album.target);
  }

  changes += await pruneStaleSymlinks(userDir, desired);

  // Null albums means they could not be worked out this time, so the holders
  // on disk are left exactly as they are.
  if (albums) {
    for (const entry of await fsp.readdir(userDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const holderPath = path.join(userDir, entry.name);
      if (!isAlbumHolder(holderPath)) continue;
      // An artist now in the library whole replaces the holder with a link.
      const wanted = desired.has(entry.name) ? null : albumHolders.get(entry.name) || null;
      changes += await pruneAlbumHolder(holderPath, wanted);
    }
  }

  for (const [linkName, targetPath] of desired) {
    const linkPath = path.join(userDir, linkName);
    let existing = null;
    try {
      existing = await fsp.lstat(linkPath);
    } catch {}
    if (existing) {
      if (!existing.isSymbolicLink()) {
        logger.warn(
          "library",
          `[UserLibraries] Skipping ${linkPath}: a non-symlink entry already exists`,
        );
      }
      continue;
    }
    if (!fs.existsSync(targetPath)) {
      logger.warn(
        "library",
        `[UserLibraries] Skipping symlink for missing artist folder: ${targetPath}`,
      );
      continue;
    }
    const relativeTarget = path.relative(userDir, targetPath);
    try {
      await fsp.symlink(relativeTarget, linkPath, "dir");
      changes += 1;
      logger.info("library", `[UserLibraries] Linked ${linkPath} -> ${relativeTarget}`);
    } catch (error) {
      logger.warn(
        "library",
        `[UserLibraries] Failed to create symlink ${linkPath}: ${error.message}`,
      );
    }
  }

  for (const [artistFolder, wanted] of albumHolders) {
    const holderPath = path.join(userDir, artistFolder);
    let existing = null;
    try {
      existing = await fsp.lstat(holderPath);
    } catch {}
    if (existing && (!existing.isDirectory() || !isAlbumHolder(holderPath))) {
      logger.warn("library", `[UserLibraries] Skipping albums in ${holderPath}: something else is already there`);
      continue;
    }
    for (const [albumName, targetPath] of wanted) {
      const linkPath = path.join(holderPath, albumName);
      if (fs.existsSync(linkPath)) continue;
      if (!fs.existsSync(targetPath)) {
        logger.warn("library", `[UserLibraries] Skipping link for missing album folder: ${targetPath}`);
        continue;
      }
      try {
        if (!isAlbumHolder(holderPath)) {
          await fsp.mkdir(holderPath, { recursive: true });
          await fsp.writeFile(
            path.join(holderPath, ALBUM_HOLDER_MARKER),
            "Albums Psalter linked into this personal library one at a time. Managed by Psalter.\n",
          );
        }
        await fsp.symlink(path.relative(holderPath, targetPath), linkPath);
        changes += 1;
        logger.info("library", `[UserLibraries] Linked album ${linkPath}`);
      } catch (error) {
        logger.warn("library", `[UserLibraries] Failed to link album ${linkPath}: ${error.message}`);
      }
    }
  }

  return changes;
}

function getNavidromeClient() {
  const settings = dbOps.getSettings();
  const navidrome = settings?.integrations?.navidrome || {};
  const client = new NavidromeClient(navidrome.url, navidrome.username, navidrome.password);
  return client.isConfigured() ? client : null;
}

async function triggerNavidromeScan(client = getNavidromeClient()) {
  if (!client) return;
  try {
    await client.scanLibrary();
    logger.info("library", "[UserLibraries] Triggered Navidrome library scan");
  } catch (error) {
    logger.warn("library", `[UserLibraries] Navidrome scan failed: ${error.message}`);
  }
}

const normalizeLibraryPath = (value) => String(value || "").trim().replace(/[\\/]+$/, "");

// Where Navidrome sees a user's folder. Same path as Psalter unless the admin
// says the libraries folder is mounted elsewhere in the Navidrome container.
export function resolveNavidromeUserLibraryPath(userDir, config) {
  if (!config?.navidromeRootPath) return userDir;
  return `${config.navidromeRootPath}/${path.basename(userDir)}`;
}

// Decide what to create and assign without touching Navidrome, so the rules
// can be unit-tested. Libraries are matched by path; a name clash on a
// different path is left alone rather than hijacked.
export function planNavidromeLibraries({
  entries = [],
  libraries = [],
  navidromeUsers = [],
  userLibraryIds = new Map(),
  config = {},
} = {}) {
  const byPath = new Map(libraries.map((lib) => [normalizeLibraryPath(lib.path), lib]));
  const byName = new Map(libraries.map((lib) => [String(lib.name || "").toLowerCase(), lib]));
  const navUsersByName = new Map(
    navidromeUsers.map((user) => [String(user.userName || "").toLowerCase(), user]),
  );
  const create = [];
  const assign = [];
  const skipped = [];
  for (const entry of entries) {
    const navPath = resolveNavidromeUserLibraryPath(entry.userDir, config);
    const name = String(entry.username || "").trim();
    let library = byPath.get(normalizeLibraryPath(navPath)) || null;
    if (!library) {
      if (byName.has(name.toLowerCase())) {
        skipped.push({ username: entry.username, reason: "name-in-use" });
        continue;
      }
      create.push({ username: entry.username, name, path: navPath });
    }
    const navUser = navUsersByName.get(name.toLowerCase());
    if (!navUser) {
      skipped.push({ username: entry.username, reason: "no-navidrome-user" });
      continue;
    }
    if (navUser.isAdmin) continue;
    const current = userLibraryIds.get(String(navUser.id)) || [];
    if (library && current.some((id) => Number(id) === Number(library.id))) continue;
    assign.push({
      username: entry.username,
      navUserId: navUser.id,
      libraryId: library ? library.id : null,
      libraryPath: normalizeLibraryPath(navPath),
      currentIds: current.map((id) => Number(id)),
    });
  }
  return { create, assign, skipped };
}

// Ensure each populated user folder is a Navidrome library that the matching
// Navidrome user (same username) can see. Needs the configured Navidrome
// account to be an admin; otherwise the native API answers 403 and we skip.
async function ensureNavidromeLibraries(entries, config) {
  const result = { created: 0, assigned: 0, skipped: [] };
  if (!config.manageNavidrome || !entries.length) return result;
  const client = getNavidromeClient();
  if (!client) return result;

  let libraries;
  let navidromeUsers;
  try {
    [libraries, navidromeUsers] = await Promise.all([client.getLibraries(), client.getUsers()]);
  } catch (error) {
    logger.warn(
      "library",
      `[UserLibraries] Navidrome library management skipped (needs an admin account): ${error.message}`,
    );
    return result;
  }

  const wanted = new Set(entries.map((entry) => String(entry.username || "").toLowerCase()));
  const userLibraryIds = new Map();
  for (const navUser of navidromeUsers) {
    if (navUser.isAdmin || !wanted.has(String(navUser.userName || "").toLowerCase())) continue;
    try {
      const current = await client.getUserLibraries(navUser.id);
      userLibraryIds.set(String(navUser.id), current.map((lib) => lib.id));
    } catch (error) {
      logger.warn(
        "library",
        `[UserLibraries] Could not read Navidrome libraries for ${navUser.userName}: ${error.message}`,
      );
    }
  }

  const plan = planNavidromeLibraries({ entries, libraries, navidromeUsers, userLibraryIds, config });
  result.skipped = plan.skipped;
  for (const item of plan.skipped) {
    const detail =
      item.reason === "name-in-use"
        ? `a Navidrome library named "${item.username}" already points elsewhere`
        : `no Navidrome user named "${item.username}" to assign it to`;
    logger.info("library", `[UserLibraries] Navidrome: ${detail}`);
  }

  for (const item of plan.create) {
    try {
      await client.createLibrary(item.name, item.path);
      result.created += 1;
      logger.info("library", `[UserLibraries] Created Navidrome library "${item.name}" at ${item.path}`);
    } catch (error) {
      logger.warn(
        "library",
        `[UserLibraries] Failed to create Navidrome library "${item.name}": ${error.message}`,
      );
    }
  }

  if (plan.assign.length) {
    // Re-read so freshly created libraries get their ids.
    let refreshed = libraries;
    if (result.created > 0) {
      try {
        refreshed = await client.getLibraries();
      } catch {}
    }
    const idByPath = new Map(refreshed.map((lib) => [normalizeLibraryPath(lib.path), lib.id]));
    for (const item of plan.assign) {
      const libraryId = item.libraryId ?? idByPath.get(item.libraryPath);
      if (libraryId == null) continue;
      try {
        await client.setUserLibraries(item.navUserId, [...item.currentIds, libraryId]);
        result.assigned += 1;
        logger.info(
          "library",
          `[UserLibraries] Gave Navidrome user "${item.username}" access to their library`,
        );
      } catch (error) {
        logger.warn(
          "library",
          `[UserLibraries] Failed to assign Navidrome library to "${item.username}": ${error.message}`,
        );
      }
    }
  }
  return result;
}

async function runReconcile() {
  const config = getUserLibrariesSettings();
  if (!config.enabled || !config.rootPath) {
    return { skipped: true, reason: "disabled" };
  }
  if (!lidarrClient || !lidarrClient.isConfigured()) {
    return { skipped: true, reason: "lidarr-not-configured" };
  }

  const [tagsRaw, artists] = await Promise.all([
    lidarrClient.getTags(),
    lidarrClient.listArtists(),
  ]);
  const tagIdsByLabel = new Map(
    (Array.isArray(tagsRaw) ? tagsRaw : [])
      .filter((tag) => tag && typeof tag.label === "string")
      .map((tag) => [tag.label.trim().toLowerCase(), tag.id]),
  );

  const mappings = getPathMappings("lidarr");
  const users = userOps.getAllUsers();
  backfillAlbumReleaseGroups();
  let totalChanges = 0;
  const summary = [];
  const populated = [];

  for (const user of users) {
    const tagId = tagIdsByLabel.get(getUserTagLabel(user.username));
    const userDir = getUserLibraryDir(user.username, user.id);
    if (!userDir) continue;
    const memberArtists =
      tagId != null ? artists.filter((artist) => holdsWhole(artist, tagId)) : [];
    const albums = albumTargetsFor(user.username);
    if (!memberArtists.length && !albums?.length && !fs.existsSync(userDir)) continue;
    try {
      const changes = await materializeUserLibrary(userDir, memberArtists, mappings, albums);
      totalChanges += changes;
      summary.push({ username: user.username, artists: memberArtists.length, albums: albums?.length || 0, changes });
      if (memberArtists.length || albums?.length) populated.push({ username: user.username, userDir });
    } catch (error) {
      logger.warn(
        "library",
        `[UserLibraries] Reconcile failed for ${user.username}: ${error.message}`,
      );
    }
  }

  const navidrome = await ensureNavidromeLibraries(populated, config);
  if (totalChanges > 0 || navidrome.created > 0) {
    await triggerNavidromeScan();
  }
  // Music has just joined or left someone's library, so any smart playlist of
  // theirs is about a different set of songs than it was. Leave time for the
  // scan above: until Navidrome has read the new links, nothing would change.
  if (totalChanges > 0) {
    const { scheduleTagPlaylistRebuild } = await import("./tagPlaylistService.js");
    for (const entry of summary) {
      if (entry.changes > 0) {
        scheduleTagPlaylistRebuild(entry.username, {
          delayMs: 5 * 60_000,
          reason: "personal library changed",
          fresh: true,
        });
      }
    }
  }
  const playlists = await normalizePlaylistsIfEnabled(config);
  return { skipped: false, totalChanges, users: summary, navidrome, playlists };
}

// Personal libraries give every file a second id, and a playlist built while
// browsing one points at ids nobody else can resolve. Sweeping them back onto
// the main library here keeps that from accumulating between manual runs.
async function normalizePlaylistsIfEnabled(config) {
  if (!isPlaylistNormalizeEnabled() || !config.manageNavidrome) return null;
  try {
    const client = getNavidromeClient();
    if (!client?.isConfigured?.()) return null;
    // The scan just triggered above holds Navidrome's database; rewriting
    // playlists into it now fails with "database is locked".
    const scan = await client.waitForScanToFinish();
    // Unknown means the scan check itself failed, so it is not safe to assume
    // the database is free. Both unknown and still-scanning wait for the next
    // round rather than rewriting playlists into a locked database.
    if (scan.scanning !== false) {
      const state = scan.scanning === null ? "could not be read" : "is still running";
      logger.warn("library", `[Playlists] Navidrome scan state ${state}; skipping normalisation this round`);
      return null;
    }
    const { repairAllPlaylists } = await import("./navidromePlaylistRepair.js");
    const result = await repairAllPlaylists({
      client,
      // Blank means Navidrome sees the folder at the same path Psalter does.
      navidromeRootPath: config.navidromeRootPath || config.rootPath,
      dryRun: false,
    });
    if (result.repaired > 0) {
      logger.info("library", `[Playlists] Normalised ${result.repaired} playlist(s)`);
    }
    return result;
  } catch (error) {
    logger.warn("library", `[Playlists] Normalisation pass failed: ${error.message}`);
    return null;
  }
}

export async function reconcileUserLibraries() {
  if (reconcileInFlight) {
    reconcileQueued = true;
    return reconcileInFlight;
  }
  reconcileInFlight = (async () => {
    try {
      return await runReconcile();
    } finally {
      reconcileInFlight = null;
      if (reconcileQueued) {
        reconcileQueued = false;
        scheduleUserLibraryReconcile();
      }
    }
  })();
  return reconcileInFlight;
}

/**
 * Bring the libraries up to date now and wait until Navidrome has read them,
 * for a change someone is waiting on. A run already under way began before
 * the change and may not include it, so it is let finish first.
 */
export async function reconcileUserLibrariesAndWait() {
  if (reconcileInFlight) await reconcileInFlight.catch(() => {});
  const result = await reconcileUserLibraries();
  await getNavidromeClient()?.waitForScanToFinish();
  return result;
}

export function scheduleUserLibraryReconcile(delayMs = RECONCILE_DEBOUNCE_MS) {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconcileUserLibraries().catch((error) => {
      logger.warn("library", `[UserLibraries] Reconcile error: ${error.message}`);
    });
  }, delayMs);
  reconcileTimer.unref?.();
}

export function startUserLibraryReconciler() {
  if (periodicTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    reconcileUserLibraries().catch((error) => {
      logger.warn("library", `[UserLibraries] Startup reconcile error: ${error.message}`);
    });
  }, RECONCILE_STARTUP_DELAY_MS);
  startupTimer.unref?.();
  periodicTimer = setInterval(() => {
    reconcileUserLibraries().catch((error) => {
      logger.warn("library", `[UserLibraries] Periodic reconcile error: ${error.message}`);
    });
  }, RECONCILE_INTERVAL_MS);
  periodicTimer.unref?.();
}

export function stopUserLibraryReconciler() {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  if (startupTimer) clearTimeout(startupTimer);
  if (periodicTimer) clearInterval(periodicTimer);
  reconcileTimer = null;
  startupTimer = null;
  periodicTimer = null;
}
