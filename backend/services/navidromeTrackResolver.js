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
 * absolute paths under its own mount; Navidrome keeps paths relative to each
 * library root. The first successful match teaches us Aurral's root for that
 * library (see navidromePathMapping) and after that every lookup is an exact
 * path query on either side.
 *
 * Real paths only come from Navidrome's native API: its Subsonic responses
 * carry a made-up "Artist/Album/Title.ext" path for privacy. So path work goes
 * through the admin connection from Settings, which can read any song and any
 * playlist's tracks, while the per-user client only ever writes annotations
 * and playlists as the user.
 *
 * Song ids are resolved against the main Navidrome library, the one every
 * user can reach, so a playlist built here is the same playlist the
 * normaliser would produce.
 */

const SONG_ID_CACHE_LIMIT = 5000;
const ROOT_LEARNING_ATTEMPTS = 8;

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

function setRoots(roots) {
  state.aurralRoot = roots.aurralRoot;
  state.navidromeRoot = roots.navidromeRoot;
  logger.info(
    "library",
    `[Navidrome] Library roots: Aurral ${roots.aurralRoot} ↔ Navidrome ${roots.navidromeRoot || "(relative)"}`,
  );
}

/**
 * Learn the roots from one pair of paths for the same file, but only when the
 * result checks out: the Aurral path rebuilt from the derived root must be a
 * file we actually index. Guards against a same-named file under another
 * artist teaching us a wrong root.
 */
function learnRoots(aurralPath, navidromePath) {
  const roots = deriveRoots(aurralPath, navidromePath);
  if (!roots) return null;
  const rebuilt = joinRoot(roots.aurralRoot, roots.relative);
  if (normalizePath(rebuilt) !== normalizePath(aurralPath)) return null;
  setRoots(roots);
  return roots;
}

/**
 * Learn the roots from Navidrome-side paths alone, by finding one of them in
 * Aurral's index by its album-and-file suffix.
 */
