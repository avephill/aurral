import createCache from "./apiClients/simpleCache.js";
import {
  getNormalizedText,
  scoreTextMatch,
} from "./providers/brainzmashRanking.js";
import { getMetadataBaseUrl } from "./providers/brainzmashProvider.js";
import { searchAlbums, searchArtists } from "./providers/brainzmashProvider.js";
import { flowPlaylistConfig } from "./weeklyFlow/weeklyFlowPlaylistConfig.js";import { getCachedArtists } from "./libraryManager.js";
import { getCanonicalSearchPage } from "./libraryQueryService.js";
import { buildCanonicalLibraryReadModel } from "./canonicalLibraryReadAdapter.js";
import { getDiscoveryCache } from "./discovery/index.js";
import { compareSearchResults, getLocalMatchThreshold } from "./searchRanking.js";
import { parsePositiveInt } from "./searchService.js";

const unifiedSearchCache = createCache(60);
const catalogSearchCache = createCache(60);
const catalogSearchInflight = new Map();

const SUGGEST_LIMIT = 5;
const FULL_LIMIT = 20;
const SEARCH_CONTEXT_TTL_SECONDS = 300;
const CONTEXT_BOOST = {
  LIBRARY_TRACK: 420,
  PLAYLIST_TRACK: 360,
  PLAYLIST_TRACK_FUZZY: 220,
  PLAYLIST_ALBUM: 150,
  LIBRARY_ARTIST: 80,
  PLAYLIST_ARTIST: 48,
  EXACT_TITLE_WITH_LIBRARY_ARTIST: 36,
};

const searchContextCache = createCache(SEARCH_CONTEXT_TTL_SECONDS);

const EMPTY_SEARCH_CONTEXT = {
  playlists: [],
  artists: [],
  tracks: [],
  index: {
    libraryArtistIds: new Set(),
    libraryArtistNames: new Set(),
    libraryTrackCoreKeys: new Set(),
    libraryTrackFullKeys: new Set(),
    playlistArtistIds: new Map(),
    playlistArtistNames: new Map(),
    playlistAlbumIds: new Map(),
    playlistAlbumKeys: new Map(),
    playlistTrackIds: new Map(),
    playlistTrackCoreKeys: new Map(),
    playlistTrackFullKeys: new Map(),
  },
};

function scorePlaylistContentMatch(query, text) {
  const normalizedQuery = getNormalizedText(query);
  const normalizedText = getNormalizedText(text);
  if (!normalizedQuery || !normalizedText) return 0;
  if (normalizedQuery === normalizedText) return 100;
  if (normalizedText.includes(normalizedQuery)) return 92;
  return 0;
}

// People type "jpeg mafia" for JPEGMAFIA and "showmethebody" for Show Me the
// Body. Compare with spacing removed as well, a notch below a spaced match.
const squash = (value) => getNormalizedText(value).replace(/\s+/g, "");

function scoreLibraryMatch(query, text) {
  const spaced = scorePlaylistContentMatch(query, text);
  if (spaced === 100) return spaced;
  // A name that starts with what was typed beats one that merely contains it.
  if (spaced > 0) return getNormalizedText(text).startsWith(getNormalizedText(query)) ? 95 : spaced;
  const squashedQuery = squash(query);
  const squashedText = squash(text);
  if (!squashedQuery || squashedQuery.length < 3 || !squashedText) return 0;
  if (squashedQuery === squashedText) return 96;
  if (squashedText.includes(squashedQuery)) return 88;
  return 0;
}

function normalizeKey(value) {
  return getNormalizedText(value);
}

function addCount(map, key, increment = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + increment);
}

function hasSetValue(set, value) {
  const key = String(value || "").trim();
  return Boolean(key && set.has(key));
}

function getCount(map, value) {
  const key = String(value || "").trim();
  return key ? map.get(key) || 0 : 0;
}

function getNormalizedCount(map, value) {
  return getCount(map, normalizeKey(value));
}

function buildCoreTrackKey(artistName, title) {
  const artistKey = normalizeKey(artistName);
  const titleKey = normalizeKey(title);
  if (!artistKey || !titleKey) return "";
  return `${artistKey}\u0001${titleKey}`;
}

