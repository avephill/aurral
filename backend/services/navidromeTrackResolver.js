import { dbOps } from "../db/helpers/index.js";
import { NavidromeClient } from "./navidrome.js";
import { resolveCanonicalLibraryId } from "./navidromePlaylistPortability.js";
import { getUserLibrariesSettings } from "./userLibraryService.js";
import {
  deriveRoots,
  joinRoot,
  lookupSuffix,
  navidromeRelativePath,
  normalizePath,
  relativeToRoot,
} from "./navidromePathMapping.js";
import {
  findCanonicalMediaFilePathBySuffix,
  getCanonicalLibraryForTrackIds,
  getCanonicalMediaFilesByPaths,
  getCanonicalTrack,
  getCanonicalTrackPath,
} from "./libraryQueryService.js";
import { buildCanonicalLibraryReadModel } from "./canonicalLibraryReadAdapter.js";
import { logger } from "./logger.js";

/**
 * Translates between Aurral's canonical tracks and Navidrome's songs.
 *
 * Both index the same files, so the file path is the identity. Aurral keeps
 * absolute paths under its own mount; Navidrome reports paths under its own.
 * The first successful match teaches us both roots (see navidromePathMapping)
 * and after that every lookup is an exact path query on either side.
 *
 * Song ids are resolved against the main Navidrome library, the one every
 * user can reach, so a playlist built here is the same playlist the
 * normaliser would produce. Lookups go through the admin connection because
 * the native API that filters by path needs a real login; the per-user client
 * only ever writes annotations and playlists.
 */

const SONG_ID_CACHE_LIMIT = 5000;

const state = {
  signature: null,
  adminClient: null,
  aurralRoot: null,
  navidromeRoot: null,
  canonicalLibraryId: null,
  canonicalLibraryPromise: null,
  songIdByRelativePath: new Map(),
};

function rememberSongId(relative, id) {
  if (state.songIdByRelativePath.size >= SONG_ID_CACHE_LIMIT) {
    state.songIdByRelativePath.delete(state.songIdByRelativePath.keys().next().value);
  }
  state.songIdByRelativePath.set(relative, id);
}

export function resetNavidromeTrackResolver() {
  state.signature = null;
  state.adminClient = null;
  state.aurralRoot = null;
  state.navidromeRoot = null;
  state.canonicalLibraryId = null;
  state.canonicalLibraryPromise = null;
  state.songIdByRelativePath = new Map();
}

export function getAdminNavidromeClient(settings = dbOps.getSettings()) {
  const navidrome = settings?.integrations?.navidrome;
  if (!navidrome?.url || !navidrome?.username || !navidrome?.password) return null;
  const signature = `${navidrome.url}\n${navidrome.username}\n${navidrome.password}`;
  if (state.signature !== signature) {
    resetNavidromeTrackResolver();
    state.signature = signature;
    state.adminClient = new NavidromeClient(navidrome.url, navidrome.username, navidrome.password);
  }
  return state.adminClient;
}

async function getCanonicalLibraryId(client) {
  if (state.canonicalLibraryId !== null) return state.canonicalLibraryId;
  if (!state.canonicalLibraryPromise) {
    state.canonicalLibraryPromise = (async () => {
      try {
        const libraries = await client.getLibraries();
        const id = resolveCanonicalLibraryId(libraries, getUserLibrariesSettings().navidromeRootPath);
        state.canonicalLibraryId = id ?? null;
      } catch (error) {
        logger.warn("library", `[Navidrome] Could not list libraries: ${error.message}`);
        state.canonicalLibraryId = null;
      } finally {
        state.canonicalLibraryPromise = null;
      }
      return state.canonicalLibraryId;
    })();
  }
  return state.canonicalLibraryPromise;
}

export function getNavidromeRoots() {
  return { aurralRoot: state.aurralRoot, navidromeRoot: state.navidromeRoot };
}

function learnRoots(aurralPath, navidromePath) {
  const roots = deriveRoots(aurralPath, navidromePath);
  if (!roots) return null;
  state.aurralRoot = roots.aurralRoot;
  state.navidromeRoot = roots.navidromeRoot;
  logger.info(
    "library",
    `[Navidrome] Library roots: Aurral ${roots.aurralRoot} ↔ Navidrome ${roots.navidromeRoot || "(relative)"}`,
  );
  return roots;
}

