// Repairs playlists that reference tracks from a personal library.
//
// Two things go wrong when a playlist is built with personal libraries in
// view, both explained in navidromePlaylistPortability.js:
//
//   1. Entries point at a personal library's copy of a file, so they resolve
//      to nothing for anyone without that library.
//   2. The same file gets added once per selected library, because each copy
//      is a distinct row with its own id.
//
// Both are fixed by rewriting each entry to the shared library's copy and then
// keeping only the first occurrence of each file.
//
// Navidrome has no "replace tracks" call, so this deletes and re-adds. That is
// destructive if it fails halfway, so the original entries are captured first
// and restored on failure, and nothing is written unless every entry maps.

import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { resolveAurralDataDir } from "../config/data-dir.js";

// Overridable so tests need not wait; comma-separated milliseconds.
const DEFAULT_WRITE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000];
function writeRetryDelays() {
  const raw = String(process.env.AURRAL_PLAYLIST_WRITE_RETRY_MS || "").trim();
  if (!raw) return DEFAULT_WRITE_RETRY_DELAYS_MS;
  const parsed = raw.split(",").map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : DEFAULT_WRITE_RETRY_DELAYS_MS;
}

// Navidrome answers 500 when its database is locked by a scan or another
// write. That clears in seconds, so writes are retried before giving up.
function isTransientWriteError(error) {
  const status = Number(error?.response?.status);
  const message = String(error?.message || "").toLowerCase();
  return status >= 500 || message.includes("locked") || message.includes("busy");
}

