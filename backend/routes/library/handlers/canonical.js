import { noCache } from "../../../middleware/cache.js";
import { requireAuth } from "../../../middleware/requirePermission.js";
import { buildImageProxyUrl } from "../../../services/imageProxyService.js";
import {
  getCanonicalFavoriteTargetKeys,
  getCanonicalLibraryPage,
} from "../../../services/libraryQueryService.js";
import {
  getStarredIdentityKeys,
  getStarredWithLibrary,
  starMany,
  unstarMany,
} from "../../../services/subsonicLibraryService.js";
import {
  importStarsFromNavidrome,
  mirrorFavoritesToNavidrome,
} from "../../../services/navidromeAnnotations.js";
import { getUserTrackRatings } from "../../../services/navidromeUserRatings.js";
import { isNavidromeUserAuthEnabled } from "../../../config/featureFlags.js";
import {
  getLibraryScanStatus,
  getScheduledLibraryScanJobId,
  scheduleLibraryScan,
} from "../../../services/libraryScanWorker.js";

// Anything named like a path is a path on this server and stays here. The one
// exception is streamPath, which is a URL on Aurral's own API made of two ids
// and says nothing about the filesystem; stripping it left callers with a
// track they could see and could not play.
const PUBLIC_PATH_KEYS = new Set(["streampath"]);
const isFilesystemPathKey = (key) => {
  const lower = key.toLowerCase();
  return lower.endsWith("path") && !PUBLIC_PATH_KEYS.has(lower);
};

export function stripFilesystemPaths(value) {
  if (Array.isArray(value)) return value.map(stripFilesystemPaths);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isFilesystemPathKey(key))
      .map(([key, entry]) => [key, stripFilesystemPaths(entry)]),
  );
}

function getAlbumCoverUrl(album) {
  const image = (Array.isArray(album?.metadata?.images) ? album.metadata.images : []).find(
    (entry) => /^https?:\/\//i.test(entry?.remoteUrl || entry?.imageUrl || entry?.url || ""),
  );
  const source = image?.remoteUrl || image?.imageUrl || image?.url;
  return /^https?:\/\//i.test(source || "") ? buildImageProxyUrl(source) : null;
}

export const publicLibraryJsonReplacer = (key, value) =>
  isFilesystemPathKey(key) ? undefined : value;

const publicEntity = (kind, entity, favoriteKeys) => favoriteKeys
  ? { ...entity, userFavorite: favoriteKeys.has(`${kind}:${entity.identityKey}`) }
  : entity;

const publicAlbum = (album, favoriteKeys) => ({
  ...album,
  coverUrl: album.coverUrl || getAlbumCoverUrl(album),
  ...(favoriteKeys
    ? { userFavorite: favoriteKeys.has(`album:${album.identityKey}`) }
    : {}),
});

export function buildPublicLibrary(library, favoriteKeys = null) {
  return {
    artists: library.artists.map((artist) => publicEntity("artist", artist, favoriteKeys)),
    albums: library.albums.map((album) => publicAlbum(album, favoriteKeys)),
    tracks: library.tracks.map((track) => publicEntity("song", track, favoriteKeys)),
  };
}

function toPublicLibrary(library, favoriteKeys = null) {
  return stripFilesystemPaths(buildPublicLibrary(library, favoriteKeys));
}

export function toPublicLibraryPage(page, favoriteKeys = null) {
  const collections = toPublicLibrary(page, favoriteKeys);
  const items = page.kind === "artists"
    ? collections.artists
    : page.kind === "albums"
      ? collections.albums
      : page.kind === "tracks"
        ? collections.tracks
        : stripFilesystemPaths(page.items);
  return {
    ...stripFilesystemPaths(page),
    ...collections,
    items,
  };
}