function buildFullTrackKey(artistName, title, albumTitle) {
  const coreKey = buildCoreTrackKey(artistName, title);
  const albumKey = normalizeKey(albumTitle);
  if (!coreKey || !albumKey) return "";
  return `${coreKey}\u0001${albumKey}`;
}

function buildAlbumKey(artistName, albumTitle) {
  const artistKey = normalizeKey(artistName);
  const albumKey = normalizeKey(albumTitle);
  if (!artistKey || !albumKey) return "";
  return `${artistKey}\u0001${albumKey}`;
}

function addArtistToIndex(index, artist, target = "library") {
  const id = String(
    artist?.mbid || artist?.foreignArtistId || artist?.artistMbid || artist?.id || "",
  ).trim();
  const name = String(artist?.artistName || artist?.name || artist?.artist || "").trim();

  if (target === "library") {
    if (id) index.libraryArtistIds.add(id);
    const nameKey = normalizeKey(name);
    if (nameKey) index.libraryArtistNames.add(nameKey);
    return;
  }

  if (id) addCount(index.playlistArtistIds, id);
  addCount(index.playlistArtistNames, normalizeKey(name));
}

function addPlaylistTrackToIndex(index, track) {
  const artistName = String(track?.artistName || track?.artist || "").trim();
  const title = String(track?.trackName || track?.title || track?.name || "").trim();
  const albumTitle = String(track?.albumName || track?.albumTitle || track?.album || "").trim();
  const artistMbid = String(track?.artistMbid || track?.artistId || "").trim();
  const albumMbid = String(
    track?.albumMbid || track?.releaseGroupMbid || track?.albumId || "",
  ).trim();
  const trackMbid = String(track?.trackMbid || track?.recordingMbid || track?.id || "").trim();

  addArtistToIndex(index, { id: artistMbid, name: artistName }, "playlist");
  if (albumMbid) addCount(index.playlistAlbumIds, albumMbid);
  addCount(index.playlistAlbumKeys, buildAlbumKey(artistName, albumTitle));
  if (trackMbid) addCount(index.playlistTrackIds, trackMbid);
  addCount(index.playlistTrackCoreKeys, buildCoreTrackKey(artistName, title));
  addCount(index.playlistTrackFullKeys, buildFullTrackKey(artistName, title, albumTitle));
}

function addLibraryTrackToIndex(index, track) {
  const artistName = String(track?.artist || track?.artistName || "").trim();
  const title = String(track?.title || track?.trackName || "").trim();
  const albumTitle = String(track?.album || track?.albumTitle || "").trim();

  index.libraryTrackCoreKeys.add(buildCoreTrackKey(artistName, title));
  const fullKey = buildFullTrackKey(artistName, title, albumTitle);
  if (fullKey) index.libraryTrackFullKeys.add(fullKey);
}

export function buildSearchContextIndex({ playlists = [], artists = [], tracks = [] } = {}) {
  const index = {
    libraryArtistIds: new Set(),
    libraryArtistNames: new Set(),
    libraryTrackCoreKeys: new Set(),
    libraryTrackFullKeys: new Set(),
    playlistArtistIds: new Map(),
    playlistArtistNames: new Map(),
    playlistAlbumIds: new Map(),
    playlistAlbumKeys: new Map(),
    playlistTrackIds: new Map(),
    playlistTrackCoreKeys: new Map(),
    playlistTrackFullKeys: new Map(),
  };

  for (const artist of Array.isArray(artists) ? artists : []) {
    addArtistToIndex(index, artist, "library");
  }

  for (const track of Array.isArray(tracks) ? tracks : []) {
    addLibraryTrackToIndex(index, track);
  }

  for (const playlist of Array.isArray(playlists) ? playlists : []) {
    for (const track of Array.isArray(playlist?.tracks) ? playlist.tracks : []) {
      addPlaylistTrackToIndex(index, track);
    }
  }

  index.libraryTrackCoreKeys.delete("");
  index.libraryTrackFullKeys.delete("");
  return index;
}