function firstCanonicalTrack(library) {
  const track = library?.tracks?.[0];
  if (!track) return null;
  const file = track.files.find((entry) => entry.available) || track.files[0] || null;
  return {
    id: track.id,
    title: track.title,
    artistName: track.artistName,
    albumId: file?.albumId || track.albums?.[0]?.albumId || null,
    path: file?.path || null,
  };
}

/**
 * Canonical file path and display fields for a track reference from the
 * frontend: { trackId, albumId } when known.
 */
export function describeCanonicalTrack({ trackId, albumId } = {}) {
  const id = String(trackId ?? "").trim();
  if (!id) return null;
  const library = getCanonicalTrack({ trackId: id, availableOnly: true, albumId: albumId || null });
  const track = firstCanonicalTrack(library);
  if (!track) return null;
  if (albumId) {
    const path = getCanonicalTrackPath(albumId, id);
    if (path) track.path = path;
  }
  return track.path ? track : null;
}

/**
 * Navidrome song id for one canonical track (by its absolute path). Falls
 * back to a title search when the path index cannot see the file, and learns
 * the library roots on the first hit.
 */
export async function resolveNavidromeSongId(track, { client = getAdminNavidromeClient() } = {}) {
  if (!client || !track?.path) return null;
  const absolute = normalizePath(track.path);

  let relative = state.aurralRoot ? relativeToRoot(absolute, state.aurralRoot) : null;
  if (relative && state.songIdByRelativePath.has(relative)) {
    return state.songIdByRelativePath.get(relative);
  }

  const canonicalLibraryId = await getCanonicalLibraryId(client);
  const pickCandidate = (candidates, matcher) => {
    const matching = candidates.filter(matcher);
    return (
      matching.find((song) => canonicalLibraryId !== null && Number(song.libraryId) === canonicalLibraryId)
      || matching[0]
      || null
    );
  };

  if (relative) {
    let candidates = [];
    try {
      candidates = await client.findSongsByPath(relative);
    } catch (error) {
      logger.warn("library", `[Navidrome] Path lookup failed for ${relative}: ${error.message}`);
    }
    const match = pickCandidate(candidates, (song) => normalizePath(song?.path) === relative);
    if (match?.id) {
      rememberSongId(relative, match.id);
      return match.id;
    }
  }

  // Either the roots are not known yet or the path index disagrees: search by
  // title and trust only a candidate whose path is the tail of ours.
  const query = String(track.title || "").trim();
  if (!query) return null;
  let songs = [];
  try {
    songs = await client.searchSongs(query, { limit: 40 });
  } catch (error) {
    logger.warn("library", `[Navidrome] Search failed for "${query}": ${error.message}`);
    return null;
  }
  const suffixMatches = songs.filter((song) => {
    const roots = deriveRoots(absolute, song?.path);
    return Boolean(roots);
  });
  if (!suffixMatches.length) return null;
  const best = suffixMatches
    .map((song) => ({ song, roots: deriveRoots(absolute, song.path) }))
    .sort((a, b) => b.roots.relative.length - a.roots.relative.length)[0];
  if (!state.aurralRoot) learnRoots(absolute, best.song.path);
  relative = relativeToRoot(absolute, state.aurralRoot) || best.roots.relative;
  rememberSongId(relative, best.song.id);
  return best.song.id;
}

/**
 * Navidrome song id for a track we only know by name, such as one picked from
 * search results. Exact title and artist, album preferred.
 */
export async function resolveNavidromeSongIdByMetadata(
  { trackName, artistName, albumName } = {},
  { client = getAdminNavidromeClient() } = {},
) {
  const title = String(trackName || "").trim();
  const artist = String(artistName || "").trim().toLowerCase();
  const album = String(albumName || "").trim().toLowerCase();
  if (!client || !title) return null;
  let songs = [];
  try {
    songs = await client.searchSongs(title, { limit: 40 });
  } catch {
    return null;
  }
  const same = (value, expected) => String(value || "").trim().toLowerCase() === expected;
  const titled = songs.filter((song) => same(song?.title, title.toLowerCase()));
  const byArtist = artist
    ? titled.filter((song) => same(song?.artist, artist) || same(song?.albumArtist, artist))
    : titled;
  const pool = byArtist.length ? byArtist : [];
  const withAlbum = album ? pool.find((song) => same(song?.album, album)) : null;
  const chosen = withAlbum || pool[0] || null;
  if (chosen?.path && !state.aurralRoot) {
    // Any canonical copy of this file teaches us the roots for free.
    const aurralPath = findCanonicalMediaFilePathBySuffix(lookupSuffix(chosen.path));
    if (aurralPath) learnRoots(aurralPath, chosen.path);
  }
  return chosen?.id || null;
}

