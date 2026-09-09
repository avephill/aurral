import express from "express";
import { requireAuth, requirePermission } from "../middleware/requirePermission.js";
import { noCache } from "../middleware/cache.js";
import {
  getNavidromeUserAuthMode,
  isNavidromePlaylistsEnabled,
} from "../config/featureFlags.js";
import { createNavidromeUserClient, isNavidromeAuthError } from "../services/navidromeUserClient.js";
import {
  getAdminNavidromeClient,
  mapNavidromeEntriesToTracks,
  resolveNavidromeSongIds,
} from "../services/navidromeTrackResolver.js";
import { publicLibraryJsonReplacer } from "./library/handlers/canonical.js";

/**
 * Hand-made playlists that live in Navidrome, read and edited as the
 * signed-in user. Nothing is stored in Aurral: a change here is visible in
 * every Navidrome client at once, and a change made in a Navidrome client is
 * visible here on the next load.
 */

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission("accessFlow"));

const MAX_TRACKS_PER_REQUEST = 200;

function sendJson(res, status, payload) {
  res.status(status).type("application/json").send(JSON.stringify(payload, publicLibraryJsonReplacer));
}

function userClient(req, res) {
  if (!isNavidromePlaylistsEnabled()) {
    res.status(404).json({ error: "Navidrome playlists are not enabled" });
    return null;
  }
  const client = createNavidromeUserClient(req.user);
  if (!client) {
    res.status(503).json({ error: "Navidrome not configured" });
    return null;
  }
  return client;
}

function toPlaylistSummary(playlist, username) {
  const owner = String(playlist?.owner || "");
  return {
    id: String(playlist.id),
    kind: "navidrome",
    name: playlist.name || "",
    comment: playlist.comment || "",
    trackCount: Number(playlist.songCount || 0),
    durationSeconds: Number(playlist.duration || 0),
    ownerUsername: owner || null,
    owned: owner.toLowerCase() === String(username || "").toLowerCase(),
    public: playlist.public === true,
    createdAt: playlist.created || null,
    changedAt: playlist.changed || null,
    // Consumers of Aurral's own playlists look for these; an empty set means
    // "unknown", never "already added".
    trackIdentities: [],
    trackEntries: [],
  };
}

function sendNavidromeError(res, error, fallback) {
  if (isNavidromeAuthError(error)) {
    return res.status(502).json({
      error: "Navidrome did not accept the user",
      message:
        "Navidrome rejected the trusted username header. Add Aurral's address to Navidrome's "
        + "external-auth trusted sources and make sure the header names match.",
      code: error.code ?? null,
    });
  }
  const status = Number(error?.response?.status) || 502;
  return res.status(status >= 400 && status < 600 ? status : 502).json({
    error: fallback,
    message: error?.message || fallback,
  });
}

function normalizeTrackPayloads(body) {
  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  return tracks
    .slice(0, MAX_TRACKS_PER_REQUEST)
    .map((track) => ({
      trackId: track?.trackId ?? track?.id ?? null,
      albumId: track?.albumId ?? null,
      trackName: String(track?.trackName || track?.title || "").trim(),
      artistName: String(track?.artistName || "").trim(),
      albumName: String(track?.albumName || "").trim(),
      trackMbid: String(track?.trackMbid || "").trim() || null,
    }))
    .filter((track) => track.trackId || track.trackName);
}

router.get("/status", noCache, async (req, res) => {
  const mode = getNavidromeUserAuthMode();
  if (!isNavidromePlaylistsEnabled()) {
    return res.json({ enabled: false, mode, connected: false, username: null });
  }
  const client = createNavidromeUserClient(req.user);
  if (!client) return res.json({ enabled: true, mode, connected: false, username: null, error: "Navidrome not configured" });
  try {
    await client.ping();
    return res.json({ enabled: true, mode, connected: true, username: client.user, adminConfigured: Boolean(getAdminNavidromeClient()) });
  } catch (error) {
    return res.json({
      enabled: true,
      mode,
      connected: false,
      username: client.user,
      error: isNavidromeAuthError(error)
        ? "Navidrome rejected the trusted username header"
        : error.message,
    });
  }
});

