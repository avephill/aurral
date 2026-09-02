import fs from "node:fs";
import path from "node:path";

import { resolvePlaylistRoot } from "./playlistPaths.js";
import { isLibraryScanExcludedDirectory } from "./libraryFileScanner.js";
import { lidarrClient } from "./lidarrClient.js";
import { logger as defaultLogger } from "./logger.js";
import { scheduleLibraryScan } from "./libraryScanWorker.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";

const DEFAULT_DEBOUNCE_MS = 2000;

function isIgnoredChange(root, filename) {
  if (filename == null || filename === "") return false;
  const changedPath = path.isAbsolute(String(filename))
    ? path.resolve(String(filename))
    : path.resolve(root, String(filename));
  const relative = path.relative(path.resolve(root), changedPath);
  const firstSegment = relative.split(path.sep).find(Boolean);
  return isLibraryScanExcludedDirectory(firstSegment);
}

export function createLibraryFileWatcher({
  roots = [],
  debounceMs = DEFAULT_DEBOUNCE_MS,
  watchImpl = fs.watch,
  onChange = () => scheduleLibraryScan(),
  onError = () => {},
} = {}) {
  const watchers = [];
  let timer = null;
  const changedRoots = new Set();
  const uniqueRoots = [...new Set(roots.map((root) => path.resolve(String(root || ""))).filter(Boolean))];

  const scheduleChange = (root) => {
    changedRoots.add(root);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const roots = [...changedRoots];
      changedRoots.clear();
      onChange(roots);
    }, Math.max(0, Number(debounceMs) || 0));
    timer.unref?.();
  };

  for (const root of uniqueRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const watcher = watchImpl(root, { recursive: true }, (_eventType, filename) => {
        if (!isIgnoredChange(root, filename)) scheduleChange(root);
      });
      watchers.push(watcher);
    } catch (error) {
      onError(error, root);
    }
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const watcher of watchers) watcher.close();
    },
  };
}

async function resolveLibraryWatchRoots() {
  const roots = [resolvePlaylistRoot()];
  if (lidarrClient.isConfigured()) {
    try {
      const rootFolders = await lidarrClient.getRootFolders();
      roots.push(
        ...(Array.isArray(rootFolders)
          ? rootFolders.map((folder) => resolveLocalPath(folder?.path, getPathMappings("lidarr")))
          : []),
      );
    } catch {}
  }
  return roots.filter(Boolean);
}

let watcherStarted = false;
let activeWatcher = null;

export async function refreshLibraryFileWatcher({ logger = defaultLogger } = {}) {
  if (!watcherStarted) return false;
  activeWatcher?.close();
  const playlistRoot = path.resolve(resolvePlaylistRoot());
  const roots = await resolveLibraryWatchRoots();
  // Registering a recursive watch walks the whole tree, which is slow on a
  // large library. This runs on every settings save, so time it: a long setup
  // here explains an unresponsive server better than anything in the JS profile.
  const startedAt = Date.now();
  activeWatcher = createLibraryFileWatcher({
    roots,
    onChange: (changedRoots) => scheduleLibraryScan({
      includeLidarr: changedRoots.some((root) => path.resolve(root) !== playlistRoot),
    }),
    onError: (error, root) => {
      logger.warn?.("library", `Failed to watch ${root}: ${error?.message || error}`);
    },
  });
  const elapsedMs = Date.now() - startedAt;
  const message = `Watching ${roots.length} root(s) (setup ${elapsedMs}ms)`;
  if (elapsedMs >= 1000) logger.warn?.("library", message);
  else logger.info?.("library", message);
  return true;
}

export async function startLibraryFileWatcher({ logger = defaultLogger } = {}) {
  if (watcherStarted) return false;
  watcherStarted = true;
  try {
    await refreshLibraryFileWatcher({ logger });
    return true;
  } catch (error) {
    watcherStarted = false;
    activeWatcher?.close();
    activeWatcher = null;
    throw error;
  }
}

export function stopLibraryFileWatcher() {
  watcherStarted = false;
  activeWatcher?.close();
  activeWatcher = null;
}