function isArtistInLibrary(item, index) {
  return (
    hasSetValue(index.libraryArtistIds, item?.id || item?.artistMbid) ||
    index.libraryArtistNames.has(normalizeKey(item?.name || item?.artistName))
  );
}

function getPlaylistArtistMatchCount(item, index) {
  return (
    getCount(index.playlistArtistIds, item?.id || item?.artistMbid) +
    getNormalizedCount(index.playlistArtistNames, item?.name || item?.artistName)
  );
}

function getPrimarySearchText(item) {
  if (item?.type === "artist") return item.name || item.artistName || "";
  if (item?.type === "album") return item.title || "";
  if (item?.type === "track") return item.title || "";
  if (item?.type === "playlist") return item.name || "";
  return "";
}

function annotateSearchItem(item, query, context = EMPTY_SEARCH_CONTEXT) {
  if (!item || typeof item !== "object") return item;
  const index = context.index || EMPTY_SEARCH_CONTEXT.index;
  const next = { ...item };
  const primaryMatchScore = scoreTextMatch(query, getPrimarySearchText(next));
  if (primaryMatchScore > 0) {
    next.primaryMatchScore = Math.max(Number(next.primaryMatchScore || 0), primaryMatchScore);
  }
  const baseContextBoost = Number(next.contextBoost || 0);
  let contextBoost = Number.isFinite(baseContextBoost) ? baseContextBoost : 0;
  const contextReasons = Array.isArray(next.contextReasons) ? [...next.contextReasons] : [];

  const addBoost = (amount, reason) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    contextBoost += amount;
    if (reason && !contextReasons.includes(reason)) {
      contextReasons.push(reason);
    }
  };

  if (next.type === "artist") {
    const inLibrary = isArtistInLibrary(next, index);
    const playlistArtistCount = getPlaylistArtistMatchCount(next, index);
    const canPersonalizeArtist =
      next.libraryBoostEligible !== false ||
      scoreTextMatch(query, next.name) >= getLocalMatchThreshold(query);
    if (inLibrary) {
      next.inLibrary = true;
      if (canPersonalizeArtist) {
        addBoost(CONTEXT_BOOST.LIBRARY_ARTIST, "library_artist");
      }
    }
    if (playlistArtistCount > 0) {
      next.inPlaylist = true;
      next.playlistMatchCount = playlistArtistCount;
      if (canPersonalizeArtist) {
        addBoost(
          CONTEXT_BOOST.PLAYLIST_ARTIST + Math.min(playlistArtistCount, 8) * 4,
          "playlist_artist",
        );
      }
    }
  }

  if (next.type === "album") {
    const artistInLibrary = isArtistInLibrary(
      { id: next.artistMbid, name: next.artistName },
      index,
    );
    const playlistArtistCount = getPlaylistArtistMatchCount(
      { id: next.artistMbid, name: next.artistName },
      index,
    );
    const playlistAlbumCount =
      getCount(index.playlistAlbumIds, next.id || next.albumMbid) +
      getCount(index.playlistAlbumIds, next.albumMbid) +
      getCount(index.playlistAlbumKeys, buildAlbumKey(next.artistName, next.title));

    if (artistInLibrary) {
      next.artistInLibrary = true;
      addBoost(CONTEXT_BOOST.LIBRARY_ARTIST, "library_artist");
    }
    if (playlistArtistCount > 0) {
      next.artistInPlaylist = true;
      addBoost(CONTEXT_BOOST.PLAYLIST_ARTIST, "playlist_artist");
    }
    if (playlistAlbumCount > 0) {
      next.inPlaylist = true;
      next.playlistMatchCount = playlistAlbumCount;
      addBoost(CONTEXT_BOOST.PLAYLIST_ALBUM, "playlist_album");
    }
    if (artistInLibrary && scoreTextMatch(query, next.title) >= 92) {
      addBoost(CONTEXT_BOOST.EXACT_TITLE_WITH_LIBRARY_ARTIST, "exact_title_library_artist");
    }
  }

  if (next.type === "track") {
    const artistInLibrary = isArtistInLibrary(
      { id: next.artistMbid, name: next.artistName },
      index,
    );
    const artistPlaylistCount = getPlaylistArtistMatchCount(
      { id: next.artistMbid, name: next.artistName },
      index,
    );
    const coreTrackKey = buildCoreTrackKey(next.artistName, next.title);
    const fullTrackKey = buildFullTrackKey(next.artistName, next.title, next.albumTitle);
    const playlistTrackCount =
      getCount(index.playlistTrackIds, next.id || next.trackMbid) +
      getCount(index.playlistTrackIds, next.trackMbid) +
      getCount(index.playlistTrackFullKeys, fullTrackKey);
    const fuzzyPlaylistTrackCount = getCount(index.playlistTrackCoreKeys, coreTrackKey);
    const libraryTrackMatch =
      index.libraryTrackCoreKeys.has(coreTrackKey) ||
      (fullTrackKey && index.libraryTrackFullKeys.has(fullTrackKey));
    const playlistAlbumCount =
      getCount(index.playlistAlbumIds, next.albumMbid) +
      getCount(index.playlistAlbumKeys, buildAlbumKey(next.artistName, next.albumTitle));

    if (libraryTrackMatch) {
      next.inLibrary = true;
      addBoost(CONTEXT_BOOST.LIBRARY_TRACK, "library_track");
    }
    if (artistInLibrary) {
      next.artistInLibrary = true;
      addBoost(CONTEXT_BOOST.LIBRARY_ARTIST, "library_artist");
    }
    if (playlistTrackCount > 0 || fuzzyPlaylistTrackCount > 0) {
      const exactCount = playlistTrackCount || 0;
      const fuzzyCount = Math.max(0, fuzzyPlaylistTrackCount - exactCount);
      const totalCount = exactCount + fuzzyCount;
      next.inPlaylist = true;
      next.playlistMatchCount = totalCount;
      addBoost(
        (exactCount > 0 ? CONTEXT_BOOST.PLAYLIST_TRACK : CONTEXT_BOOST.PLAYLIST_TRACK_FUZZY) +
          Math.min(totalCount, 8) * 5,
        exactCount > 0 ? "playlist_track" : "playlist_track_fuzzy",
      );
    } else if (playlistAlbumCount > 0) {
      next.inPlaylist = true;
      next.playlistMatchCount = playlistAlbumCount;
      addBoost(CONTEXT_BOOST.PLAYLIST_ALBUM, "playlist_album");
    } else if (artistPlaylistCount > 0) {
      next.artistInPlaylist = true;
      addBoost(CONTEXT_BOOST.PLAYLIST_ARTIST, "playlist_artist");
    }
    if (artistInLibrary && scoreTextMatch(query, next.title) >= 92) {
      addBoost(CONTEXT_BOOST.EXACT_TITLE_WITH_LIBRARY_ARTIST, "exact_title_library_artist");
    }
  }

  if (contextBoost > 0) {
    next.contextBoost = contextBoost;
    next.contextReasons = contextReasons;
  }
  return next;
}