router.get("/", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  try {
    const playlists = await client.getSubsonicPlaylists();
    const summaries = playlists
      .map((playlist) => toPlaylistSummary(playlist, client.user))
      .sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return res.json({ username: client.user, playlists: summaries });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not load playlists from Navidrome");
  }
});

router.get("/:id", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  try {
    const playlist = await client.getSubsonicPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    const tracks = await mapNavidromeEntriesToTracks(playlist.entry, { playlistId: req.params.id });
    return sendJson(res, 200, {
      ...toPlaylistSummary(playlist, client.user),
      trackCount: tracks.length,
      tracks,
      unavailableCount: tracks.filter((track) => !track.available).length,
    });
  } catch (error) {
    if (Number(error?.code) === 70) return res.status(404).json({ error: "Playlist not found" });
    return sendNavidromeError(res, error, "Could not load the playlist from Navidrome");
  }
});

router.post("/", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Playlist name is required" });
  try {
    const { resolved, unresolved } = await resolveNavidromeSongIds(normalizeTrackPayloads(req.body));
    const created = await client.createPlaylist(name, resolved.map((entry) => entry.songId));
    const playlist = created?.id ? await client.getSubsonicPlaylist(created.id) : created;
    return res.status(201).json({
      playlist: playlist ? toPlaylistSummary(playlist, client.user) : null,
      added: resolved.length,
      unresolved: unresolved.map((track) => ({ trackName: track.trackName, artistName: track.artistName })),
    });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not create the playlist in Navidrome");
  }
});

router.post("/:id/tracks", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  const payloads = normalizeTrackPayloads(req.body);
  if (!payloads.length) return res.status(400).json({ error: "tracks are required" });
  try {
    const { resolved, unresolved } = await resolveNavidromeSongIds(payloads);
    if (!resolved.length) {
      return res.status(404).json({
        error: "Track not found in Navidrome",
        message: "Navidrome has not indexed this track, so it cannot go in a Navidrome playlist yet.",
        unresolved: unresolved.map((track) => ({ trackName: track.trackName, artistName: track.artistName })),
      });
    }
    await client.appendPlaylistSongs(req.params.id, resolved.map((entry) => entry.songId));
    const playlist = await client.getSubsonicPlaylist(req.params.id);
    return res.json({
      playlist: playlist ? toPlaylistSummary(playlist, client.user) : null,
      added: resolved.length,
      unresolved: unresolved.map((track) => ({ trackName: track.trackName, artistName: track.artistName })),
    });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not add to the playlist in Navidrome");
  }
});

// Subsonic removes by position. The caller sends the song id it saw at that
// position so a playlist edited elsewhere in the meantime is not damaged.
router.delete("/:id/entries/:index", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: "Invalid entry index" });
  const expectedSongId = String(req.query.songId || "").trim();
  try {
    const playlist = await client.getSubsonicPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    const entry = playlist.entry[index];
    if (!entry) return res.status(404).json({ error: "Entry not found" });
    if (expectedSongId && String(entry.id) !== expectedSongId) {
      return res.status(409).json({
        error: "Playlist changed",
        message: "This playlist was edited elsewhere. Reload it and try again.",
      });
    }
    await client.removePlaylistEntries(req.params.id, [index]);
    return res.json({ removed: 1 });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not remove from the playlist in Navidrome");
  }
});

router.patch("/:id", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Playlist name is required" });
  try {
    await client.renamePlaylist(req.params.id, name);
    const playlist = await client.getSubsonicPlaylist(req.params.id);
    return res.json({ playlist: playlist ? toPlaylistSummary(playlist, client.user) : null });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not rename the playlist in Navidrome");
  }
});

router.delete("/:id", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  try {
    await client.deletePlaylist(req.params.id);
    return res.json({ deleted: true });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not delete the playlist in Navidrome");
  }
});

export default router;