/**
 * Resolve a list of frontend track payloads to Navidrome song ids, keeping
 * order. Each payload may carry { trackId, albumId } for a canonical track and
 * { trackName, artistName, albumName } as the fallback.
 */
export async function resolveNavidromeSongIds(payloads = [], options = {}) {
  const resolved = [];
  const unresolved = [];
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    let id = null;
    const canonical = describeCanonicalTrack(payload);
    if (canonical) id = await resolveNavidromeSongId(canonical, options);
    if (!id) id = await resolveNavidromeSongIdByMetadata(payload, options);
    if (id) resolved.push({ payload, songId: id });
    else unresolved.push(payload);
  }
  return { resolved, unresolved };
}

/**
 * Map Navidrome playlist entries (Subsonic `entry` objects) onto canonical
 * tracks so the built-in player can play them. Entries with no local file
 * come back with `available: false` and Navidrome's own metadata.
 */
export function mapNavidromeEntriesToTracks(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return [];

  if (!state.aurralRoot) {
    for (const entry of list) {
      if (!entry?.path) continue;
      const aurralPath = findCanonicalMediaFilePathBySuffix(lookupSuffix(entry.path));
      if (aurralPath && learnRoots(aurralPath, entry.path)) break;
    }
  }

  const absoluteFor = (entry) => {
    if (!entry?.path || !state.aurralRoot) return null;
    return joinRoot(state.aurralRoot, navidromeRelativePath(entry.path, state.navidromeRoot));
  };
  const absolutePaths = list.map(absoluteFor);
  const files = getCanonicalMediaFilesByPaths(absolutePaths.filter(Boolean));
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const trackIds = [...new Set(files.map((file) => file.trackId))];
  const library = trackIds.length
    ? buildCanonicalLibraryReadModel(getCanonicalLibraryForTrackIds({ ids: trackIds, availableOnly: true }))
    : { artists: [], albums: [], tracks: [] };
  const albumsById = new Map(library.albums.map((album) => [album.id, album]));
  const artistsById = new Map(library.artists.map((artist) => [artist.id, artist]));
  const tracksByKey = new Map(library.tracks.map((track) => [`${track.albumId}:${track.id}`, track]));
  const tracksById = new Map();
  for (const track of library.tracks) if (!tracksById.has(track.id)) tracksById.set(track.id, track);

  return list.map((entry, index) => {
    const durationMs = Number(entry?.duration || 0) * 1000 || null;
    const base = {
      index,
      navidromeId: entry?.id || null,
      title: entry?.title || "",
      artistName: entry?.artist || "",
      albumTitle: entry?.album || "",
      durationMs,
      trackMbid: entry?.musicBrainzId || null,
      available: false,
      trackId: null,
      albumId: null,
      artistId: null,
      streamPath: null,
      coverUrl: null,
    };
    const file = absolutePaths[index] ? fileByPath.get(absolutePaths[index]) : null;
    if (!file) return base;
    const track = tracksByKey.get(`${file.albumId}:${file.trackId}`) || tracksById.get(file.trackId);
    if (!track) return base;
    const album = albumsById.get(track.albumId) || null;
    const artist = album ? artistsById.get(album.artistId) || null : null;
    return {
      ...base,
      title: track.title || base.title,
      artistName: artist?.name || track.artistName || base.artistName,
      albumTitle: album?.title || base.albumTitle,
      trackId: track.id,
      albumId: track.albumId,
      artistId: album?.artistId || null,
      artistMbid: artist?.mbid || null,
      albumMbid: album?.mbid || album?.releaseGroupMbid || null,
      trackMbid: track.mbid || base.trackMbid,
      trackNumber: track.trackNumber || null,
      streamFormat: track.streamFormat || null,
      quality: track.quality || null,
      available: Boolean(track.hasFile),
      streamPath: track.hasFile
        ? `/library/canonical-stream/${encodeURIComponent(track.albumId)}/${encodeURIComponent(track.id)}`
        : null,
      album,
    };
  });
}
