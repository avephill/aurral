import express from "express";
import { noCache } from "../middleware/cache.js";
import { requireAuth } from "../middleware/requirePermission.js";
import {
  createRecommendation,
  dismissRecommendation,
  getListeningHighlights,
  getSocialSettings,
  listPeople,
  listRecommendationsFor,
  listSharesByOwner,
  listSharesForRecipient,
  markRecommendationsRead,
  removeShare,
  setShareListening,
  sharePlaylist,
  syncShare,
} from "../services/socialService.js";
import { db } from "../config/db-sqlite.js";

// The Social page: playlists shared with you, albums and songs people point
// each other at, and what everyone has been playing. Open to every signed-in
// person, not just admins.

const router = express.Router();
router.use(requireAuth);

const fail = (res, error, fallback) =>
  res.status(error?.status || 500).json({ error: error?.message || fallback });

const me = (req) => req.user.username;

router.get("/overview", noCache, (req, res) => {
  try {
    const username = me(req);
    res.json({
      me: username,
      people: listPeople({ exclude: username }),
      settings: getSocialSettings(username),
      shares: { received: listSharesForRecipient(username), sent: listSharesByOwner(username) },
      recommendations: listRecommendationsFor(username),
    });
  } catch (error) {
    fail(res, error, "Could not load the social page");
  }
});

// Slower than the rest: it asks Navidrome for each person's listening.
router.get("/highlights", noCache, async (req, res) => {
  try {
    res.json(await getListeningHighlights({}));
  } catch (error) {
    fail(res, error, "Could not read what people have been playing");
  }
});

router.post("/playlists/:id/share", async (req, res) => {
  try {
    res.json(await sharePlaylist({
      owner: me(req),
      playlistId: req.params.id,
      recipients: Array.isArray(req.body?.recipients) ? req.body.recipients : [],
    }));
  } catch (error) {
    fail(res, error, "Could not share the playlist");
  }
});

router.post("/shares/:id/sync", async (req, res) => {
  const share = db.prepare("SELECT * FROM playlist_shares WHERE id = ?").get(Number(req.params.id));
  if (!share) return res.status(404).json({ error: "No such share" });
  if (share.owner !== me(req) && share.recipient !== me(req)) {
    return res.status(403).json({ error: "That share is not yours" });
  }
  try {
    return res.json(await syncShare(share));
  } catch (error) {
    return fail(res, error, "Could not refresh the shared playlist");
  }
});

router.delete("/shares/:id", async (req, res) => {
  try {
    res.json(await removeShare({
      id: req.params.id,
      requester: me(req),
      deleteCopy: req.query.deleteCopy === "1",
    }));
  } catch (error) {
    fail(res, error, "Could not stop sharing");
  }
});

router.post("/recommendations", (req, res) => {
  try {
    res.json(createRecommendation({
      sender: me(req),
      kind: req.body?.kind,
      targetId: req.body?.targetId,
      note: req.body?.note,
      recipients: Array.isArray(req.body?.recipients) ? req.body.recipients : [],
    }));
  } catch (error) {
    fail(res, error, "Could not send the recommendation");
  }
});

router.post("/recommendations/read", (req, res) => {
  res.json({ marked: markRecommendationsRead(me(req)) });
});

router.post("/recommendations/:id/dismiss", (req, res) => {
  try {
    res.json(dismissRecommendation({ id: req.params.id, requester: me(req) }));
  } catch (error) {
    fail(res, error, "Could not hide the recommendation");
  }
});

router.put("/settings", (req, res) => {
  res.json(setShareListening(me(req), req.body?.shareListening !== false));
});

export default router;
