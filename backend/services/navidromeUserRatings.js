import { isNavidromeUserAuthEnabled } from "../config/featureFlags.js";
import { createNavidromeUserClient, isNavidromeAuthError } from "./navidromeUserClient.js";
import { mediaPathsForNavidromeSongIds } from "./navidromeTrackResolver.js";
import { getCanonicalMediaFilesByPaths } from "./libraryQueryService.js";
import { logger } from "./logger.js";

/**
 * Each person's song ratings, keyed by canonical track id.
 *
 * Navidrome holds the ratings and has no call that lists only rated songs, so
 * this pages through every song the person can reach with Subsonic search3 (a
 * query of `""` lists them all), read as that person so every rating is their
 * own. For a large library that is many requests, so the answer is kept per
 * person and refreshed in the background once stale, and a rating set in
 * Psalter updates the kept answer straight away.
 */

const PAGE_SIZE = 500;
const MAX_PAGES = 1000;
const FRESH_MS = 15 * 60 * 1000;

const entries = new Map();

const clampRating = (value) => Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

async function readRatedSongIds(client) {
  const rated = new Map();
  let seen = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await client.request("search3", {
      // The OpenSubsonic way to ask for every song is a query of two double
      // quotes. A bare empty query is not handled the same by every version.
      query: '""',
      songCount: PAGE_SIZE,
      songOffset: page * PAGE_SIZE,
      artistCount: 0,
      albumCount: 0,
    });
    const songs = asArray(data?.searchResult3?.song);
    seen += songs.length;
    for (const song of songs) {
      const rating = clampRating(song?.userRating);
      if (rating > 0 && song?.id) rated.set(String(song.id), rating);
    }
    if (songs.length < PAGE_SIZE) break;
  }
  return { rated, seen };
}

async function loadRatings(client) {
  const startedAt = Date.now();
  const { rated, seen } = await readRatedSongIds(client);
  const report = (matched) => logger.info(
    "library",
    `[Navidrome] Ratings for ${client.user}: ${seen} song(s) read, ${rated.size} rated, ${matched} matched to tracks (${Date.now() - startedAt}ms)`,
  );
  if (!rated.size) {
    report(0);
    return new Map();
  }
  const paths = await mediaPathsForNavidromeSongIds([...rated.keys()], {
    maxLookups: Number.POSITIVE_INFINITY,
  });
  const files = new Map(
    getCanonicalMediaFilesByPaths([...new Set(paths.values())]).map((file) => [file.path, file]),
  );
  const ratings = new Map();
  for (const [songId, rating] of rated) {
    const trackId = Number(files.get(paths.get(songId))?.trackId);
    if (!Number.isSafeInteger(trackId) || trackId <= 0) continue;
    // A file shared by two libraries is two songs. Ratings are written to every
    // copy, so they agree; the higher one covers a copy that missed a write.
    ratings.set(trackId, Math.max(ratings.get(trackId) || 0, rating));
  }
  report(ratings.size);
  return ratings;
}

function refresh(key, client) {
  const entry = entries.get(key) || {};
  if (entry.pending) return entry.pending;
  const pending = loadRatings(client)
    .then((ratings) => {
      entries.set(key, { ratings, loadedAt: Date.now(), pending: null });
      return ratings;
    })
    .catch((error) => {
      const current = entries.get(key);
      if (current) current.pending = null;
      throw error;
    });
  entries.set(key, { ...entry, pending });
  return pending;
}

/**
 * The person's song ratings as a Map of canonical track id to 1-5. A stale
 * answer is returned at once while a fresh one loads; only the very first read
 * for a person waits for Navidrome.
 */
export async function getUserTrackRatings(user) {
  if (!isNavidromeUserAuthEnabled()) return { enabled: false, connected: false, ratings: new Map() };
  const client = createNavidromeUserClient(user);
  if (!client) return { enabled: true, connected: false, ratings: new Map() };
  const key = client.user;
  const entry = entries.get(key);
  try {
    if (entry?.ratings) {
      if (Date.now() - entry.loadedAt >= FRESH_MS) {
        refresh(key, client).catch((error) => {
          logger.warn("library", `[Navidrome] Could not refresh ratings for ${key}: ${error.message}`);
        });
      }
      return { enabled: true, connected: true, ratings: entry.ratings };
    }
    return { enabled: true, connected: true, ratings: await refresh(key, client) };
  } catch (error) {
    if (isNavidromeAuthError(error)) return { enabled: true, connected: false, ratings: new Map() };
    throw error;
  }
}

/**
 * The person's kept ratings without waiting for Navidrome. When there are none
 * yet, or they are stale, a load starts in the background; `ratings` is null
 * until the first one finishes.
 */
export function peekUserTrackRatings(user) {
  if (!isNavidromeUserAuthEnabled()) return { enabled: false, ratings: null };
  const client = createNavidromeUserClient(user);
  if (!client) return { enabled: false, ratings: null };
  const entry = entries.get(client.user);
  if (!entry?.ratings || Date.now() - entry.loadedAt >= FRESH_MS) {
    refresh(client.user, client).catch((error) => {
      logger.warn("library", `[Navidrome] Could not load ratings for ${client.user}: ${error.message}`);
    });
  }
  return { enabled: true, ratings: entry?.ratings || null };
}

/** Keep a person's kept ratings in step with a rating just saved. */
export function noteTrackRating(user, trackId, rating) {
  const entry = entries.get(String(user?.username || "").trim());
  const id = Number(trackId);
  if (!entry?.ratings || !Number.isSafeInteger(id)) return;
  const value = clampRating(rating);
  if (value > 0) entry.ratings.set(id, value);
  else entry.ratings.delete(id);
}

export function resetUserTrackRatings() {
  entries.clear();
}

/**
 * Albums ranked by the median of the person's ratings of their songs.
 *
 * `rows` are { albumId, trackId, trackCount } album memberships. An album only
 * ranks once enough of it is rated, both a minimum number of songs and a share
 * of the album, so one loved song cannot carry a whole record. Ties go to the
 * higher mean, then to the album with more rated songs.
 */
export function rankAlbumsByMedianRating(rows = [], ratings = new Map(), { minRated = 3, minShare = 0.5 } = {}) {
  const byAlbum = new Map();
  for (const row of rows) {
    const rating = ratings.get(Number(row.trackId));
    if (!rating) continue;
    const albumId = Number(row.albumId);
    const album = byAlbum.get(albumId) || { albumId, trackCount: Number(row.trackCount) || 0, values: [] };
    album.values.push(rating);
    byAlbum.set(albumId, album);
  }
  return [...byAlbum.values()]
    .filter((album) => album.values.length >= minRated && album.values.length >= album.trackCount * minShare)
    .map((album) => {
      const values = [...album.values].sort((left, right) => left - right);
      const middle = Math.floor(values.length / 2);
      const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return {
        albumId: album.albumId,
        median,
        mean: Math.round(mean * 100) / 100,
        rated: values.length,
        trackCount: album.trackCount,
      };
    })
    .sort((left, right) =>
      right.median - left.median
      || right.mean - left.mean
      || right.rated - left.rated
      || left.albumId - right.albumId);
}
