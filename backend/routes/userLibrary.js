import express from "express";
import { requireAuth, requireAdmin } from "../middleware/requirePermission.js";
import { noCache } from "../middleware/cache.js";
import {
  getUserLibrariesSettings,
  getUserLibraryMembership,
  getUserLibraryCatalog,
  setUserLibraryMembership,
  reconcileUserLibraries,
  getNewToServer,
  listUserLibraryAlbums,
  removeUserLibraryAlbums,
  addUserLibraryAlbumsByMbid,
  removeUserLibraryAlbumsByMbid,
  getCompilationCatalog,
} from "../services/userLibraryService.js";
import { logger } from "../services/logger.js";

const router = express.Router();

const handleError = (res, error, fallbackMessage) => {
  const status = Number(error?.statusCode) || 500;
  if (status >= 500) {
    logger.error("library", `[UserLibraries] ${fallbackMessage}:`, error);
  }
  res.status(status).json({ error: error?.message || fallbackMessage });
};

router.get("/", requireAuth, noCache, async (req, res) => {
  try {
    const config = getUserLibrariesSettings();
    if (!config.enabled) {
      return res.json({ enabled: false, artists: [] });
    }
    const membership = await getUserLibraryMembership(req.user, {
      forceRefresh: req.query.refresh === "true",
    });
    res.json(membership);
  } catch (error) {
    handleError(res, error, "Failed to load user library");
  }
});

// Every main-library artist with the viewer's membership, for bulk editing.
router.get("/catalog", requireAuth, noCache, async (req, res) => {
  try {
    res.json(await getUserLibraryCatalog(req.user));
  } catch (error) {
    handleError(res, error, "Failed to load library catalog");
  }
});

router.get("/new", requireAuth, noCache, async (req, res) => {
  try {
    const result = await getNewToServer(req.user, {
      days: req.query.days,
      limit: req.query.limit,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, "Failed to load new-to-server albums");
  }
});

router.post("/artists", requireAuth, async (req, res) => {
  try {
    const result = await setUserLibraryMembership(req.user, req.body?.mbid, true);
    if (result.missing.length) {
      return res.status(404).json({
        error: "Artist is not in the main library",
        missing: result.missing,
      });
    }
    if (result.refused.length && !result.changed.length) {
      return res.status(400).json({
        error: "Compilations are added one at a time, from Compilations in Bulk migration",
        refused: result.refused,
      });
    }
    res.json({ success: true, changed: result.changed });
  } catch (error) {
    handleError(res, error, "Failed to add artist to user library");
  }
});

router.post("/artists/bulk", requireAuth, async (req, res) => {
  const action = req.body?.action === "remove" ? "remove" : "add";
  try {
    const result = await setUserLibraryMembership(req.user, req.body?.mbids, action === "add");
    res.json({
      success: true,
      action,
      changed: result.changed,
      missing: result.missing,
      refused: result.refused,
    });
  } catch (error) {
    handleError(res, error, `Failed to bulk-${action} artists in user library`);
  }
});

router.delete("/artists/:mbid", requireAuth, async (req, res) => {
  try {
    const result = await setUserLibraryMembership(req.user, req.params.mbid, false);
    res.json({ success: true, changed: result.changed });
  } catch (error) {
    handleError(res, error, "Failed to remove artist from user library");
  }
});

// Single albums, put in someone's library without the rest of the artist -
// usually for a playlist shared with them.
router.get("/albums", requireAuth, noCache, (req, res) => {
  try {
    res.json({ albums: listUserLibraryAlbums(req.user.username) });
  } catch (error) {
    handleError(res, error, "Failed to load your albums");
  }
});

// Albums picked one at a time, by MusicBrainz release group: compilations,
// which are never added whole with Various Artists.
router.post("/albums", requireAuth, (req, res) => {
  const mbids = Array.isArray(req.body?.mbids) ? req.body.mbids.map(String).filter(Boolean) : [];
  if (!mbids.length) return res.status(400).json({ error: "No albums given" });
  if (!getUserLibrariesSettings().enabled) return res.status(400).json({ error: "User libraries are not enabled" });
  try {
    return res.json({ success: true, ...addUserLibraryAlbumsByMbid(req.user.username, mbids, "picked") });
  } catch (error) {
    return handleError(res, error, "Failed to add albums to your library");
  }
});

router.post("/albums/remove", requireAuth, (req, res) => {
  const folders = Array.isArray(req.body?.folders) ? req.body.folders.map(String) : [];
  const mbids = Array.isArray(req.body?.mbids) ? req.body.mbids.map(String).filter(Boolean) : [];
  if (!folders.length && !mbids.length) return res.status(400).json({ error: "No albums given" });
  try {
    const removed = (folders.length ? removeUserLibraryAlbums(req.user.username, folders) : 0)
      + (mbids.length ? removeUserLibraryAlbumsByMbid(req.user.username, mbids) : 0);
    return res.json({ success: true, removed });
  } catch (error) {
    return handleError(res, error, "Failed to remove albums from your library");
  }
});

router.get("/compilations", requireAuth, noCache, (req, res) => {
  try {
    res.json(getCompilationCatalog(req.user));
  } catch (error) {
    handleError(res, error, "Failed to load the compilations");
  }
});

router.post("/sync", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await reconcileUserLibraries();
    res.json(result);
  } catch (error) {
    handleError(res, error, "Failed to sync user libraries");
  }
});

export default router;
