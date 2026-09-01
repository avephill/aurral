import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { dbOps, userOps } from "../db/helpers/index.js";
import { lidarrClient } from "./lidarrClient.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import { NavidromeClient } from "./navidrome.js";
import { logger } from "./logger.js";

const RECONCILE_DEBOUNCE_MS = 3000;
const RECONCILE_STARTUP_DELAY_MS = 20000;
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let reconcileTimer = null;
let periodicTimer = null;
let startupTimer = null;
let reconcileInFlight = null;
let reconcileQueued = false;

export function getUserLibrariesSettings(settings = null) {
  const current = settings || dbOps.getSettings();
  const config = current?.userLibraries || {};
  return {
    enabled: config.enabled === true,
    rootPath: String(config.rootPath || "").trim().replace(/\/+$/, ""),
  };
}

export function normalizeUserLibrariesSettings(input, existing = {}) {
  return {
    enabled: input?.enabled !== undefined ? input.enabled === true : existing.enabled === true,
    rootPath:
      input?.rootPath !== undefined
        ? String(input.rootPath || "").trim().replace(/\/+$/, "")
        : String(existing.rootPath || "").trim().replace(/\/+$/, ""),
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

async function triggerNavidromeScan() {
  try {
    const settings = dbOps.getSettings();
    const navidrome = settings?.integrations?.navidrome || {};
    const client = new NavidromeClient(navidrome.url, navidrome.username, navidrome.password);
    if (!client.isConfigured()) return;
    await client.scanLibrary();
    logger.info("library", "[UserLibraries] Triggered Navidrome library scan");
  } catch (error) {
    logger.warn("library", `[UserLibraries] Navidrome scan failed: ${error.message}`);
  }
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
    } catch (error) {
      logger.warn(
        "library",
        `[UserLibraries] Reconcile failed for ${user.username}: ${error.message}`,
      );
    }
  }

  if (totalChanges > 0) {
    await triggerNavidromeScan();
  }
  return { skipped: false, totalChanges, users: summary };
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
