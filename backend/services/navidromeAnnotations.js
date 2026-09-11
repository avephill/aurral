import { isNavidromeUserAuthEnabled } from "../config/featureFlags.js";
import { createNavidromeUserClient, isNavidromeAuthError } from "./navidromeUserClient.js";
import {
  describeCanonicalTrack,
  mediaPathsForNavidromeSongIds,
  resolveNavidromeSongCopies,
  resolveNavidromeSongId,
} from "./navidromeTrackResolver.js";
import {
  getCanonicalMediaFilesByPaths,
  getCanonicalTrack,
  getCanonicalTrackIdentityKeysByIds,
} from "./libraryQueryService.js";
import { getStarredIdentityKeys, starMany } from "./subsonicLibraryService.js";
import { logger } from "./logger.js";

/**
 * Per-user ratings and stars, kept in Navidrome.
 *
 * A rating set here is the same rating every Navidrome client shows, because
 * it is written as the user through the trusted-header connection. Reads go
 * the same way, one getSong per track, so the answer is always the user's own
 * annotation and never a cached copy. The canonical-track-to-song link comes
 * from the resolver, which caches once learnt.
 */

const LOOKUP_CONCURRENCY = 6;
const MAX_LOOKUP = 200;

const clampRating = (value) => Math.max(0, Math.min(5, Math.round(Number(value) || 0)));

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function normalizeRef(ref) {
  const trackId = String(ref?.trackId ?? ref?.id ?? "").trim();
  const albumId = ref?.albumId != null && String(ref.albumId).trim() ? String(ref.albumId).trim() : null;
  return trackId ? { trackId, albumId } : null;
}

async function songIdForRef(ref) {
  const canonical = describeCanonicalTrack(ref);
  if (!canonical) return null;
  return resolveNavidromeSongId(canonical);
}

// All copies of the track across libraries, main library first.
async function songIdsForRef(ref) {
  const canonical = describeCanonicalTrack(ref);
  if (!canonical) return [];
  return resolveNavidromeSongCopies(canonical);
}

function annotationFromSong(song) {
  return {
    rating: clampRating(song?.userRating),
    starred: Boolean(song?.starred),
    navidromeAlbumId: song?.albumId || null,
    navidromeArtistId: song?.artistId || null,
  };
}

/**
 * Ratings and stars for a list of { trackId, albumId } refs, as the user.
 * Tracks Navidrome does not know come back with `known: false`.
 */
export async function lookupTrackAnnotations(user, refs = []) {
  if (!isNavidromeUserAuthEnabled()) return { enabled: false, tracks: {} };
  const client = createNavidromeUserClient(user);
  if (!client) return { enabled: true, connected: false, tracks: {} };
  const list = (Array.isArray(refs) ? refs : []).map(normalizeRef).filter(Boolean).slice(0, MAX_LOOKUP);
  const tracks = {};
  let authFailed = false;
  await mapLimit(list, LOOKUP_CONCURRENCY, async (ref) => {
    if (authFailed) return;
    try {
      const songId = await songIdForRef(ref);
      if (!songId) {
        tracks[ref.trackId] = { known: false, songId: null, rating: 0, starred: false };
        return;
      }
      const song = await client.getSong(songId);
      tracks[ref.trackId] = { known: true, songId, ...annotationFromSong(song) };
    } catch (error) {
      if (isNavidromeAuthError(error)) {
        authFailed = true;
        return;
      }
      logger.warn("library", `[Navidrome] Rating lookup failed for track ${ref.trackId}: ${error.message}`);
      tracks[ref.trackId] = { known: false, songId: null, rating: 0, starred: false, error: error.message };
    }
  });
  return { enabled: true, connected: !authFailed, tracks };
}

/**
 * Set (or with 0, clear) the user's rating on one track.
 */
export async function setTrackRating(user, ref, rating) {
  const normalized = normalizeRef(ref);
  if (!normalized) throw Object.assign(new Error("trackId is required"), { status: 400 });
  const client = createNavidromeUserClient(user);
  if (!client) throw Object.assign(new Error("Navidrome not configured"), { status: 503 });
  const songIds = await songIdsForRef(normalized);
  const songId = songIds[0];
  if (!songId) throw Object.assign(new Error("Navidrome has not indexed this track"), { status: 404 });
  const value = clampRating(rating);
  // Every copy of the file, so the rating reads the same whichever library
  // view a Navidrome client is filtered to.
  for (const id of songIds) await client.setRating(id, value);
  const song = await client.getSong(songId).catch(() => null);
  return { trackId: normalized.trackId, songId, rating: song ? clampRating(song.userRating) : value, starred: Boolean(song?.starred) };
}

/**
 * Star or unstar one track as the user.
 */
export async function setTrackStarred(user, ref, starred) {
  const normalized = normalizeRef(ref);
  if (!normalized) throw Object.assign(new Error("trackId is required"), { status: 400 });
  const client = createNavidromeUserClient(user);
  if (!client) throw Object.assign(new Error("Navidrome not configured"), { status: 503 });
  const songIds = await songIdsForRef(normalized);
  const songId = songIds[0];
  if (!songId) throw Object.assign(new Error("Navidrome has not indexed this track"), { status: 404 });
  for (const id of songIds) {
    if (starred) await client.star(id);
    else await client.unstar(id);
  }
  return { trackId: normalized.trackId, songId, starred: Boolean(starred) };
}