function sliceCatalogItems(items, limit = FULL_LIMIT) {
  return (Array.isArray(items) ? items : []).filter(Boolean).slice(0, limit);
}

export function applyCatalogSearchContext(
  rawCatalog,
  query,
  context = EMPTY_SEARCH_CONTEXT,
  limit = FULL_LIMIT,
) {
  const artists = (rawCatalog?.artists || []).map((artist) =>
    annotateSearchItem(artist, query, context),
  );
  const annotatedTracks = (rawCatalog?.tracks || []).map((track) =>
    annotateSearchItem(track, query, context),
  );
  const annotatedAlbums = (rawCatalog?.albums || []).map((album) =>
    annotateSearchItem(album, query, context),
  );

  return {
    artists: sliceCatalogItems(artists, limit),
    albums: sliceCatalogItems(annotatedAlbums, limit),
    tracks: sliceCatalogItems(annotatedTracks, limit),
  };
}

function pickCatalogTopFallback(catalog) {
  if (!catalog) return null;
  return catalog.artists?.[0] || catalog.albums?.[0] || catalog.tracks?.[0] || null;
}

function normalizeMode(value) {
  const mode = String(value || "").trim();
  if (mode === "full") return "full";
  // "library" answers from the local index only: instant, and nothing from
  // outside the collection until the person asks for it.
  if (mode === "library") return "library";
  return "suggest";
}