function learnRootsFromNavidromePaths(paths) {
  let attempts = 0;
  for (const navidromePath of paths) {
    if (!navidromePath || attempts >= ROOT_LEARNING_ATTEMPTS) break;
    attempts += 1;
    const aurralPath = findCanonicalMediaFilePathBySuffix(lookupSuffix(navidromePath));
    if (!aurralPath) continue;
    const roots = learnRoots(aurralPath, navidromePath);
    if (roots && getCanonicalMediaFilesByPaths([joinRoot(roots.aurralRoot, navidromeRelativePath(navidromePath, roots.navidromeRoot))]).length) {
      return roots;
    }
    state.aurralRoot = null;
    state.navidromeRoot = null;
  }
  return null;
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

const songPath = (song) => normalizePath(song?.path);

/**
 * Navidrome song id for one canonical track (by its absolute path). Learns
 * the library roots on the first hit via a native title search, then uses
 * exact path lookups.
 */
export async function resolveNavidromeSongId(track, { client = getAdminNavidromeClient() } = {}) {
  if (!client || !track?.path) return null;
  const absolute = normalizePath(track.path);

  const canonicalLibraryId = await getCanonicalLibraryId(client);
  const preferCanonical = (songs) =>
    songs.find((song) => canonicalLibraryId !== null && Number(song?.libraryId) === canonicalLibraryId)
    || songs[0]
    || null;

  let relative = state.aurralRoot ? relativeToRoot(absolute, state.aurralRoot) : null;
  if (relative && state.songIdByRelativePath.has(relative)) {
    return state.songIdByRelativePath.get(relative);
  }

  if (relative) {
    let candidates = [];
    try {
      candidates = await client.findSongsByPath(relative);
    } catch (error) {
      logger.warn("library", `[Navidrome] Path lookup failed for ${relative}: ${error.message}`);
    }
    const match = preferCanonical(candidates.filter((song) => songPath(song) === relative));
    if (match?.id) {
      rememberSongId(relative, match.id);
      return match.id;
    }
  }

  // Roots unknown, or the path index disagrees: search by title through the
  // native API (real paths) and trust only a candidate whose path is the tail
  // of ours.
  const query = String(track.title || "").trim();
  if (!query) return null;
  let songs = [];
  try {
    songs = await client.searchSongsNative(query, { limit: 40 });
  } catch (error) {
    logger.warn("library", `[Navidrome] Title lookup failed for "${query}": ${error.message}`);
    return null;
  }
  const matches = songs
    .map((song) => ({ song, roots: deriveRoots(absolute, song?.path) }))
    .filter((entry) => entry.roots && normalizePath(joinRoot(entry.roots.aurralRoot, entry.roots.relative)) === absolute)
    .sort((a, b) => b.roots.relative.length - a.roots.relative.length);
  if (!matches.length) return null;
  const best = preferCanonical(matches.map((entry) => entry.song));
  const bestEntry = matches.find((entry) => entry.song === best);
  if (!state.aurralRoot) setRoots(bestEntry.roots);
  relative = relativeToRoot(absolute, state.aurralRoot) || bestEntry.roots.relative;
  rememberSongId(relative, best.id);
  return best.id;
}

/**
 * Every Navidrome copy of one canonical track, the main-library copy first.
 * A file symlinked into personal libraries is a separate song in each, and
 * annotations (ratings, stars) attach to a copy, so a rating set through
 * Aurral goes on all of them to read the same in every library view.
 */
export async function resolveNavidromeSongCopies(track, { client = getAdminNavidromeClient() } = {}) {
  const primary = await resolveNavidromeSongId(track, { client });
  if (!primary) return [];
  const absolute = normalizePath(track.path);
  const relative = state.aurralRoot ? relativeToRoot(absolute, state.aurralRoot) : null;
  if (!relative || !client) return [primary];
  let candidates = [];
  try {
    candidates = await client.findSongsByPath(relative);
  } catch {
    return [primary];
  }
  const ids = candidates
    .filter((song) => songPath(song) === relative && song?.id)
    .map((song) => String(song.id));
  return [primary, ...ids.filter((id) => id !== String(primary))];
}

/**
 * Navidrome song id for a track we only know by name, such as one picked from
 * search results. Exact title and artist, album preferred. Goes through the
 * user's Subsonic search when given, so only songs they can see qualify.
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
  const withAlbum = album ? byArtist.find((song) => same(song?.album, album)) : null;
  return (withAlbum || byArtist[0] || null)?.id || null;
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
 * Real library-relative paths for the songs in a playlist, keyed by song id,
 * read through the admin connection. Empty when that is not possible.
 */
async function realPathsForPlaylist(playlistId, client) {
  if (!client || !playlistId) return new Map();
  try {
    const tracks = await client.getPlaylistTracks(playlistId);
    const byId = new Map();
    for (const track of tracks) {
      const id = track?.mediaFileId ?? track?.mediaFile?.id ?? null;
      const path = track?.path ?? track?.mediaFile?.path ?? null;
      if (id != null && path && !byId.has(String(id))) byId.set(String(id), normalizePath(path));
    }
    return byId;
  } catch (error) {
    logger.warn("library", `[Navidrome] Could not read paths for playlist ${playlistId}: ${error.message}`);
    return new Map();
  }
}

/**
 * Map Navidrome playlist entries (Subsonic `entry` objects) onto canonical
 * tracks so the built-in player can play them. Entries with no local file
 * come back with `available: false` and Navidrome's own metadata.
 */
export async function mapNavidromeEntriesToTracks(
  entries = [],
  { playlistId = null, client = getAdminNavidromeClient() } = {},
) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return [];

  const realPaths = await realPathsForPlaylist(playlistId, client);
  const navidromePathFor = (entry) => realPaths.get(String(entry?.id ?? "")) || null;

  if (!state.aurralRoot) {
    learnRootsFromNavidromePaths(list.map(navidromePathFor).filter(Boolean));
  }

  const absoluteFor = (entry) => {
    const path = navidromePathFor(entry);
    if (!path || !state.aurralRoot) return null;
    return joinRoot(state.aurralRoot, navidromeRelativePath(path, state.navidromeRoot));
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