async function withWriteRetry(label, action) {
  const delays = writeRetryDelays();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!isTransientWriteError(error) || attempt >= delays.length) throw error;
      const delay = delays[attempt];
      logger.warn("library", `[Playlists] ${label} failed (${error.message}); retrying in ${delay / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// When a rewrite fails and the restore fails too, the original entries are
// written to disk so nothing depends on a log line surviving.
function writeRecoveryFile(playlist, originalIds) {
  try {
    const dir = path.join(resolveAurralDataDir(), "playlist-recovery");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(playlist.id).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
    fs.writeFileSync(file, JSON.stringify({
      playlistId: playlist.id,
      name: playlist.name,
      owner: playlist.ownerName || null,
      savedAt: new Date().toISOString(),
      mediaFileIds: originalIds,
    }, null, 2));
    return file;
  } catch (error) {
    logger.error("library", `[Playlists] Could not write recovery file for "${playlist.name}": ${error.message}`);
    return null;
  }
}
import { resolveCanonicalLibraryId, resolveSharedEquivalents, resolvePersonalLibraryId } from "./navidromePlaylistPortability.js";

/**
 * Works out the final ordered track list for one playlist.
 *
 * Pure: no Navidrome, so the ordering and de-duplication rules are testable.
 */
export function planPlaylistRepair({
  tracks,
  canonicalLibraryId,
  canonicalIdByPath = new Map(),
  // Optional second home: an entry with no copy in the target library may
  // stay on (or move to) this library instead of making the plan unsafe.
  fallbackLibraryId = null,
  fallbackIdByPath = new Map(),
}) {
  const canonical = Number(canonicalLibraryId);
  const fallback = fallbackLibraryId === null || fallbackLibraryId === undefined ? null : Number(fallbackLibraryId);
  const desiredIds = [];
  const seenPaths = new Set();
  const unmapped = [];
  let remapped = 0;
  let duplicatesRemoved = 0;
  let onFallback = 0;

  for (const track of Array.isArray(tracks) ? tracks : []) {
    let mediaFileId = track?.mediaFileId;
    if (Number(track?.libraryId) !== canonical) {
      const replacement = canonicalIdByPath.get(track?.path);
      if (replacement) {
        mediaFileId = replacement;
        remapped += 1;
      } else if (fallback !== null && Number(track?.libraryId) === fallback) {
        onFallback += 1;
      } else if (fallback !== null && fallbackIdByPath.get(track?.path)) {
        mediaFileId = fallbackIdByPath.get(track?.path);
        remapped += 1;
        onFallback += 1;
      } else {
        unmapped.push(track);
        continue;
      }
    }
    // De-duplication is by path, not by id: the same file has a different id in
    // every library it appears in, so identical ids would only catch copies
    // that were already identical.
    if (seenPaths.has(track?.path)) {
      duplicatesRemoved += 1;
      continue;
    }
    seenPaths.add(track?.path);
    // First occurrence wins, so the running order of the playlist survives.
    desiredIds.push(mediaFileId);
  }

  const currentIds = (Array.isArray(tracks) ? tracks : []).map((track) => track?.mediaFileId);
  const changed =
    desiredIds.length !== currentIds.length ||
    desiredIds.some((id, index) => id !== currentIds[index]);

  return {
    desiredIds,
    remapped,
    duplicatesRemoved,
    onFallback,
    unmapped,
    // A playlist is only rewritten when every entry has a home. Dropping
    // tracks to make the rest fit is not a repair.
    safe: unmapped.length === 0,
    changed: unmapped.length === 0 && changed,
  };
}

export async function repairPlaylist({ client, playlist, canonicalLibraryId, fallbackLibraryId = null, dryRun = true }) {
  // A playlist with a path is generated from a file on disk (.m3u) or from
  // smart-playlist rules (.NSP), and Navidrome re-syncs it from that source.
  // Rewriting its tracks would be undone on the next scan at best, and fight
  // the file at worst. Only hand-made playlists are ours to change.
  if (playlist?.path || playlist?.sync === true) {
    return {
      playlistId: playlist.id,
      name: playlist.name,
      skipped: "file-backed",
      path: playlist.path || null,
      applied: false,
      changed: false,
    };
  }

  const tracks = await client.getPlaylistTracks(playlist.id);
  const canonical = Number(canonicalLibraryId);
  const fallback = fallbackLibraryId === null || fallbackLibraryId === undefined ? null : Number(fallbackLibraryId);
  const foreign = tracks.filter((track) => Number(track?.libraryId) !== canonical);

  const canonicalIdByPath = new Map();
  const fallbackIdByPath = new Map();
  if (foreign.length) {
    const { mapped, unmapped } = await resolveSharedEquivalents({
      client,
      foreign,
      sharedLibraryIds: [canonical],
    });
    for (const entry of mapped) canonicalIdByPath.set(entry.path, entry.sharedMediaFileId);
    // Whatever has no copy in the target library may still have one in the
    // fallback library; entries already there need no lookup.
    const needFallback = unmapped.filter((track) => fallback !== null && Number(track?.libraryId) !== fallback);
    if (needFallback.length) {
      const second = await resolveSharedEquivalents({ client, foreign: needFallback, sharedLibraryIds: [fallback] });
      for (const entry of second.mapped) fallbackIdByPath.set(entry.path, entry.sharedMediaFileId);
    }
  }

  const plan = planPlaylistRepair({ tracks, canonicalLibraryId, canonicalIdByPath, fallbackLibraryId: fallback, fallbackIdByPath });
  const summary = {
    playlistId: playlist.id,
    name: playlist.name,
    before: tracks.length,
    after: plan.desiredIds.length,
    remapped: plan.remapped,
    duplicatesRemoved: plan.duplicatesRemoved,
    onFallback: plan.onFallback,
    unmapped: plan.unmapped.length,
    safe: plan.safe,
    changed: plan.changed,
    applied: false,
  };

  if (!plan.safe) {
    logger.warn(
      "library",
      `[Playlists] "${playlist.name}" left alone: ${plan.unmapped.length} track(s) have no copy in the target libraries`,
    );
    return summary;
  }
  if (!plan.changed || dryRun) return summary;

  const originalIds = tracks.map((track) => track.mediaFileId);
  const originalEntryIds = tracks.map((track) => track.id);
  let removed = false;
  try {
    await withWriteRetry(`Clearing "${playlist.name}"`, () => client.removePlaylistTracks(playlist.id, originalEntryIds));
    removed = true;
    await withWriteRetry(`Refilling "${playlist.name}"`, () => client.addPlaylistTracks(playlist.id, plan.desiredIds));
  } catch (error) {
    if (!removed) {
      // Nothing was changed; the playlist is exactly as it was.
      logger.warn("library", `[Playlists] Rewrite of "${playlist.name}" did not start (${error.message}); left unchanged`);
      throw error;
    }
    logger.error(
      "library",
      `[Playlists] Rewrite of "${playlist.name}" failed (${error.message}); restoring original entries`,
    );
    try {
      const remaining = await client.getPlaylistTracks(playlist.id);
      if (remaining.length) {
        await withWriteRetry(`Clearing "${playlist.name}" for restore`, () => client.removePlaylistTracks(playlist.id, remaining.map((track) => track.id)));
      }
      await withWriteRetry(`Restoring "${playlist.name}"`, () => client.addPlaylistTracks(playlist.id, originalIds));
      logger.info("library", `[Playlists] Restored "${playlist.name}" to its original ${originalIds.length} entries`);
    } catch (restoreError) {
      const file = writeRecoveryFile(playlist, originalIds);
      logger.error(
        "library",
        `[Playlists] Could not restore "${playlist.name}": ${restoreError.message}. Original entries saved to ${file || "(nowhere: see log)"}. Original media file ids: ${originalIds.join(",")}`,
      );
    }
    throw error;
  }

  const after = await client.getPlaylistTracks(playlist.id);
  summary.applied = true;
  summary.verifiedCount = after.length;
  if (after.length !== plan.desiredIds.length) {
    logger.warn(
      "library",
      `[Playlists] "${playlist.name}" has ${after.length} tracks after rewrite, expected ${plan.desiredIds.length}`,
    );
  } else {
    logger.info(
      "library",
      `[Playlists] Repaired "${playlist.name}": ${tracks.length} -> ${after.length} tracks (${plan.remapped} remapped, ${plan.duplicatesRemoved} duplicates removed)`,
    );
  }
  return summary;
}

/**
 * Sweeps every hand-made playlist into its home library.
 *
 * A playlist lives in its owner's personal library when they have one, so it
 * shows up in a Navidrome view filtered to that library alone. Entry by
 * entry: a track with no copy there (its artist is not in that person's
 * library) keeps the shared copy, which every member can reach, so the
 * playlist is never shortened. Playlists whose owner has no personal library
 * go to the shared library.
 *
 * Idempotent: a playlist that already resolves plans no change and is never
 * written, so this is safe to run on a schedule.
 */
export async function repairAllPlaylists({
  client,
  navidromeRootPath,
  canonicalLibraryId = null,
  dryRun = true,
} = {}) {
  if (!client?.isConfigured?.()) return { configured: false, repaired: 0, playlists: [] };

  const libraries = await client.getLibraries();
  const canonical = Number(canonicalLibraryId ?? resolveCanonicalLibraryId(libraries, navidromeRootPath));
  if (!Number.isFinite(canonical)) {
    logger.warn("library", "[Playlists] No canonical library to normalise onto; skipping");
    return { configured: true, repaired: 0, playlists: [] };
  }

  const results = [];
  let repaired = 0;
  for (const playlist of await client.getPlaylists()) {
    // Nothing in an empty playlist can be pointing at the wrong library, and
    // skipping them keeps the sweep from fetching tracks for all of them.
    if (!playlist?.songCount) continue;
    try {
      const personal = resolvePersonalLibraryId(libraries, playlist?.ownerName, navidromeRootPath);
      const target = personal !== null && personal !== canonical ? personal : canonical;
      const summary = await repairPlaylist({
        client,
        playlist,
        canonicalLibraryId: target,
        fallbackLibraryId: target === canonical ? null : canonical,
        dryRun,
      });
      if (!summary.skipped) summary.targetLibraryId = target;
      if (summary.skipped || (!summary.changed && !summary.applied)) continue;
      results.push(summary);
      if (summary.applied) repaired += 1;
    } catch (error) {
      logger.warn("library", `[Playlists] Could not repair "${playlist.name}": ${error.message}`);
    }
  }
  return { configured: true, canonicalLibraryId: canonical, repaired, playlists: results };
}