function bucketLimit(mode, requestedLimit) {
  const fallback = mode === "full" ? FULL_LIMIT : SUGGEST_LIMIT;
  return Math.min(30, parsePositiveInt(requestedLimit, fallback));
}

function isCatalogSearchAvailable() {
  return Boolean(getMetadataBaseUrl());
}

function mapBrainzmashArtist(item) {
  return {
    type: "artist",
    source: "brainzmash",
    id: item.id,
    key: item.id,
    name: item.name,
    sortName: item.sortName || item.name,
    inLibrary: false,
    hasMbid: Boolean(item.id),
    score: item.score || 0,
  };
}

function mapBrainzmashAlbum(item) {
  return {
    type: "album",
    source: "brainzmash",
    id: item.id,
    key: item.id,
    title: item.title || "Untitled Release",
    artistName: item.artistName || "Unknown Artist",
    artistMbid: item.artistId || null,
    primaryType: item.type || null,
    secondaryTypes: Array.isArray(item.secondaryTypes) ? item.secondaryTypes : [],
    releaseDate: item.releaseDate || null,
    coverUrl: item.coverUrl || null,
    inLibrary: false,
    score: item.score || 0,
  };
}

async function searchBrainzmashCatalog(query, limit) {
  const RELEVANCE_THRESHOLD = 60;
  const trimmed = String(query || "").trim();

  const [artistSettled, albumSettled] = await Promise.allSettled([
    searchArtists(trimmed, { limit, offset: 0 }),
    searchAlbums(trimmed, {
      limit,
      offset: 0,
      releaseTypes: [],
      sort: "relevance",
    }),
  ]);

  const artistResult =
    artistSettled.status === "fulfilled" ? artistSettled.value : null;
  const albumResult =
    albumSettled.status === "fulfilled" ? albumSettled.value : null;

  if (artistSettled.status === "rejected") {
    console.warn("[UnifiedSearch] BrainzMash artist search failed:", artistSettled.reason?.message);
  }
  if (albumSettled.status === "rejected") {
    console.warn("[UnifiedSearch] BrainzMash album search failed:", albumSettled.reason?.message);
  }

  const scoredArtists = artistResult
    ? (artistResult.items || [])
        .map((artist) => ({
          artist,
          relevance: scoreTextMatch(trimmed, artist.name || ""),
        }))
        .filter((entry) => entry.relevance >= RELEVANCE_THRESHOLD)
        .sort((a, b) => b.relevance - a.relevance)
    : [];

  return {
    artists: scoredArtists.map((entry) => {
      const item = { ...entry.artist, score: entry.relevance };
      return mapBrainzmashArtist(item);
    }),
    albums: albumResult ? (albumResult.items || []).map(mapBrainzmashAlbum) : [],
    tracks: [],
  };
}

async function searchCatalog(query, limit) {
  const cacheKey = String(query || "").trim().toLowerCase();
  let catalog = catalogSearchCache.get(cacheKey);
  if (!catalog) {
    let pending = catalogSearchInflight.get(cacheKey);
    if (!pending) {
      pending = searchBrainzmashCatalog(query, 30)
        .then((result) => {
          catalogSearchCache.set(cacheKey, result);
          return result;
        })
        .finally(() => catalogSearchInflight.delete(cacheKey));
      catalogSearchInflight.set(cacheKey, pending);
    }
    catalog = await pending;
  }
  const sliced = {
    artists: sliceCatalogItems(catalog.artists, limit),
    albums: sliceCatalogItems(catalog.albums, limit),
    tracks: sliceCatalogItems(catalog.tracks, limit),
  };
  return {
    ...sliced,
    top: pickCatalogTopFallback(sliced),
  };
}

