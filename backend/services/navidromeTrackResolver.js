import { dbOps } from "../db/helpers/index.js";
import { NavidromeClient } from "./navidrome.js";
import { resolveCanonicalLibraryId, resolvePersonalLibraryId } from "./navidromePlaylistPortability.js";
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
  getCanonicalTrackTitlesByIds,
} from "./libraryQueryService.js";
import { buildCanonicalLibraryReadModel } from "./canonicalLibraryReadAdapter.js";
import { getNavidromeRootMapping } from "../config/featureFlags.js";
import {
  getMediaPathsForNavidromeSongIds,
  getNavidromeSongId,
  rememberNavidromeSongId,
  rememberNavidromeSongIds,
} from "./navidromeSongIdStore.js";
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

const LIBRARIES_TTL_MS = 10 * 60 * 1000;

const state = {
  signature: null,
  adminClient: null,
  aurralRoot: null,
  navidromeRoot: null,
  canonicalLibraryId: null,
  canonicalLibraryPromise: null,
  libraries: null,
  librariesFetchedAt: 0,
  librariesPromise: null,
  rootsConfigured: false,
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
  state.libraries = null;
  state.librariesFetchedAt = 0;
  state.librariesPromise = null;
  state.rootsConfigured = false;
  state.songIdByRelativePath = new Map();
  applyConfiguredRoots();
}

async function getLibraries(client) {
  if (state.libraries && Date.now() - state.librariesFetchedAt < LIBRARIES_TTL_MS) return state.libraries;
  if (!state.librariesPromise) {
    state.librariesPromise = (async () => {
      try {
        const libraries = await client.getLibraries();
        state.libraries = Array.isArray(libraries) ? libraries : [];
        state.librariesFetchedAt = Date.now();
      } catch (error) {
        logger.warn("library", `[Navidrome] Could not list libraries: ${error.message}`);
        state.libraries = state.libraries || [];
      } finally {
        state.librariesPromise = null;
      }
      return state.libraries;
    })();
  }
  return state.librariesPromise;
}

/**
 * The Navidrome library that belongs to one user, or null. A playlist made
 * by that user is aimed at copies in this library so a Navidrome view
 * filtered to it shows the playlist in full.
 */
export async function getPersonalLibraryIdForUser(username, { client = getAdminNavidromeClient() } = {}) {
  if (!client || !username) return null;
  const libraries = await getLibraries(client);
  const settings = getUserLibrariesSettings();
  return resolvePersonalLibraryId(libraries, username, settings.navidromeRootPath || settings.rootPath);
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
        const libraries = await getLibraries(client);
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
  // A mapping given in the configuration is the truth; nothing learned from a
  // path comparison may quietly replace it.
  if (state.rootsConfigured) return;
  state.aurralRoot = roots.aurralRoot;
  state.navidromeRoot = roots.navidromeRoot;
  logger.info(
    "library",
    `[Navidrome] Library roots: Aurral ${roots.aurralRoot} ↔ Navidrome ${roots.navidromeRoot || "(relative)"}`,
  );
}

/**
 * Take the roots straight from the configuration when it states them, so the
 * first lookup is an exact path query instead of a title search that has to
 * guess the mapping.
 */
function applyConfiguredRoots() {
  const configured = getNavidromeRootMapping();
  if (!configured) return false;
  state.rootsConfigured = false;
  state.aurralRoot = normalizePath(configured.aurralRoot);
  state.navidromeRoot = configured.navidromeRoot ? normalizePath(configured.navidromeRoot) : "";
  state.rootsConfigured = true;
  logger.info(
    "library",
    `[Navidrome] Library roots from configuration: Aurral ${state.aurralRoot} ↔ Navidrome ${state.navidromeRoot || "(relative)"}`,
  );
  return true;
}

applyConfiguredRoots();

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
  if (state.rootsConfigured) return { aurralRoot: state.aurralRoot, navidromeRoot: state.navidromeRoot };
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
 * Navidrome song for one canonical track (by its absolute path), as
 * { id, libraryId }. Learns the library roots on the first hit via a native
 * title search, then uses exact path lookups.
 *
 * With `preferLibraryId` the copy in that library wins when it exists;
 * otherwise the main-library copy; otherwise any copy.
 */