/**
 * Aurral favourite ids look like "song:<identityKey>" or "album:<identityKey>".
 * Resolve the song ones to canonical refs; album ones to any track on the
 * album, whose Navidrome albumId is then starred.
 */
function parseFavoriteId(value) {
  const match = /^(song|album|artist):(.+)$/.exec(String(value || ""));
  if (!match) return null;
  let key = match[2];
  try {
    key = decodeURIComponent(key);
  } catch {}
  return { kind: match[1], key };
}

/**
 * Mirror an Aurral favourite change into Navidrome as the user. Best effort:
 * failures are logged, never surfaced, because Aurral's own favourite already
 * succeeded and the user should not see it fail for a Navidrome hiccup.
 */
export async function mirrorFavoritesToNavidrome(user, ids = [], starred) {
  if (!isNavidromeUserAuthEnabled()) return { mirrored: 0 };
  const client = createNavidromeUserClient(user);
  if (!client) return { mirrored: 0 };
  let mirrored = 0;
  for (const value of Array.isArray(ids) ? ids : []) {
    const parsed = parseFavoriteId(value);
    if (!parsed || parsed.kind === "artist") continue;
    try {
      const library = getCanonicalTrack({ trackId: parsed.kind === "song" ? parsed.key : "", availableOnly: true });
      let songIds = [];
      let albumStar = false;
      if (parsed.kind === "song") {
        const track = library.tracks[0];
        if (!track) continue;
        songIds = await songIdsForRef({ trackId: track.id, albumId: track.albums?.[0]?.albumId || null });
      } else {
        albumStar = true;
        const { getCanonicalLibraryForAlbumReferences } = await import("./libraryQueryService.js");
        const albumLibrary = getCanonicalLibraryForAlbumReferences({ source: "all", availableOnly: true, references: [parsed.key] });
        const track = albumLibrary.tracks.find((entry) => entry.available) || albumLibrary.tracks[0];
        const album = albumLibrary.albums[0];
        if (!track || !album) continue;
        songIds = await songIdsForRef({ trackId: track.id, albumId: album.id });
      }
      if (!songIds.length) continue;
      const targets = new Set();
      for (const songId of songIds) {
        if (!albumStar) {
          targets.add(songId);
          continue;
        }
        const song = await client.getSong(songId).catch(() => null);
        if (song?.albumId) targets.add(song.albumId);
      }
      if (!targets.size) continue;
      for (const targetId of targets) {
        if (starred) await client.star(targetId);
        else await client.unstar(targetId);
      }
      mirrored += 1;
    } catch (error) {
      logger.warn("library", `[Navidrome] Could not mirror favourite ${value}: ${error.message}`);
      if (isNavidromeAuthError(error)) break;
    }
  }
  return { mirrored };
}

/**
 * Pull the user's Navidrome stars back in as Aurral favourites.
 *
 * Stars set on a phone or in the Navidrome web player are the same gesture as
 * a heart here, so they should end up in the same place. Only additions are
 * taken: an Aurral favourite that has no star in Navidrome may simply be a
 * track Navidrome does not hold, and dropping it would lose it for good.
 *
 * Songs are matched by file, through the id store, so a repeat pass costs one
 * Subsonic call and no path work at all.
 */
export async function importStarsFromNavidrome(user, { limit = 2000 } = {}) {
  if (!isNavidromeUserAuthEnabled()) return { enabled: false, connected: false, imported: 0 };
  const client = createNavidromeUserClient(user);
  if (!client) return { enabled: true, connected: false, imported: 0 };

  let songs = [];
  try {
    songs = await client.getStarredSongs({ limit });
  } catch (error) {
    if (isNavidromeAuthError(error)) return { enabled: true, connected: false, imported: 0 };
    logger.warn("library", `[Navidrome] Could not read stars for ${user?.username}: ${error.message}`);
    return { enabled: true, connected: false, imported: 0 };
  }
  if (!songs.length) return { enabled: true, connected: true, starred: 0, imported: 0, matched: 0 };

  const paths = await mediaPathsForNavidromeSongIds(songs.map((song) => song?.id));
  const files = getCanonicalMediaFilesByPaths([...paths.values()]);
  const identityKeys = getCanonicalTrackIdentityKeysByIds(files.map((file) => file.trackId));
  const wanted = new Set();
  for (const file of files) {
    const key = identityKeys.get(Number(file.trackId));
    if (key) wanted.add(`song:${key}`);
  }

  const existing = getStarredIdentityKeys(user);
  const missing = [...wanted].filter((id) => !existing.has(id));
  let imported = 0;
  const CHUNK = 100;
  for (let index = 0; index < missing.length; index += CHUNK) {
    const chunk = missing.slice(index, index + CHUNK);
    if (starMany(user, chunk, { skipCanonicalValidation: true })) imported += chunk.length;
  }
  if (imported) {
    logger.info("library", `[Navidrome] Took ${imported} star(s) into favourites for ${user?.username}`);
  }
  return {
    enabled: true,
    connected: true,
    starred: songs.length,
    matched: wanted.size,
    imported,
  };
}
