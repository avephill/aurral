import express from "express";
import { requireAuth } from "../middleware/requirePermission.js";
import { noCache } from "../middleware/cache.js";
import { isNavidromeUserAuthEnabled } from "../config/featureFlags.js";
import { isNavidromeAuthError } from "../services/navidromeUserClient.js";
import {
  lookupTrackAnnotations,
  setTrackRating,
  setTrackStarred,
} from "../services/navidromeAnnotations.js";

/**
 * Ratings and stars held in Navidrome, read and written as the signed-in
 * user. See services/navidromeAnnotations.js.
 */

const router = express.Router();
router.use(requireAuth);

function guard(res) {
  if (isNavidromeUserAuthEnabled()) return true;
  res.status(404).json({ error: "Navidrome ratings are not enabled" });
  return false;
}

function sendError(res, error, fallback) {
  if (isNavidromeAuthError(error)) {
    return res.status(502).json({
      error: "Navidrome did not accept the user",
      message: "Navidrome rejected the trusted username header.",
    });
  }
  const status = Number(error?.status) || Number(error?.response?.status) || 502;
  return res.status(status >= 400 && status < 600 ? status : 502).json({
    error: fallback,
    message: error?.message || fallback,
  });
}

router.post("/lookup", noCache, async (req, res) => {
  if (!guard(res)) return undefined;
  const refs = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
  if (!refs.length) return res.json({ enabled: true, connected: true, tracks: {} });
  try {
    return res.json(await lookupTrackAnnotations(req.user, refs));
  } catch (error) {
    return sendError(res, error, "Could not read ratings from Navidrome");
  }
});

router.put("/track", noCache, async (req, res) => {
  if (!guard(res)) return undefined;
  const { trackId, albumId, rating } = req.body || {};
  if (rating === undefined || rating === null || Number.isNaN(Number(rating))) {
    return res.status(400).json({ error: "rating is required (0 clears it)" });
  }
  try {
    return res.json(await setTrackRating(req.user, { trackId, albumId }, rating));
  } catch (error) {
    return sendError(res, error, "Could not save the rating to Navidrome");
  }
});

router.put("/track/star", noCache, async (req, res) => {
  if (!guard(res)) return undefined;
  const { trackId, albumId, starred } = req.body || {};
  if (typeof starred !== "boolean") return res.status(400).json({ error: "starred must be true or false" });
  try {
    return res.json(await setTrackStarred(req.user, { trackId, albumId }, starred));
  } catch (error) {
    return sendError(res, error, "Could not update the star in Navidrome");
  }
});

export default router;
