import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

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

function uniqueResolvedRoots(roots) {
  return [...new Set(roots.map((root) => path.resolve(String(root || ""))).filter(Boolean))];
}

// Collapses a burst of changes into one call per quiet period, remembering
// which roots changed so the scan can skip Lidarr when only local files moved.
function createChangeDebouncer({ debounceMs, onChange }) {
  let timer = null;
  const changedRoots = new Set();
  return {
    push(root) {
      changedRoots.add(root);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const roots = [...changedRoots];
        changedRoots.clear();
        onChange(roots);
      }, Math.max(0, Number(debounceMs) || 0));
      timer.unref?.();
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
      changedRoots.clear();
    },
  };
}

export function createLibraryFileWatcher({
  roots = [],
  debounceMs = DEFAULT_DEBOUNCE_MS,
  watchImpl = fs.watch,
  onChange = () => scheduleLibraryScan(),
  onError = () => {},
} = {}) {
  const watchers = [];
  const debouncer = createChangeDebouncer({ debounceMs, onChange });

  for (const root of uniqueResolvedRoots(roots)) {
    if (!fs.existsSync(root)) continue;
    try {
      const watcher = watchImpl(root, { recursive: true }, (_eventType, filename) => {
        if (!isIgnoredChange(root, filename)) debouncer.push(root);
      });
      watchers.push(watcher);
    } catch (error) {
      onError(error, root);
    }
  }

  return {
    close() {
      debouncer.clear();
      for (const watcher of watchers) watcher.close();
    },
  };
}

const defaultWorkerFactory = (roots) =>
  new Worker(new URL("./libraryWatchWorker.js", import.meta.url), { workerData: { roots } });

// The same watcher, with the watches held on a worker thread (see
// libraryWatchWorker.js for why). Returns at once; `onReady` reports when the
// worker has finished registering, and how long that took.
export function createThreadedLibraryFileWatcher({
  roots = [],
  debounceMs = DEFAULT_DEBOUNCE_MS,
  onChange = () => scheduleLibraryScan(),
  onError = () => {},
  onReady = () => {},
  workerFactory = defaultWorkerFactory,
} = {}) {
  const debouncer = createChangeDebouncer({ debounceMs, onChange });
  let closed = false;
  const worker = workerFactory(uniqueResolvedRoots(roots));
  // Watches keep a worker alive; they must not keep the process alive too.
  worker.unref?.();

  worker.on("message", (message) => {
    if (closed || !message) return;
    if (message.type === "change") {
      if (!isIgnoredChange(message.root, message.filename)) debouncer.push(message.root);
    } else if (message.type === "error") {
      onError(new Error(message.message), message.root);
    } else if (message.type === "ready") {
      onReady(message);
    }
  });
  worker.on("error", (error) => {
    if (!closed) onError(error, null);
  });

  return {
    close() {
      closed = true;
      debouncer.clear();
      Promise.resolve(worker.terminate()).catch(() => {});
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
  // Registering the watches happens on a worker thread and this returns without
  // waiting for it, so neither startup nor a settings save waits on a walk of
  // the whole library. Setup is still timed: a slow one explains why a new file
  // took a while to be noticed.
  activeWatcher = createThreadedLibraryFileWatcher({
    roots,
    onChange: (changedRoots) => scheduleLibraryScan({
      includeLidarr: changedRoots.some((root) => path.resolve(root) !== playlistRoot),
    }),
    onError: (error, root) => {
      logger.warn?.("library", `Failed to watch ${root ?? "library roots"}: ${error?.message || error}`);
    },
    onReady: ({ roots: watched, elapsedMs }) => {
      const message = `Watching ${watched} root(s) (setup ${elapsedMs}ms)`;
      if (elapsedMs >= 1000) logger.warn?.("library", message);
      else logger.info?.("library", message);
    },
  });
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
