// Reports which Navidrome playlists reference tracks from a personal library.
//
// Navidrome stores a playlist entry as a media_file id, and a media_file id
// belongs to exactly one library — the same file symlinked into a personal
// library gets a second, unrelated id. A playlist built while browsing a
// personal library therefore resolves to nothing for anyone who lacks that
// library: Navidrome lists the playlist and returns zero tracks, with no error.
//
// The one identity shared across libraries is the library-relative path, which
// is identical for a file and its symlink. That is what this maps through.
// Navidrome's own persistent id cannot be used: it prepends the library id by
// design (model/metadata/persistent_ids.go), so the same file has different
// PIDs in different libraries.

import { getUserLibrariesSettings } from "./userLibraryService.js";
import { logger } from "./logger.js";

const normalizePath = (value) => String(value || "").replace(/\/+$/, "");

/**
 * Splits libraries into the shared one(s) everybody can reach and the personal
 * ones under the user-library root. A playlist is portable when every track
 * sits in a shared library.
 */
export function classifyLibraries(libraries, navidromeRootPath) {
  const root = normalizePath(navidromeRootPath);
  const shared = [];
  const personal = [];
  for (const library of Array.isArray(libraries) ? libraries : []) {
    const path = normalizePath(library?.path);
    if (root && path.startsWith(`${root}/`)) personal.push(library);
    else shared.push(library);
  }
  return { shared, personal };
}

/**
 * Groups one playlist's tracks by library and works out what would have to
 * change for it to resolve for every user.
 *
 * Pure so the mapping rules can be tested without a Navidrome.
 */
export function planPlaylistPortability({ playlist, tracks, sharedLibraryIds }) {
  const shared = new Set((sharedLibraryIds || []).map((id) => Number(id)));
  const foreign = [];
  const byLibrary = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const libraryId = Number(track?.libraryId);
    byLibrary.set(libraryId, (byLibrary.get(libraryId) || 0) + 1);
    if (!shared.has(libraryId)) {
      foreign.push({
        playlistTrackId: track.id,
        mediaFileId: track.mediaFileId || track.mediaFileID || null,
        libraryId,
        path: track.path || null,
        title: track.title || null,
        artist: track.artist || null,
      });
    }
  }
  return {
    playlistId: playlist?.id || null,
    name: playlist?.name || null,
    ownerName: playlist?.ownerName || null,
    public: playlist?.public === true,
    trackCount: Array.isArray(tracks) ? tracks.length : 0,
    tracksByLibrary: Object.fromEntries([...byLibrary].map(([k, v]) => [String(k), v])),
    foreign,
    portable: foreign.length === 0,
  };
}

/**
 * For each track stuck in a personal library, find the same file in a shared
 * library by its library-relative path.
 */
export async function resolveSharedEquivalents({ client, foreign, sharedLibraryIds }) {
  const shared = new Set((sharedLibraryIds || []).map((id) => Number(id)));
  const seen = new Map();
  const mapped = [];
  const unmapped = [];
  for (const track of foreign) {
    if (!track.path) {
      unmapped.push({ ...track, reason: "no path recorded" });
      continue;
    }
    if (!seen.has(track.path)) {
      try {
        seen.set(track.path, await client.findSongsByPath(track.path));
      } catch (error) {
        seen.set(track.path, null);
        logger.warn("library", `[Playlists] Path lookup failed for ${track.path}: ${error.message}`);
      }
    }
    const candidates = seen.get(track.path);
    if (!Array.isArray(candidates)) {
      unmapped.push({ ...track, reason: "lookup failed" });
      continue;
    }
    // An exact path match in a shared library is the same file; anything else
    // would be a guess, and a wrong track in someone's playlist is worse than
    // a reported gap.
    const match = candidates.find(
      (song) => shared.has(Number(song?.libraryId)) && song?.path === track.path,
    );
    if (match) mapped.push({ ...track, sharedMediaFileId: match.id, sharedLibraryId: Number(match.libraryId) });
    else unmapped.push({ ...track, reason: "not present in any shared library" });
  }
  return { mapped, unmapped };
}

/**
 * Read-only survey of every playlist on the server. Makes no changes.
 */
export async function analyzePlaylistPortability({ client, resolve = true } = {}) {
  if (!client?.isConfigured?.()) {
    return { configured: false, playlists: [] };
  }
  const config = getUserLibrariesSettings();
  const libraries = await client.getLibraries();
  const { shared, personal } = classifyLibraries(libraries, config.navidromeRootPath);
  const sharedLibraryIds = shared.map((library) => Number(library.id));

  const playlists = await client.getPlaylists();
  const report = [];
  for (const playlist of playlists) {
    let tracks = [];
    try {
      tracks = await client.getPlaylistTracks(playlist.id);
    } catch (error) {
      report.push({
        playlistId: playlist.id,
        name: playlist.name,
        error: error.message,
      });
      continue;
    }
    const plan = planPlaylistPortability({ playlist, tracks, sharedLibraryIds });
    if (plan.portable || !resolve) {
      report.push(plan);
      continue;
    }
    const { mapped, unmapped } = await resolveSharedEquivalents({
      client,
      foreign: plan.foreign,
      sharedLibraryIds,
    });
    report.push({ ...plan, repairable: unmapped.length === 0, mapped, unmapped });
  }

  const broken = report.filter((entry) => entry.portable === false);
  return {
    configured: true,
    sharedLibraries: shared.map((l) => ({ id: l.id, name: l.name, path: l.path })),
    personalLibraries: personal.map((l) => ({ id: l.id, name: l.name, path: l.path })),
    total: report.length,
    brokenCount: broken.length,
    repairableCount: broken.filter((entry) => entry.repairable).length,
    playlists: report,
  };
}