export async function resolveNavidromeSong(track, { client = getAdminNavidromeClient(), preferLibraryId = null } = {}) {
  if (!client || !track?.path) return null;
  const absolute = normalizePath(track.path);

  const canonicalLibraryId = await getCanonicalLibraryId(client);
  const preferred = preferLibraryId === null || preferLibraryId === undefined ? null : Number(preferLibraryId);
  const pick = (songs) =>
    (preferred !== null ? songs.find((song) => Number(song?.libraryId) === preferred) : null)
    || songs.find((song) => canonicalLibraryId !== null && Number(song?.libraryId) === canonicalLibraryId)
    || songs[0]
    || null;
  const asResult = (song) => (song?.id ? { id: String(song.id), libraryId: Number(song.libraryId) || null } : null);
  const cacheKey = (relative) => `${preferred ?? "main"}:${relative}`;

  let relative = state.aurralRoot ? relativeToRoot(absolute, state.aurralRoot) : null;
  if (relative && state.songIdByRelativePath.has(cacheKey(relative))) {
    return state.songIdByRelativePath.get(cacheKey(relative));
  }

  // An id worked out on an earlier run is still the answer, so ask the store
  // before asking Navidrome. Anything it hands back is also worth holding in
  // memory for the rest of this process.
  const storedFor = preferred !== null ? preferred : canonicalLibraryId;
  const stored = getNavidromeSongId(absolute, { libraryId: storedFor ?? null });
  if (stored?.songId) {
    const result = { id: stored.songId, libraryId: stored.libraryId };
    if (relative) rememberSongId(cacheKey(relative), result);
    return result;
  }

  if (relative) {
    let candidates = [];
    try {
      candidates = await client.findSongsByPath(relative);
    } catch (error) {
      logger.warn("library", `[Navidrome] Path lookup failed for ${relative}: ${error.message}`);
    }
    const exact = candidates.filter((song) => songPath(song) === relative);
    // Every copy found here is worth keeping, not just the one being asked
    // for: the others are what ratings and stars are written to.
    rememberNavidromeSongIds(exact.map((song) => ({
      mediaPath: absolute,
      libraryId: song?.libraryId ?? null,
      songId: song?.id,
    })));
    const match = asResult(pick(exact));
    if (match) {
      rememberSongId(cacheKey(relative), match);
      return match;
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
  const best = pick(matches.map((entry) => entry.song));
  const bestEntry = matches.find((entry) => entry.song === best);
  if (!state.aurralRoot) setRoots(bestEntry.roots);
  relative = relativeToRoot(absolute, state.aurralRoot) || bestEntry.roots.relative;
  const result = asResult(best);
  rememberSongId(cacheKey(relative), result);
  if (result) {
    rememberNavidromeSongId({ mediaPath: absolute, libraryId: result.libraryId, songId: result.id });
  }
  return result;
}

export async function resolveNavidromeSongId(track, options = {}) {
  const song = await resolveNavidromeSong(track, options);
  return song?.id || null;
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
  const exact = candidates.filter((song) => songPath(song) === relative && song?.id);
  rememberNavidromeSongIds(exact.map((song) => ({
    mediaPath: absolute,
    libraryId: song?.libraryId ?? null,
    songId: song.id,
  })));
  const ids = exact.map((song) => String(song.id));
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
  const preferred = options.preferLibraryId === null || options.preferLibraryId === undefined
    ? null
    : Number(options.preferLibraryId);
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    let song = null;
    const canonical = describeCanonicalTrack(payload);
    if (canonical) song = await resolveNavidromeSong(canonical, options);
    if (!song) {
      const id = await resolveNavidromeSongIdByMetadata(payload, options);
      if (id) song = { id, libraryId: null };
    }
    if (song) {
      resolved.push({
        payload,
        songId: song.id,
        libraryId: song.libraryId,
        // True when the person has a library of their own but this track is
        // not in it, so the entry points at the shared copy.
        outsidePreferredLibrary: preferred !== null && song.libraryId !== null && song.libraryId !== preferred,
      });
    } else {
      unresolved.push(payload);
    }
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
 * Absolute Aurral paths for Navidrome song ids, as a Map keyed by song id.
 *
 * Ids already in the store cost nothing. The rest are read one at a time
 * through the admin connection, which is the only place real paths come from,
 * and are then stored so the next caller pays nothing either.
 */
export async function mediaPathsForNavidromeSongIds(
  songIds = [],
  { client = getAdminNavidromeClient(), maxLookups = 200 } = {},
) {
  const ids = [...new Set((Array.isArray(songIds) ? songIds : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
  if (!ids.length) return new Map();

  const known = getMediaPathsForNavidromeSongIds(ids);
  const missing = ids.filter((id) => !known.has(id));
  if (!missing.length || !client) return known;

  const learned = [];
  for (const id of missing.slice(0, maxLookups)) {
    let song = null;
    try {
      song = await client.getSongNative(id);
    } catch (error) {
      logger.warn("library", `[Navidrome] Could not read song ${id}: ${error.message}`);
      continue;
    }
    const navidromePath = normalizePath(song?.path);
    if (!navidromePath) continue;
    if (!state.aurralRoot) learnRootsFromNavidromePaths([navidromePath]);
    if (!state.aurralRoot) continue;
    const absolute = joinRoot(state.aurralRoot, navidromeRelativePath(navidromePath, state.navidromeRoot));
    if (!absolute) continue;
    known.set(id, absolute);
    learned.push({ songId: id, mediaPath: absolute, libraryId: song?.libraryId ?? null });
  }
  if (learned.length) rememberNavidromeSongIds(learned);
  return known;
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

  // Which file each entry is, worked out the cheapest way first: an id already
  // in the store, then the path the entry carries itself (Navidrome sends real
  // paths only to players configured for them, and a made-up path that lands
  // on an indexed file of the same name is just as usable), and only then the
  // admin connection, which can always read a playlist's real paths.
  const idFor = (entry) => String(entry?.id ?? "");
  const absoluteById = getMediaPathsForNavidromeSongIds(list.map(idFor));
  const learned = [];

  const rebuild = (navidromePath) => {
    const path = normalizePath(navidromePath);
    if (!path || !state.aurralRoot) return null;
    return joinRoot(state.aurralRoot, navidromeRelativePath(path, state.navidromeRoot));
  };

  const claimed = [];
  for (const entry of list) {
    const id = idFor(entry);
    if (!id || absoluteById.has(id) || !entry?.path) continue;
    const absolute = rebuild(entry.path);
    if (absolute) claimed.push({ id, absolute, title: String(entry?.title || "") });
  }
  if (claimed.length) {
    const indexed = new Map(
      getCanonicalMediaFilesByPaths(claimed.map((candidate) => candidate.absolute))
        .map((file) => [file.path, file]),
    );
    const titles = getCanonicalTrackTitlesByIds([...indexed.values()].map((file) => file.trackId));
    const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    for (const candidate of claimed) {
      const file = indexed.get(candidate.absolute);
      // The title has to agree. A made-up path can otherwise land on a real
      // file with the same name under a different artist.
      if (file && same(titles.get(Number(file.trackId)) || "", candidate.title)) {
        absoluteById.set(candidate.id, candidate.absolute);
        learned.push({ songId: candidate.id, mediaPath: candidate.absolute, libraryId: null });
      }
    }
  }

  const unknown = list.filter((entry) => idFor(entry) && !absoluteById.has(idFor(entry)));
  if (unknown.length) {
    const realPaths = await realPathsForPlaylist(playlistId, client);
    if (!state.aurralRoot) learnRootsFromNavidromePaths([...realPaths.values()]);
    for (const entry of unknown) {
      const id = idFor(entry);
      const absolute = rebuild(realPaths.get(id));
      if (absolute) {
        absoluteById.set(id, absolute);
        learned.push({ songId: id, mediaPath: absolute, libraryId: null });
      }
    }
  }
  // What this read worked out saves the next one the same work.
  if (learned.length) rememberNavidromeSongIds(learned);

  const absolutePaths = list.map((entry) => absoluteById.get(idFor(entry)) || null);
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
