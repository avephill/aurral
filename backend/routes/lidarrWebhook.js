import express from "express";
import { isLidarrWebhookKey } from "../middleware/auth.js";
import { recordAlbumImportCompleted } from "../services/aurralHistoryService.js";
import { scheduleUserLibraryReconcile } from "../services/userLibraryService.js";

export const LIDARR_WEBHOOK_KEY_HEADER = "x-webhook-key";

/**
 * Only Lidarr's own webhook key opens this endpoint. A session or the admin
 * API key does not: the endpoint is for Lidarr, and Lidarr is given a key
 * that can do nothing else. The global auth middleware lets the path through
 * so this check is the only one.
 */
export const requireLidarrWebhookKey = (req, res, next) => {
  if (isLidarrWebhookKey(req.headers?.[LIDARR_WEBHOOK_KEY_HEADER])) return next();
  return res.status(401).json({
    error: "Unauthorized",
    message: "Send the Lidarr webhook key from Psalter's Settings in an X-Webhook-Key header.",
  });
};

export const handleLidarrWebhook = (req, res) => {
  const body = req.body || {};
  const eventType = String(body.eventType || body.EventType || "")
    .trim()
    .toLowerCase();
  if (eventType === "download" || eventType === "rename" || eventType === "artistadd") {
    scheduleUserLibraryReconcile();
  }
  if (eventType !== "download") return res.status(204).end();

  const album = body.album || body.Album || {};
  // Lidarr sends the artist beside the album, not inside it. The nested form
  // is still read in case another sender puts it there.
  const artist = body.artist || body.Artist || album.artist || album.Artist || {};
  const entry = recordAlbumImportCompleted({
    albumId: album.id ?? album.Id,
    albumName: album.title ?? album.Title,
    artistName: artist.artistName ?? artist.ArtistName ?? artist.name ?? artist.Name,
    artistMbid:
      artist.foreignArtistId ?? artist.ForeignArtistId ?? artist.mbId ?? artist.MbId,
  });

  return res.json({ handled: Boolean(entry) });
};

const router = express.Router();
router.post("/", requireLidarrWebhookKey, handleLidarrWebhook);

export default router;
