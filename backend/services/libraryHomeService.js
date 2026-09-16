import {
  getAlbumTrackRows,
  getCanonicalLibraryForAlbumIds,
  getCanonicalLibraryPage,
  getScopedGenreStats,
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
const statsByScope = new Map();

// Each tile counts what its own page shows: the person's own library, and
// music that is actually on disk. Counting everything indexed put 37,823
// albums on Avery's dad's home page when 2,889 are his.
function libraryStats(artistIds) {
  const key = `${generation}:${artistIds ? artistIds.join(",") : "all"}`;
  const cached = statsByScope.get(key);
  if (cached) return cached;
  const total = (options) => getCanonicalLibraryPage({
    page: 1,
    pageSize: 1,
    availableOnly: true,
    artistIds,
    ...options,
  }).total;
  const data = {
    artists: total({ kind: "artists" }),
    albums: total({ kind: "albums" }),
    tracks: total({ kind: "tracks" }),
    genres: getScopedGenreStats({ availableOnly: true, artistIds }).length,
  };
  statsByScope.set(key, data);
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
  // What their own Navidrome library holds, or null when they have none of
  // their own and the whole library is theirs. The same scope the library
  // pages and search use, so home cannot disagree with them.
  const { getCanonicalScope } = await import("./userLibraryScope.js");
  const scope = await getCanonicalScope(user).catch(() => null);
  const scopedIds = scope ? [...scope.artistIds] : null;
  const allArtists = await libraryManager.getAllArtists();
  const artists = scope
    ? allArtists.filter((artist) => scope.artistIds.has(Number(artist.id)))
    : allArtists;
  const addedAt = (artist) => new Date(artist.addedAt || artist.added || 0).getTime() || 0;
  return {
    recentAlbums: getCanonicalLibraryPage({
      kind: "albums",
      page: 1,
      pageSize: SHELF_SIZE,
      sort: "newest",
      availableOnly: true,
      artistIds: scopedIds,
    }),
    recentArtists: [...artists].sort((left, right) => addedAt(right) - addedAt(left)).slice(0, SHELF_SIZE),
    stats: libraryStats(scopedIds),
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
  statsByScope.clear();
  generation = 0;
}
