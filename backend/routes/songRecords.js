import express from "express";
import { gunzipSync } from "node:zlib";
import { noCache } from "../middleware/cache.js";
import { requireAdmin, requireAuth } from "../middleware/requirePermission.js";
import {
  decideSongLink,
  dismissSongRecords,
  getMissingSongsReport,
  getSongLinkReview,
  importSongRecordBundle,
  listSongRecordOwners,
  relinkSongRecords,
} from "../services/songRecordService.js";
import {
  getTagPlaylistReport,
  setTagPlaylistEnabled,
  undoTagPlaylist,
} from "../services/tagPlaylistService.js";

// Admin tools for people's old music libraries: importing one, hunting down
// the songs that are not on the server, checking guessed links, and the smart
// playlists evaluated over the imported tags.

const router = express.Router();
router.use(requireAuth, requireAdmin);

const ownerOf = (req) => String(req.query.owner || req.body?.owner || "").trim();

const fail = (res, error, fallback) =>
  res.status(error?.status || 500).json({ error: error?.message || fallback });

router.get("/owners", noCache, (req, res) => {
  res.json({ owners: listSongRecordOwners() });
});

// The bundle is large, so it arrives as raw bytes (gzip or plain JSON) rather
// than through the app-wide JSON parser and its limit.
router.post(
  "/import",
  express.raw({ type: () => true, limit: process.env.SONG_RECORD_IMPORT_LIMIT || "64mb" }),
  (req, res) => {
    try {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
      let bundle;
      try {
        bundle = JSON.parse(text);
      } catch {
        return res.status(400).json({ error: "The file is not a readable bundle" });
      }
      res.json(importSongRecordBundle(bundle));
    } catch (error) {
      fail(res, error, "Import failed");
    }
  },
);

router.post("/relink", (req, res) => {
  try {
    res.json(relinkSongRecords({ owner: ownerOf(req) || null }));
  } catch (error) {
    fail(res, error, "Could not look for songs");
  }
});

router.get("/missing", noCache, (req, res) => {
  const owner = ownerOf(req);
  if (!owner) return res.status(400).json({ error: "owner is required" });
  res.json(getMissingSongsReport({ owner, includeDismissed: req.query.dismissed === "1" }));
});

router.get("/review", noCache, (req, res) => {
  const owner = ownerOf(req);
  if (!owner) return res.status(400).json({ error: "owner is required" });
  res.json(getSongLinkReview({ owner }));
});

router.post("/records/:id/link", (req, res) => {
  try {
    const changed = decideSongLink(req.params.id, String(req.body?.decision || ""));
    if (!changed) return res.status(404).json({ error: "No link for that song" });
    res.json({ ok: true });
  } catch (error) {
    fail(res, error, "Could not save");
  }
});

router.post("/records/dismiss", (req, res) => {
  const changed = dismissSongRecords(req.body?.ids, req.body?.dismissed !== false);
  res.json({ changed });
});

router.get("/tag-playlists", noCache, async (req, res) => {
  const owner = ownerOf(req);
  if (!owner) return res.status(400).json({ error: "owner is required" });
  try {
    res.json(await getTagPlaylistReport({ owner, fresh: req.query.fresh === "1" }));
  } catch (error) {
    fail(res, error, "Could not evaluate smart playlists");
  }
});

router.post("/tag-playlists/:id/enabled", async (req, res) => {
  try {
    const result = await setTagPlaylistEnabled(req.params.id, req.body?.enabled === true);
    if (result.status === "missing") return res.status(404).json({ error: "No such playlist" });
    res.json(result);
  } catch (error) {
    fail(res, error, "Could not change the playlist");
  }
});

router.post("/tag-playlists/:id/undo", async (req, res) => {
  try {
    const result = await undoTagPlaylist(req.params.id);
    if (result.status === "missing") return res.status(404).json({ error: "Nothing to undo" });
    res.json(result);
  } catch (error) {
    fail(res, error, "Could not undo");
  }
});

export default router;
