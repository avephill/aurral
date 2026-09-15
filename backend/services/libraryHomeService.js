import {
  getAlbumTrackRows,
  getCanonicalLibraryForAlbumIds,
  getCanonicalLibraryPage,
} from "./libraryQueryService.js";
import { libraryManager } from "./libraryManager.js";
import {
  getUserTrackRatings,
  peekUserTrackRatings,
  rankAlbumsByMedianRating,
} from "./navidromeUserRatings.js";
import { logger } from "./logger.js";

/**
 * Everything the Library home shows, built per person and kept.
 *
 * Building it runs the heaviest reads the page has: whole-library counts,
 * newest albums across the person's artists, their artist list from Lidarr,
 * and their ratings from Navidrome. Asked for on every visit, that took tens
 * of seconds. Instead the last answer is returned at once and a new one is
 * built behind it when it is older than a few minutes or a library scan has
 * finished since. `refreshing` tells the page a newer answer is on its way.
 *
 * Top rated never holds the rest up: if the person's ratings are not loaded
 * yet the answer says so (`topRatedPending`) and fills in once they are.
 */

const FRESH_MS = 5 * 60 * 1000;
const SHELF_SIZE = 24;

const homes = new Map();
let generation = 0;
let stats = null;

function libraryStats() {
  if (stats?.generation === generation) return stats.data;
  const total = (options) => getCanonicalLibraryPage({ page: 1, pageSize: 1, ...options }).total;
  const data = {
    artists: total({ kind: "artists" }),
    albums: total({ kind: "albums" }),
    tracks: total({ kind: "tracks", availableOnly: true }),
  };
  stats = { data, generation };
  return data;
}

function topRatedFor(user) {
  const { enabled, ratings } = peekUserTrackRatings(user);
  if (enabled && !ratings) {
    return { topRated: [], topRatedLibrary: { artists: [], albums: [], tracks: [] }, topRatedPending: true };
  }
  const topRated = ratings
    ? rankAlbumsByMedianRating(getAlbumTrackRows([...ratings.keys()]), ratings).slice(0, SHELF_SIZE)
    : [];
  return {
    topRated,
    topRatedLibrary: getCanonicalLibraryForAlbumIds({ ids: topRated.map((album) => album.albumId) }),
    topRatedPending: false,
  };
}

async function buildHome(user) {
  const { scopeCanonicalArtistsToUser } = await import("./userLibraryService.js");
  // The person's artists, or null when personal libraries are off and the
  // whole library is everyone's.
  const scoped = await scopeCanonicalArtistsToUser(user);
  const artists = Array.isArray(scoped) ? scoped : await libraryManager.getAllArtists();
  const addedAt = (artist) => new Date(artist.addedAt || artist.added || 0).getTime() || 0;
  return {
    recentAlbums: getCanonicalLibraryPage({
      kind: "albums",
      page: 1,
      pageSize: SHELF_SIZE,
      sort: "newest",
      artistIds: Array.isArray(scoped) ? scoped.map((artist) => artist.id) : null,
    }),
    recentArtists: [...artists].sort((left, right) => addedAt(right) - addedAt(left)).slice(0, SHELF_SIZE),
    stats: libraryStats(),
    ...topRatedFor(user),
  };
}

const keyFor = (user) => String(user?.id ?? "");

function rebuild(user) {
  const key = keyFor(user);
  const entry = homes.get(key) || {};
  if (entry.pending) return entry.pending;
  const startedGeneration = generation;
  const pending = buildHome(user)
    .then((data) => {
      homes.set(key, { user, data, builtAt: Date.now(), generation: startedGeneration, pending: null });
      return data;
    })
    .catch((error) => {
      const current = homes.get(key);
      if (current) current.pending = null;
      throw error;
    });
  homes.set(key, { ...entry, user, pending });
  return pending;
}

function rebuildInBackground(user) {
  rebuild(user).catch((error) => {
    logger.warn("library", `[Home] Could not rebuild the library home for ${user?.username}: ${error.message}`);
  });
}

export async function getLibraryHome(user) {
  const key = keyFor(user);
  let entry = homes.get(key);
  if (!entry?.data) {
    await rebuild(user);
    entry = homes.get(key);
  } else {
    if (entry.data.topRatedPending) {
      const topRated = topRatedFor(user);
      if (!topRated.topRatedPending) entry.data = { ...entry.data, ...topRated };
    }
    if (entry.generation !== generation || Date.now() - entry.builtAt >= FRESH_MS) {
      rebuildInBackground(user);
    }
  }
  const current = homes.get(key);
  return {
    ...entry.data,
    refreshing: Boolean(current?.pending) || entry.data.topRatedPending === true,
  };
}

/**
 * Mark every kept home out of date, after a library scan. Homes already built
 * are rebuilt in the background, one person at a time, so the next visit is
 * quick and current.
 */
export function invalidateLibraryHome({ rebuild: rebuildNow = true } = {}) {
  generation += 1;
  if (!rebuildNow) return;
  const users = [...homes.values()].map((entry) => entry.user).filter(Boolean);
  warmLibraryHomes(users).catch(() => {});
}

/**
 * Build homes ahead of a visit, one person at a time, loading their ratings
 * too, so the first page after a restart does not wait on Navidrome.
 */
export async function warmLibraryHomes(users = []) {
  for (const user of users) {
    if (!user?.id || !user?.username) continue;
    try {
      await rebuild(user);
      await getUserTrackRatings(user);
      await getLibraryHome(user);
    } catch (error) {
      logger.warn("library", `[Home] Could not warm the library home for ${user.username}: ${error.message}`);
    }
  }
}

/** Resolves once no home is being built. For tests. */
export async function settleLibraryHome() {
  await Promise.all([...homes.values()].map((entry) => entry.pending).filter(Boolean).map((pending) => pending.catch(() => null)));
}

export function resetLibraryHome() {
  homes.clear();
  stats = null;
  generation = 0;
}