export function registerCanonical(router) {
  router.post("/refresh", requireAuth, (_req, res) => {
    const jobId = scheduleLibraryScan({ force: true });
    res.status(202).json({
      queued: true,
      jobId,
      status: getLibraryScanStatus(jobId),
    });
  });

  router.get("/refresh", requireAuth, noCache, (_req, res) => {
    const jobId = getScheduledLibraryScanJobId();
    return res.json({
      jobId,
      status: jobId == null ? null : getLibraryScanStatus(jobId),
    });
  });

  router.get("/refresh/:jobId", requireAuth, noCache, (req, res) => {
    const status = getLibraryScanStatus(req.params.jobId);
    if (!status || status.status === "unknown") {
      return res.status(404).json({ error: "Library scan not found" });
    }
    return res.json(status);
  });

  // Everything the Library home shows, per person, answered from a cache kept
  // on the server (see libraryHomeService). Favourites are read fresh on every
  // request; `refreshing` says a newer answer is being built.
  router.get("/home", requireAuth, noCache, async (req, res) => {
    try {
      const { getLibraryHome } = await import("../../../services/libraryHomeService.js");
      const home = await getLibraryHome(req.user);
      const favoriteKeys = getStarredIdentityKeys(req.user);
      return res.json({
        recentAlbums: toPublicLibraryPage(home.recentAlbums, favoriteKeys),
        recentArtists: stripFilesystemPaths(home.recentArtists),
        topRated: home.topRated,
        topRatedLibrary: toPublicLibrary(home.topRatedLibrary, favoriteKeys),
        topRatedPending: home.topRatedPending === true,
        stats: home.stats,
        refreshing: home.refreshing === true,
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to build the library home",
        message: error.message,
      });
    }
  });

  router.get("/canonical", noCache, async (req, res) => {
    try {
      const favoriteKeys = req.user ? getStarredIdentityKeys(req.user) : null;
      const kind = typeof req.query.kind === "string" ? req.query.kind.trim() : "";
      const requestedPageSize = typeof req.query.pageSize === "string"
        ? Number(req.query.pageSize)
        : NaN;
      if (
        !kind ||
        !Number.isSafeInteger(requestedPageSize) ||
        requestedPageSize < 1 ||
        requestedPageSize > 100
      ) {
        return res.status(400).json({
          error: "kind and pageSize (1-100) are required",
        });
      }
      // Rating and favourite filters narrow a track page to the signed-in
      // person's own tracks. Ratings live in Navidrome; favourites here.
      let trackIds;
      let trackIdentityKeys;
      let excludeTrackIds;
      const minRating = kind === "tracks" ? Math.round(Number(req.query.minRating) || 0) : 0;
      const unratedOnly = kind === "tracks" && req.query.unrated === "true";
      if ((minRating >= 1 && minRating <= 5) || unratedOnly) {
        const result = req.user ? await getUserTrackRatings(req.user) : { connected: false };
        if (!result.connected) {
          return res.status(503).json({ error: "Ratings are not available from Navidrome" });
        }
        if (unratedOnly) {
          excludeTrackIds = [...result.ratings.keys()];
        } else {
          trackIds = [...result.ratings]
            .filter(([, rating]) => rating >= minRating)
            .map(([trackId]) => trackId);
        }
      }
      if (kind === "tracks" && req.query.favorites === "true") {
        trackIdentityKeys = [...(favoriteKeys || [])]
          .filter((key) => key.startsWith("song:"))
          .map((key) => key.slice("song:".length));
      }
      // "mine" narrows albums to the signed-in person's library, the same
      // artists Discover uses. With personal libraries off there is no
      // narrower library, so nothing is filtered.
      let artistIds;
      if (kind === "albums" && req.query.scope === "mine" && req.user) {
        const { scopeCanonicalArtistsToUser } = await import(
          "../../../services/userLibraryService.js"
        );
        const scoped = await scopeCanonicalArtistsToUser(req.user);
        if (Array.isArray(scoped)) artistIds = scoped.map((artist) => artist.id);
      }
      // Sorting tracks by rating needs the person's own ratings.
      let trackRatings;
      if (kind === "tracks" && req.query.sort === "rating" && req.user) {
        const result = await getUserTrackRatings(req.user);
        if (result.connected) trackRatings = Object.fromEntries(result.ratings);
      }
      const page = getCanonicalLibraryPage({
        source: req.query.source,
        availableOnly: req.query.availableOnly === "true",
        kind,
        page: req.query.page,
        pageSize: requestedPageSize,
        query: req.query.query,
        genre: req.query.genre,
        sort: req.query.sort,
        direction: req.query.direction,
        artistId: req.query.artistId,
        albumId: req.query.albumId,
        trackIds,
        trackIdentityKeys,
        excludeTrackIds,
        artistIds,
        trackRatings,
      });
      // Songs carry their own artist from the file tags, so a compilation
      // lists who sings each one rather than "Various Artists". A page is at
      // most 100 tracks, and each file's tags are read once until it changes.
      if (kind === "tracks") {
        const { addTrackPerformers } = await import("../../../services/trackPerformerTags.js");
        await addTrackPerformers(page.tracks);
      }
      return res.json(toPublicLibraryPage(page, favoriteKeys));
    } catch (error) {
      if (
        error.message.startsWith("Unsupported library source:") ||
        error.message.startsWith("Unsupported library page kind:")
      ) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({
        error: "Failed to query canonical library",
        message: error.message,
      });
    }
  });

  // Stars set in a Navidrome client are pulled in when the favourites are
  // read, so a heart added on a phone turns up here on its own. Throttled per
  // person, and never allowed to hold the answer up for long: whatever the
  // pass finds after that lands in the next read.
  const STAR_IMPORT_INTERVAL_MS = 5 * 60 * 1000;
  const STAR_IMPORT_WAIT_MS = 2_500;
  const lastStarImport = new Map();

  router.get("/favorites", requireAuth, noCache, async (req, res) => {
    if (isNavidromeUserAuthEnabled() && req.user?.id) {
      const last = lastStarImport.get(req.user.id) || 0;
      if (Date.now() - last >= STAR_IMPORT_INTERVAL_MS) {
        lastStarImport.set(req.user.id, Date.now());
        await Promise.race([
          importStarsFromNavidrome(req.user).catch(() => null),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, STAR_IMPORT_WAIT_MS);
            timer.unref?.();
          }),
        ]);
      }
    }
    const { starred, library } = getStarredWithLibrary(req.user);
    res.json({ ...starred, library: toPublicLibrary(library) });
  });

  router.post("/favorites", requireAuth, noCache, (req, res) => {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    if (ids.length === 0 || ids.length > 100 || typeof req.body?.starred !== "boolean") {
      return res.status(400).json({
        error: "ids and starred are required",
      });
    }

    if (req.body.starred) {
      const canonicalIds = ids.filter((id) => /^(artist|album|song):.+/.test(id));
      const validTargets = getCanonicalFavoriteTargetKeys(canonicalIds);
      if (canonicalIds.some((id) => !validTargets.has(id))) {
        return res.status(400).json({ error: "Invalid favorite target" });
      }
    }

    const changed = req.body.starred
      ? starMany(req.user, ids, { skipCanonicalValidation: true })
      : unstarMany(req.user, ids);
    if (!changed) {
      return res.status(400).json({ error: "Invalid favorite target" });
    }
    // A heart here is a star in Navidrome for the same user. Best effort and
    // off the request path: Aurral's own favourite has already been saved.
    if (isNavidromeUserAuthEnabled()) {
      mirrorFavoritesToNavidrome(req.user, ids, req.body.starred).catch(() => {});
    }
    return res.json({ changedIds: ids });
  });
}

export { toPublicLibrary };
