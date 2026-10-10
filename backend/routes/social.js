import express from "express";
import { noCache } from "../middleware/cache.js";
import { requireAuth } from "../middleware/requirePermission.js";
import {
  acceptShare,
  createRecommendation,
  dismissRecommendation,
  getListeningHighlights,
  getSocialSettings,
  listPeople,
  listRecommendationsFor,
  listSharesByOwner,
  listSharesForRecipient,
  markRecommendationsRead,
  previewShare,
  removeShare,
  setShareListening,
  sharePlaylist,
  syncShare,
  withdrawRecommendation,
} from "../services/socialService.js";
import {
  addCollabAlbums,
  addCollabMember,
  createCollabPlaylist,
  deleteCollabPlaylist,
  listCollabPlaylistsFor,
  previewCollabAlbums,
  removeCollabMember,
  syncCollabPlaylist,
} from "../services/collabPlaylistService.js";
import {
  listPlaylist,
  listingsBy,
  listingsFor,
  previewListing,
  takeListing,
  unlistPlaylist,
} from "../services/congregationPlaylistService.js";
import { congregationsFor } from "../services/congregationService.js";
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
      listings: { visible: listingsFor(username), mine: listingsBy(username) },
      congregations: congregationsFor(username).map(({ id, name }) => ({ id, name })),
      recommendations: listRecommendationsFor(username),
      collabs: listCollabPlaylistsFor(username),
    });
  } catch (error) {
    fail(res, error, "Could not load the social page");
  }
});

// Slower than the rest: it asks Navidrome for each person's listening.
router.get("/highlights", noCache, async (req, res) => {
  try {
    res.json(await getListeningHighlights({ people: listPeople({ exclude: me(req) }) }));
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

// What adding a shared playlist would put into your library, asked before
// anything is added.
router.get("/shares/:id/preview", noCache, async (req, res) => {
  try {
    res.json(await previewShare({ id: req.params.id, requester: me(req) }));
  } catch (error) {
    fail(res, error, "Could not work out what that playlist needs");
  }
});

// Answers once the copy is written with what can be played now; the albums
// added for the rest arrive after Navidrome scans them, without holding this up.
router.post("/shares/:id/accept", async (req, res) => {
  try {
    const { ready: _ready, ...result } = await acceptShare({ id: req.params.id, requester: me(req) });
    res.json(result);
  } catch (error) {
    fail(res, error, "Could not add the playlist");
  }
});

// ---------------------------------------------------------------- shown to a congregation

router.post("/playlists/:id/list", async (req, res) => {
  try {
    res.json(await listPlaylist({
      owner: me(req),
      playlistId: req.params.id,
      congregationIds: Array.isArray(req.body?.congregationIds) ? req.body.congregationIds : [],
    }));
  } catch (error) {
    fail(res, error, "Could not show the playlist to your congregation");
  }
});

router.delete("/listings/:id", (req, res) => {
  try {
    res.json(unlistPlaylist({ id: req.params.id, requester: me(req) }));
  } catch (error) {
    fail(res, error, "Could not take the playlist off the list");
  }
});

router.get("/listings/:id/preview", noCache, async (req, res) => {
  try {
    res.json(await previewListing({ id: req.params.id, requester: me(req) }));
  } catch (error) {
    fail(res, error, "Could not work out what that playlist needs");
  }
});

router.post("/listings/:id/take", async (req, res) => {
  try {
    const { ready: _ready, ...result } = await takeListing({ id: req.params.id, requester: me(req) });
    res.json(result);
  } catch (error) {
    fail(res, error, "Could not add the playlist");
  }
});

router.post("/shares/:id/sync", async (req, res) => {
  const share = db.prepare("SELECT * FROM playlist_shares WHERE id = ?").get(Number(req.params.id));
  if (!share) return res.status(404).json({ error: "No such share" });
  if (share.owner !== me(req) && share.recipient !== me(req)) {
    return res.status(403).json({ error: "That share is not yours" });
  }
  try {
    const result = await syncShare(share);
    // The sharer learns nothing from the answer about what the other person
    // did with it - added, turned down, or thrown away.
    return res.json(share.recipient === me(req) ? result : { sent: true });
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

// ---------------------------------------------------------------- together

router.post("/collabs", async (req, res) => {
  try {
    res.json(await createCollabPlaylist({
      owner: me(req),
      name: req.body?.name,
      members: Array.isArray(req.body?.members) ? req.body.members : [],
      fromPlaylistId: req.body?.fromPlaylistId || "",
    }));
  } catch (error) {
    fail(res, error, "Could not start that playlist");
  }
});

router.post("/collabs/:id/sync", async (req, res) => {
  try {
    res.json(await syncCollabPlaylist(req.params.id));
  } catch (error) {
    fail(res, error, "Could not bring that playlist up to date");
  }
});

router.get("/collabs/:id/albums", noCache, async (req, res) => {
  try {
    res.json(await previewCollabAlbums({ id: req.params.id, requester: me(req) }));
  } catch (error) {
    fail(res, error, "Could not work out what that playlist needs");
  }
});

router.post("/collabs/:id/albums", async (req, res) => {
  try {
    const { ready: _ready, ...result } = await addCollabAlbums({ id: req.params.id, requester: me(req) });
    res.json(result);
  } catch (error) {
    fail(res, error, "Could not add those albums");
  }
});

router.post("/collabs/:id/members", async (req, res) => {
  try {
    res.json(await addCollabMember({
      id: req.params.id,
      requester: me(req),
      username: req.body?.username,
    }));
  } catch (error) {
    fail(res, error, "Could not add them");
  }
});

router.delete("/collabs/:id/members/:username", (req, res) => {
  try {
    res.json(removeCollabMember({
      id: req.params.id,
      requester: me(req),
      username: req.params.username,
    }));
  } catch (error) {
    fail(res, error, "Could not remove them");
  }
});

router.delete("/collabs/:id", (req, res) => {
  try {
    res.json(deleteCollabPlaylist({ id: req.params.id, requester: me(req) }));
  } catch (error) {
    fail(res, error, "Could not end that playlist");
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

router.delete("/recommendations/:id", (req, res) => {
  try {
    res.json(withdrawRecommendation({ id: req.params.id, requester: me(req) }));
  } catch (error) {
    fail(res, error, "Could not take that back");
  }
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