function getDiscoverPlaylistsForSearch(user) {
  try {
    const cache = user ? getDiscoveryCache(user) : getDiscoveryCache();
    return (Array.isArray(cache?.discoverPlaylists) ? cache.discoverPlaylists : [])
      .map((playlist) => {
        const presetId = String(playlist?.presetId || playlist?.id || "").trim();
        const name = String(playlist?.name || "").trim();
        if (!presetId || !name) return null;
        const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
        return {
          id: playlist.adoptedPlaylistId || `discover:${presetId}`,
          name,
          tracks,
          trackCount: tracks.length,
          discoverPresetId: presetId,
          sourceFlowId: playlist.adoptedFlowId || null,
          isDiscoverPlaylist: !playlist.adoptedPlaylistId,
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.warn("[UnifiedSearch] Failed to read discover playlists:", error.message);
    return [];
  }
}

function getAllPlaylistsForSearch(user) {
  const shared = getVisiblePlaylistsForUser(user);
  const discover = getDiscoverPlaylistsForSearch(user);
  const seen = new Set(shared.map((playlist) => playlist.id));
  return [...shared, ...discover.filter((playlist) => !seen.has(playlist.id))];
}

function getVisiblePlaylistsForUser(user) {
  try {
    return user ? flowPlaylistConfig.getSharedPlaylistsForUser(user) : [];
  } catch (error) {
    console.warn("[UnifiedSearch] Failed to read playlists:", error.message);
    return [];
  }
}

function loadSearchContext(user) {
  const playlists = getAllPlaylistsForSearch(user);
  const artists = getCachedArtists();
  const context = {
    playlists,
    artists: Array.isArray(artists) ? artists : [],
    tracks: [],
  };
  return {
    ...context,
    index: buildSearchContextIndex(context),
  };
}

function getSearchContext(user) {
  const cacheKey = user?.id || "anon";
  const cached = searchContextCache.get(cacheKey);
  if (cached) return cached;

  const context = loadSearchContext(user);
  searchContextCache.set(cacheKey, context);
  return context;
}

export function clearSearchContextCache() {
  searchContextCache.flushAll();
}

export function searchLocalFromData(
  query,
  { artists = [], tracks = [] } = {},
  limit = SUGGEST_LIMIT,
) {
  const normalizedQuery = getNormalizedText(query);
  if (!normalizedQuery) {
    return { artists: [], tracks: [] };
  }

  const artistResults = artists
    .map((artist) => {
      const name = String(artist?.artistName || artist?.name || "").trim();
      const mbid = artist?.mbid || artist?.foreignArtistId || artist?.artistMbid || artist?.id || null;
      if (!name || !mbid) return null;
      const score = scoreLibraryMatch(query, name);
      if (score <= 0) return null;
      return {
        type: "artist",
        source: "library",
        id: mbid,
        key: `library-artist:${mbid}`,
        name,
        sortName: name,
        inLibrary: true,
        hasMbid: true,
        score,
      };
    })
    .filter(Boolean)
    .sort(compareSearchResults)
    .slice(0, limit);

  const trackResults = tracks
    .map((track) => {
      const title = String(track?.title || "").trim();
      const artistName = String(track?.artist || track?.artistName || "").trim();
      const albumTitle = String(track?.album || track?.albumTitle || "").trim();
      if (!title) return null;
      const score = Math.max(
        scoreLibraryMatch(query, artistName),
        scoreLibraryMatch(query, title),
        scoreLibraryMatch(query, `${artistName} ${title}`.trim()),
      );
      if (score <= 0) return null;
      return {
        type: "track",
        source: "library",
        id: track.id,
        key: track.id,
        title,
        artistName: artistName || "Unknown Artist",
        albumTitle: albumTitle || null,
        streamPath: track.streamPath || null,
        inLibrary: true,
        score,
      };
    })
    .filter(Boolean)
    .sort(compareSearchResults)
    .slice(0, limit);

  return {
    artists: artistResults,
    tracks: trackResults,
  };
}

/**
 * Artists, albums and tracks from the canonical library for the suggestion
 * list. Goes through the library's own search index, so it is fast and needs
 * no outside call. Albums and tracks point at the library's album page.
 *
 * getCanonicalSearchPage returns raw artists plus one library object each for
 * albums and tracks; the read adapter turns those into rows with file state.
 */
function searchLibraryCatalog(query, limit) {
  const runPage = (value) => getCanonicalSearchPage({
    source: "all",
    availableOnly: true,
    query: value,
    artistLimit: limit,
    albumLimit: limit,
    songLimit: limit,
  });
  const pageIsEmpty = (value) =>
    !value.artists?.length && !value.albums?.albums?.length && !value.tracks?.tracks?.length;
  let page;
  try {
    page = runPage(query);
    // The index filters on the typed text as well as its trigrams, so
    // "jpeg mafia" misses JPEGMAFIA there. Try again without the spaces.
    const squashedQuery = squash(query);
    if (pageIsEmpty(page) && squashedQuery.length >= 3 && squashedQuery !== getNormalizedText(query)) {
      page = runPage(squashedQuery);
    }
  } catch (error) {
    console.warn("[UnifiedSearch] Library catalog search failed:", error.message);
    return { artists: [], albums: [], tracks: [] };
  }

  const artists = (Array.isArray(page.artists) ? page.artists : [])
    .map((artist) => {
      const name = String(artist?.name || "").trim();
      if (!name) return null;
      const score = scoreLibraryMatch(query, name);
      return {
        type: "artist",
        source: "library",
        id: artist.mbid || null,
        key: `library-artist:${artist.mbid || artist.id}`,
        canonicalArtistId: artist.id,
        name,
        sortName: artist.sortName || name,
        inLibrary: true,
        hasMbid: Boolean(artist.mbid),
        score: score > 0 ? score : 80,
      };
    })
    .filter(Boolean)
    .sort(compareSearchResults)
    .slice(0, limit);

  const albumModel = buildCanonicalLibraryReadModel(page.albums || { artists: [], albums: [], tracks: [] });
  const albumArtists = new Map(albumModel.artists.map((artist) => [artist.id, artist]));
  const albums = albumModel.albums
    .map((album) => {
      const artist = albumArtists.get(album.artistId) || null;
      const score = Math.max(
        scoreLibraryMatch(query, album.title),
        scoreLibraryMatch(query, `${artist?.name || ""} ${album.title}`.trim()),
      );
      return {
        type: "album",
        source: "library",
        id: album.releaseGroupMbid || album.mbid || `library-album:${album.id}`,
        key: `library-album:${album.id}`,
        canonicalAlbumId: album.id,
        title: album.title,
        artistName: artist?.name || album.albumArtist || "",
        artistMbid: artist?.mbid || null,
        releaseGroupMbid: album.releaseGroupMbid || null,
        releaseDate: album.releaseDate || null,
        coverUrl: album.coverUrl || null,
        inLibrary: true,
        score: score > 0 ? score : 80,
      };
    })
    .sort(compareSearchResults)
    .slice(0, limit);

  const trackModel = buildCanonicalLibraryReadModel(page.tracks || { artists: [], albums: [], tracks: [] });
  const trackArtists = new Map(trackModel.artists.map((artist) => [artist.id, artist]));
  const trackAlbums = new Map(trackModel.albums.map((album) => [album.id, album]));
  const tracks = trackModel.tracks
    .filter((track) => track.hasFile)
    .map((track) => {
      const album = trackAlbums.get(track.albumId) || null;
      const artist = album ? trackArtists.get(album.artistId) || null : null;
      const artistName = artist?.name || track.artistName || "";
      const score = Math.max(
        scoreLibraryMatch(query, track.title),
        scoreLibraryMatch(query, `${artistName} ${track.title}`.trim()),
      );
      return {
        type: "track",
        source: "library",
        id: `library-track:${track.id}`,
        key: `library-track:${track.id}`,
        canonicalTrackId: track.id,
        canonicalAlbumId: track.albumId,
        title: track.title,
        artistName: artistName || "Unknown Artist",
        artistMbid: artist?.mbid || null,
        albumTitle: album?.title || null,
        albumMbid: album?.releaseGroupMbid || album?.mbid || null,
        trackMbid: track.mbid || null,
        streamPath: `/library/canonical-stream/${encodeURIComponent(track.albumId)}/${encodeURIComponent(track.id)}`,
        inLibrary: true,
        score: score > 0 ? score : 80,
      };
    })
    .sort(compareSearchResults)
    .slice(0, limit);

  return { artists, albums, tracks };
}

async function searchLocalLibrary(query, limit, user) {
  try {
    const context = getSearchContext(user);
    return {
      context,
      library: searchLocalFromData(
        query,
        {
          artists: context.artists,
          tracks: context.tracks,
        },
        limit,
      ),
    };
  } catch (error) {
    console.warn("[UnifiedSearch] Local search context failed:", error.message);
    const playlists = getAllPlaylistsForSearch(user);
    const fallbackContext = {
      playlists,
      artists: [],
      tracks: [],
      index: buildSearchContextIndex({ playlists }),
    };
    return {
      context: fallbackContext,
      library: searchLocalFromData(query, {}, limit),
    };
  }
}

export async function searchUnified(query, { mode = "suggest", limit, user = null } = {}) {
  const trimmed = String(query || "").trim();
  const normalizedMode = normalizeMode(mode);
  const perBucketLimit = bucketLimit(normalizedMode, limit);
  const catalogSearchConfigured = isCatalogSearchAvailable();

  if (!trimmed) {
    return {
      query: "",
      mode: normalizedMode,
      top: null,
      library: { artists: [], tracks: [] },
      catalog: { artists: [], albums: [], tracks: [] },
      localSearchConfigured: catalogSearchConfigured,
      filters: ["all", "artists", "albums", "singles"],
    };
  }

  const cacheKey = `${normalizedMode}:${perBucketLimit}:${trimmed.toLowerCase()}:${user?.id || "anon"}`;
  const cached = unifiedSearchCache.get(cacheKey);
  if (cached) return cached;

  if (normalizedMode === "library") {
    const local = await searchLocalLibrary(trimmed, perBucketLimit, user);
    const { artists, albums, tracks } = searchLibraryCatalog(trimmed, perBucketLimit);
    // The canonical index is the source of truth; the cached provider list
    // only adds artists it does not have (it is empty until a refresh runs).
    const seenArtists = new Set(artists.map((artist) => getNormalizedText(artist.name)));
    const libraryArtists = [
      ...artists,
      ...(local?.library?.artists || []).filter((artist) => !seenArtists.has(getNormalizedText(artist.name))),
    ].slice(0, perBucketLimit);
    const libraryTracks = [...tracks, ...(local?.library?.tracks || [])].slice(0, perBucketLimit);
    const response = {
      query: trimmed,
      mode: normalizedMode,
      top: null,
      library: { artists: libraryArtists, albums, tracks: libraryTracks },
      catalog: { artists: [], albums: [], tracks: [] },
      localSearchConfigured: catalogSearchConfigured,
      filters: ["all", "artists", "albums", "singles"],
    };
    unifiedSearchCache.set(cacheKey, response);
    return response;
  }

  const [fetchedCatalog, local] = await Promise.all([
    searchCatalog(trimmed, perBucketLimit),
    searchLocalLibrary(trimmed, perBucketLimit, user),
  ]);
  const library = local?.library || { artists: [], tracks: [] };
  const context = local?.context || EMPTY_SEARCH_CONTEXT;
  const catalog = applyCatalogSearchContext(fetchedCatalog, trimmed, context, perBucketLimit);
  const rawTop = fetchedCatalog?.top || pickCatalogTopFallback(catalog);
  const top = rawTop ? annotateSearchItem(rawTop, trimmed, context) : null;

  const response = {
    query: trimmed,
    mode: normalizedMode,
    top: top?.type ? top : null,
    library: {
      artists: library.artists,
      tracks: library.tracks,
    },
    catalog,
    localSearchConfigured: catalogSearchConfigured,
    filters: ["all", "artists", "albums", "singles"],
  };

  unifiedSearchCache.set(cacheKey, response);
  return response;
}
