import { isNavidromeUserAuthEnabled } from "../config/featureFlags.js";
import { createNavidromeUserClient, isNavidromeAuthError } from "./navidromeUserClient.js";
import {
  describeCanonicalTrack,
  getPersonalLibraryIdForUser,
  mediaPathsForNavidromeSongIds,
  resolveNavidromeSong,
  resolveNavidromeSongCopies,
  resolveNavidromeSongId,
} from "./navidromeTrackResolver.js";
import {
  getAlbumTrackRows,
  getCanonicalMediaFilesByPaths,
  getCanonicalTrack,
  getCanonicalTrackIdentityKeysByIds,
} from "./libraryQueryService.js";
import {
  getUserTrackRatings,
  noteTrackRating,
  rankAlbumsByMedianRating,
} from "./navidromeUserRatings.js";
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

// Subsonic error 70: Navidrome has no such song for this user. For a file
// symlinked into several libraries that means the copy belongs to a library
// they cannot see, not that the write was wrong.
const isNavidromeNotFound = (error) => Number(error?.code) === 70;

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
async function songIdsForRef(ref, { adminClient = undefined } = {}) {
  const canonical = describeCanonicalTrack(ref);
  if (!canonical) return [];
  return resolveNavidromeSongCopies(canonical, adminClient ? { client: adminClient } : {});
}

/**
 * Write one annotation to every copy of a file the person can reach. A copy in
 * someone else's personal library is refused, and that must not stop the
 * copies they do have. Returns how many took it and which were refused.
 */
async function writeToEveryCopy(songIds, write) {
  const refused = [];
  let written = 0;
  for (const id of songIds) {
    try {
      await write(id);
      written += 1;
    } catch (error) {
      if (!isNavidromeNotFound(error)) throw error;
      refused.push(id);
    }
  }
  return { written, refused };
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
 * Tell Navidrome the person played a track, so its own play counts, recently
 * played and listening history are right whichever client they use next.
 *
 * Only one copy is scrobbled, theirs by preference: a file symlinked into a
 * personal library is a separate song in each library, and counting a play
 * against every copy would report one listen several times. Ratings go on
 * every copy because they must read the same everywhere; a play happened once.
 */
export async function reportPlayToNavidrome(user, ref, {
  playedAt = Date.now(),
  client = createNavidromeUserClient(user),
  adminClient = undefined,
  preferLibraryId = undefined,
} = {}) {
  if (!isNavidromeUserAuthEnabled() || !client) return { reported: false, reason: "not connected" };
  const normalized = normalizeRef(ref);
  const canonical = normalized && describeCanonicalTrack(normalized);
  if (!canonical) return { reported: false, reason: "not a library track" };
  const resolverOptions = adminClient ? { client: adminClient } : {};
  const library = preferLibraryId !== undefined
    ? preferLibraryId
    : await getPersonalLibraryIdForUser(user?.username, resolverOptions).catch(() => null);
  const song = await resolveNavidromeSong(canonical, { ...resolverOptions, preferLibraryId: library });
  if (!song?.id) return { reported: false, reason: "Navidrome has not indexed this track" };
  await client.scrobble(song.id, { time: playedAt });
  return { reported: true, songId: song.id, libraryId: song.libraryId };
}

/**
 * Set (or with 0, clear) the user's rating on one track.
 */
export async function setTrackRating(user, ref, rating, {
  client = createNavidromeUserClient(user),
  adminClient = undefined,
} = {}) {
  const normalized = normalizeRef(ref);
  if (!normalized) throw Object.assign(new Error("trackId is required"), { status: 400 });
  if (!client) throw Object.assign(new Error("Navidrome not configured"), { status: 503 });
  const songIds = await songIdsForRef(normalized, { adminClient });
  const songId = songIds[0];
  if (!songId) throw Object.assign(new Error("Navidrome has not indexed this track"), { status: 404 });
  const value = clampRating(rating);
  // Every copy of the file the person can reach, so the rating reads the same
  // whichever library view a Navidrome client is filtered to. A copy in
  // someone else's personal library is refused ("data not found"), and that
  // must not stop the copies they do have: a rating written to the shared
  // library but not to their own is the split that made ratings disappear
  // from their view before.
  const { written, refused } = await writeToEveryCopy(songIds, (id) => client.setRating(id, value));
  if (!written) {
    throw Object.assign(new Error("Navidrome did not accept this track"), { status: 404 });
  }
  if (refused.length) {
    logger.debug(
      "library",
      `[Navidrome] ${refused.length} copy(ies) of track ${normalized.trackId} are outside ${client.user}'s libraries`,
    );
  }
  const song = await client.getSong(songId).catch(() => null);
  const saved = song ? clampRating(song.userRating) : value;
  noteTrackRating(user, normalized.trackId, saved);
  // Smart playlists built from ratings follow the change.
  import("./tagPlaylistService.js")
    .then(({ noteOwnerTrackRating, scheduleTagPlaylistRebuild }) => {
      noteOwnerTrackRating(user.username, normalized.trackId, saved);
      scheduleTagPlaylistRebuild(user.username, { reason: "rating changed" });
    })
    .catch(() => {});
  return { trackId: normalized.trackId, songId, rating: saved, starred: Boolean(song?.starred) };
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
  // As with ratings: a copy in a library this person cannot see is refused,
  // and the copies they can see must still be starred.
  const { written: starsWritten } = await writeToEveryCopy(songIds, (id) => (
    starred ? client.star(id) : client.unstar(id)
  ));
  if (!starsWritten) {
    throw Object.assign(new Error("Navidrome did not accept this track"), { status: 404 });
  }
  return { trackId: normalized.trackId, songId, starred: Boolean(starred) };
}

/**
 * The user's top rated albums, ranked by the median of their own song ratings.
 *
 * Album ratings are deliberately not used. People rate songs; an album rating
 * is a separate control few ever touch, and one stray album star used to put
 * an album with no rated songs at the top. Options pass through to
 * rankAlbumsByMedianRating.
 */
export async function getTopRatedAlbums(user, { limit = 12, minRated, minShare } = {}) {
  const size = Math.max(1, Math.min(50, Math.round(Number(limit) || 12)));
  const { enabled, connected, ratings } = await getUserTrackRatings(user);
  if (!enabled || !connected) return { enabled, connected, albums: [] };
  const rows = getAlbumTrackRows([...ratings.keys()]);
  const albums = rankAlbumsByMedianRating(rows, ratings, { minRated, minShare }).slice(0, size);
  return { enabled, connected, albums };
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
