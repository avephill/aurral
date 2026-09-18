import express from "express";
import { noCache } from "../middleware/cache.js";
import { requireAuth } from "../middleware/requirePermission.js";
import { db } from "../config/db-sqlite.js";
import {
  getAlbumTags,
  getTrackTagDetail,
  listTags,
  renameTag,
  setAlbumTags,
  setTrackTags,
  tagTracks,
  tracksWithTag,
} from "../services/trackTagService.js";

// Tagging songs, which used to be something only iTunes could do here: the
// imported comments are read-only history, and these sit over them.

const router = express.Router();
router.use(requireAuth);

const me = (req) => req.user.username;

const fail = (res, error, fallback) =>
  res.status(error?.status || 500).json({ error: error?.message || fallback });

router.get("/", noCache, (req, res) => {
  try {
    res.json({ tags: listTags({ owner: me(req) }) });
  } catch (error) {
    fail(res, error, "Could not read your tags");
  }
});

router.get("/tracks", noCache, (req, res) => {
  try {
    const ids = tracksWithTag({ owner: me(req), tag: req.query.tag });
    if (!ids.length) return res.json({ tag: req.query.tag, tracks: [] });
    const rows = db.prepare(`
      SELECT track.id, track.title, track.artist_name AS artistName, album.title AS album
      FROM library_tracks AS track
      LEFT JOIN library_album_tracks AS link ON link.track_id = track.id
      LEFT JOIN library_albums AS album ON album.id = link.album_id
      WHERE track.id IN (${ids.map(() => "?").join(",")})
      GROUP BY track.id
      ORDER BY track.artist_name COLLATE NOCASE, track.title COLLATE NOCASE
    `).all(...ids);
    return res.json({ tag: req.query.tag, tracks: rows });
  } catch (error) {
    return fail(res, error, "Could not read what carries that tag");
  }
});

router.get("/track/:trackId", noCache, (req, res) => {
  try {
    res.json(getTrackTagDetail({ owner: me(req), trackId: req.params.trackId }));
  } catch (error) {
    fail(res, error, "Could not read that song's tags");
  }
});

router.get("/album/:albumId", noCache, (req, res) => {
  try {
    res.json({
      albumId: Number(req.params.albumId),
      tags: getAlbumTags({ owner: me(req), albumId: req.params.albumId }),
    });
  } catch (error) {
    fail(res, error, "Could not read that record's tags");
  }
});

router.put("/album/:albumId", (req, res) => {
  try {
    res.json(setAlbumTags({ owner: me(req), albumId: req.params.albumId, tags: req.body?.tags }));
  } catch (error) {
    fail(res, error, "Could not save those tags");
  }
});

router.put("/track/:trackId", (req, res) => {
  try {
    res.json(setTrackTags({ owner: me(req), trackId: req.params.trackId, tags: req.body?.tags }));
  } catch (error) {
    fail(res, error, "Could not save those tags");
  }
});

router.post("/apply", (req, res) => {
  try {
    res.json(tagTracks({
      owner: me(req),
      trackIds: Array.isArray(req.body?.trackIds) ? req.body.trackIds : [],
      tag: req.body?.tag,
      remove: req.body?.remove === true,
    }));
  } catch (error) {
    fail(res, error, "Could not put that tag on them");
  }
});

router.post("/rename", (req, res) => {
  try {
    res.json(renameTag({ owner: me(req), from: req.body?.from, to: req.body?.to }));
  } catch (error) {
    fail(res, error, "Could not rename that tag");
  }
});

export default router;
