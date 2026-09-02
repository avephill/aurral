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

router.post("/sync", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await reconcileUserLibraries();
    res.json(result);
  } catch (error) {
    handleError(res, error, "Failed to sync user libraries");
  }
});

export default router;
