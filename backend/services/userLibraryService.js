import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { dbOps, userOps } from "../db/helpers/index.js";
import { lidarrClient } from "./lidarrClient.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import { NavidromeClient } from "./navidrome.js";
import { getCanonicalNewlyAvailableAlbums } from "./libraryQueryService.js";
import { logger } from "./logger.js";

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
    // The libraries folder as Navidrome sees it; blank means same path as Aurral.
    navidromeRootPath: cleanRootPath(config.navidromeRootPath),
  };
}

export function normalizeUserLibrariesSettings(input, existing = {}) {
  const pick = (key, fallback) => (input?.[key] !== undefined ? input[key] : existing?.[key] ?? fallback);
  return {
    enabled: pick("enabled", false) === true,
    rootPath: cleanRootPath(pick("rootPath", "")),
    manageNavidrome: pick("manageNavidrome", true) !== false,
    navidromeRootPath: cleanRootPath(pick("navidromeRootPath", "")),
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

function artistHasTag(artist, tagId) {
  return Array.isArray(artist?.tags) && artist.tags.some((id) => Number(id) === Number(tagId));
}

const buildTagLabelsById = (tagsRaw) =>
  new Map(
    (Array.isArray(tagsRaw) ? tagsRaw : [])
      .filter((tag) => tag && typeof tag.label === "string")
      .map((tag) => [Number(tag.id), tag.label.trim().toLowerCase()]),
  );

// Maps a Lidarr artist's tag ids to the Aurral usernames whose personal
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
    artists: artists.filter((artist) => artistHasTag(artist, tagId)).map(mapMemberArtist),
  };
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
  const targets = [];
  for (const mbid of requested) {
    const artist = byMbid.get(mbid);
    if (!artist) {
      missing.push(mbid);
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
  };
}

// Every Lidarr artist with the viewer's membership and which other users hold
// it, for the bulk add/remove page. Pure so it can be tested without Lidarr.
export function selectUserLibraryCatalog({
  lidarrArtists = [],
  tagLabelsById = new Map(),
  usernames = [],
  viewerUsername = "",
} = {}) {
  const viewerTag = getUserTagLabel(viewerUsername);
  const userTags = buildUserTags(usernames);
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  return lidarrArtists
    .filter((artist) => artist?.foreignArtistId)
    .map((artist) => {
      const [labels, libraries] = resolveArtistLibraries(artist, tagLabelsById, userTags);
      const stats = artist.statistics || {};
      return {
        mbid: artist.foreignArtistId,
        artistId: artist.id,
        artistName: artist.artistName || "",
        sortName: artist.sortName || artist.artistName || "",
        albumCount: Number(stats.albumCount) || 0,
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
        if (currentTarget === path.resolve(target)) continue;
      } catch {}
    }
    try {
      await fsp.unlink(linkPath);
      changes += 1;
      if (target) {
        desired.set(entry.name, target);
      } else {
        logger.info("library", `[UserLibraries] Removed stale symlink ${linkPath}`);
      }
    } catch (error) {
      logger.warn("library", `[UserLibraries] Failed to remove symlink ${linkPath}: ${error.message}`);
    }
  }
  return changes;
}

export async function materializeUserLibrary(userDir, memberArtists, mappings) {
  let changes = 0;
  await fsp.mkdir(userDir, { recursive: true });

  const desired = new Map();
  for (const artist of memberArtists) {
    const remotePath = String(artist?.path || "").trim();
    if (!remotePath) continue;
    const localPath = resolveLocalPath(remotePath, mappings);
    const linkName = path.basename(localPath.replace(/[\\/]+$/, ""));
    if (!linkName || linkName === "." || linkName === "..") continue;
    desired.set(linkName, localPath);
  }

  changes += await pruneStaleSymlinks(userDir, desired);

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

// Where Navidrome sees a user's folder. Same path as Aurral unless the admin
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
  let totalChanges = 0;
  const summary = [];
  const populated = [];

  for (const user of users) {
    const tagId = tagIdsByLabel.get(getUserTagLabel(user.username));
    const userDir = getUserLibraryDir(user.username, user.id);
    if (!userDir) continue;
    const memberArtists =
      tagId != null ? artists.filter((artist) => artistHasTag(artist, tagId)) : [];
    if (!memberArtists.length && !fs.existsSync(userDir)) continue;
    try {
      const changes = await materializeUserLibrary(userDir, memberArtists, mappings);
      totalChanges += changes;
      summary.push({ username: user.username, artists: memberArtists.length, changes });
      if (memberArtists.length) populated.push({ username: user.username, userDir });
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
  return { skipped: false, totalChanges, users: summary, navidrome };
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
