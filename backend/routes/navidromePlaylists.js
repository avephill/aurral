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
  getPersonalLibraryIdForUser,
  mapNavidromeEntriesToTracks,
  resolveNavidromeSongIds,
} from "../services/navidromeTrackResolver.js";
import { publicLibraryJsonReplacer } from "./library/handlers/canonical.js";
import {
  PlaylistFolderError,
  forgetPlaylistFolder,
  getPlaylistFolders,
  listFolders,
  pruneMissingPlaylists,
  removeFolder,
  renameFolder,
  setPlaylistFolder,
} from "../services/navidromePlaylistFolders.js";
import {
  SmartPlaylistRuleError,
  describeSmartPlaylistFields,
  fromNavidromeRules,
  isSmartPlaylistRecord,
  toNavidromeRules,
} from "../services/navidromeSmartPlaylists.js";

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

/**
 * Reordering is the one edit Subsonic cannot express, so it goes through the
 * admin connection. That connection can edit anybody's playlist, so ownership
 * is checked here rather than being left to Navidrome.
 */
async function adminClientForOwnedPlaylist(req, res, playlistId) {
  const admin = getAdminNavidromeClient();
  if (!admin?.isConfigured?.()) {
    res.status(503).json({
      error: "Navidrome admin connection not configured",
      message: "Reordering needs the Navidrome connection in Settings.",
    });
    return null;
  }
  let record = null;
  try {
    record = await admin.getPlaylistRecord(playlistId);
  } catch (error) {
    if (Number(error?.response?.status) === 404) {
      res.status(404).json({ error: "Playlist not found" });
      return null;
    }
    throw error;
  }
  const owner = String(record?.ownerName || "");
  if (owner.toLowerCase() !== String(req.user?.username || "").toLowerCase()) {
    res.status(403).json({ error: "This playlist belongs to someone else" });
    return null;
  }
  return admin;
}

function toPlaylistSummary(playlist, username, record = null, folder = "") {
  const owner = String(playlist?.owner || record?.ownerName || "");
  const smart = isSmartPlaylistRecord(record);
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
    folder,
    smart,
    // Null when the rules use something this editor cannot show; the playlist
    // still works, it just cannot be opened in the rule editor.
    rules: smart ? fromNavidromeRules(record.rules) : null,
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

// Subsonic says nothing about smart rules, so the records come from the
// admin connection in one call and are matched up by id. Without that
// connection the page still works, just without the smart badge.
async function playlistRecordsById() {
  const admin = getAdminNavidromeClient();
  if (!admin?.isConfigured?.()) return new Map();
  try {
    const records = await admin.getPlaylistRecords();
    return new Map(records.map((record) => [String(record.id), record]));
  } catch {
    return new Map();
  }
}

router.get("/", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  try {
    const [playlists, records] = await Promise.all([
      client.getSubsonicPlaylists(),
      playlistRecordsById(),
    ]);
    // A playlist deleted from a phone should not leave a row behind in the
    // folder tree, so the list is the moment to tidy up.
    pruneMissingPlaylists(req.user.id, playlists.map((playlist) => playlist.id));
    const folders = getPlaylistFolders(req.user.id);
    const summaries = playlists
      .map((playlist) => toPlaylistSummary(
        playlist,
        client.user,
        records.get(String(playlist.id)),
        folders.get(String(playlist.id)) || "",
      ))
      .sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return res.json({ username: client.user, playlists: summaries, folders: listFolders(req.user.id) });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not load playlists from Navidrome");
  }
});

// Folders. Navidrome has none, so these read and write Aurral's own tree and
// never touch a playlist.
router.get("/folders", noCache, (req, res) => {
  if (!isNavidromePlaylistsEnabled()) {
    return res.status(404).json({ error: "Navidrome playlists are not enabled" });
  }
  return res.json({ folders: listFolders(req.user.id) });
});

router.post("/folders/rename", noCache, (req, res) => {
  if (!isNavidromePlaylistsEnabled()) {
    return res.status(404).json({ error: "Navidrome playlists are not enabled" });
  }
  try {
    const moved = renameFolder(req.user.id, req.body?.from, req.body?.to);
    return res.json({ moved, folders: listFolders(req.user.id) });
  } catch (error) {
    if (error instanceof PlaylistFolderError) return res.status(400).json({ error: error.message });
    throw error;
  }
});

router.post("/folders/remove", noCache, (req, res) => {
  if (!isNavidromePlaylistsEnabled()) {
    return res.status(404).json({ error: "Navidrome playlists are not enabled" });
  }
  try {
    // The playlists inside are kept; they move up one level.
    const moved = removeFolder(req.user.id, req.body?.folder);
    return res.json({ moved, folders: listFolders(req.user.id) });
  } catch (error) {
    if (error instanceof PlaylistFolderError) return res.status(400).json({ error: error.message });
    throw error;
  }
});

router.put("/:id/folder", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  try {
    // Only a playlist this person can see may be filed by them.
    const playlist = await client.getSubsonicPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    const folder = setPlaylistFolder(req.user.id, req.params.id, req.body?.folder);
    return res.json({ folder, folders: listFolders(req.user.id) });
  } catch (error) {
    if (error instanceof PlaylistFolderError) return res.status(400).json({ error: error.message });
    if (Number(error?.code) === 70) return res.status(404).json({ error: "Playlist not found" });
    return sendNavidromeError(res, error, "Could not move the playlist");
  }
});

/**
 * A copy of a playlist. A smart one copies its rules, so the copy goes on
 * updating itself; an ordinary one copies the songs it holds now.
 */
router.post("/:id/duplicate", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  try {
    const source = await client.getSubsonicPlaylist(req.params.id);
    if (!source) return res.status(404).json({ error: "Playlist not found" });
    const name = String(req.body?.name || "").trim() || `${source.name || "Playlist"} copy`;

    const records = await playlistRecordsById();
    const record = records.get(String(req.params.id));
    const smart = isSmartPlaylistRecord(record);

    const songIds = smart ? [] : (source.entry || []).map((entry) => String(entry.id)).filter(Boolean);
    const created = await client.createPlaylist(name, songIds.slice(0, 500));
    if (!created?.id) throw new Error("Navidrome did not return a playlist id");
    for (let index = 500; index < songIds.length; index += 500) {
      await client.appendPlaylistSongs(created.id, songIds.slice(index, index + 500));
    }

    if (smart) {
      const admin = getAdminNavidromeClient();
      if (admin?.isConfigured?.()) await admin.setPlaylistRules(created.id, { name, rules: record.rules });
    }
    // A copy belongs in the same folder as the original.
    const folder = getPlaylistFolders(req.user.id).get(String(req.params.id)) || "";
    if (folder) setPlaylistFolder(req.user.id, created.id, folder);

    const playlist = await client.getSubsonicPlaylist(created.id);
    return res.status(201).json({
      playlist: playlist
        ? toPlaylistSummary(playlist, client.user, smart ? record : null, folder)
        : null,
      copied: smart ? "rules" : songIds.length,
    });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not duplicate the playlist");
  }
});

// What the rule editor may offer. Kept on the server so the editor cannot
// invent a field Navidrome would answer with an empty playlist.
router.get("/rule-fields", noCache, (req, res) => {
  if (!isNavidromePlaylistsEnabled()) {
    return res.status(404).json({ error: "Navidrome playlists are not enabled" });
  }
  return res.json(describeSmartPlaylistFields());
});

router.get("/:id", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  try {
    // Reading a smart playlist is what makes Navidrome evaluate its rules, so
    // this read comes first and the record after it.
    const playlist = await client.getSubsonicPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    const records = await playlistRecordsById();
    const tracks = await mapNavidromeEntriesToTracks(playlist.entry, { playlistId: req.params.id });
    return sendJson(res, 200, {
      ...toPlaylistSummary(
        playlist,
        client.user,
        records.get(String(req.params.id)),
        getPlaylistFolders(req.user.id).get(String(req.params.id)) || "",
      ),
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
    const preferLibraryId = await getPersonalLibraryIdForUser(req.user.username);
    const { resolved, unresolved } = await resolveNavidromeSongIds(normalizeTrackPayloads(req.body), { preferLibraryId });
    const created = await client.createPlaylist(name, resolved.map((entry) => entry.songId));
    const playlist = created?.id ? await client.getSubsonicPlaylist(created.id) : created;
    return res.status(201).json({
      playlist: playlist ? toPlaylistSummary(playlist, client.user) : null,
      added: resolved.length,
      sharedCopies: resolved.filter((entry) => entry.outsidePreferredLibrary).length,
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
    const preferLibraryId = await getPersonalLibraryIdForUser(req.user.username);
    const { resolved, unresolved } = await resolveNavidromeSongIds(payloads, { preferLibraryId });
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
      sharedCopies: resolved.filter((entry) => entry.outsidePreferredLibrary).length,
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

/**
 * A smart playlist is made in two steps: the person creates an ordinary
 * playlist through their own connection, so it belongs to them, and the rules
 * are attached through the admin one, which is the only connection that can
 * write them. Navidrome fills it in when it is next read.
 */
router.post("/smart", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Playlist name is required" });
  const admin = getAdminNavidromeClient();
  if (!admin?.isConfigured?.()) {
    return res.status(503).json({
      error: "Navidrome admin connection not configured",
      message: "Smart playlists need the Navidrome connection in Settings.",
    });
  }
  let rules;
  try {
    rules = toNavidromeRules(req.body?.rules);
  } catch (error) {
    if (error instanceof SmartPlaylistRuleError) return res.status(400).json({ error: error.message });
    throw error;
  }
  let created = null;
  try {
    created = await client.createPlaylist(name, []);
    await admin.setPlaylistRules(created.id, { name, rules });
    const playlist = await client.getSubsonicPlaylist(created.id);
    const record = await admin.getPlaylistRecord(created.id);
    return res.status(201).json({ playlist: toPlaylistSummary(playlist, client.user, record) });
  } catch (error) {
    // A playlist with no rules on it is a confusing leftover, so it goes.
    if (created?.id) await client.deletePlaylist(created.id).catch(() => {});
    return sendNavidromeError(res, error, "Could not create the smart playlist in Navidrome");
  }
});

// Changing the rules of an existing smart playlist, or turning an ordinary
// one into a smart one.
router.put("/:id/rules", noCache, async (req, res) => {
  if (!isNavidromePlaylistsEnabled()) {
    return res.status(404).json({ error: "Navidrome playlists are not enabled" });
  }
  let rules;
  try {
    rules = toNavidromeRules(req.body?.rules);
  } catch (error) {
    if (error instanceof SmartPlaylistRuleError) return res.status(400).json({ error: error.message });
    throw error;
  }
  try {
    const admin = await adminClientForOwnedPlaylist(req, res, req.params.id);
    if (!admin) return undefined;
    const record = await admin.getPlaylistRecord(req.params.id);
    await admin.setPlaylistRules(req.params.id, { name: record?.name, rules });
    const client = userClient(req, res);
    if (!client) return undefined;
    const playlist = await client.getSubsonicPlaylist(req.params.id);
    const updated = await admin.getPlaylistRecord(req.params.id);
    return res.json({ playlist: toPlaylistSummary(playlist, client.user, updated) });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not save the rules in Navidrome");
  }
});

// Dropping the rules leaves the songs it last held, as an ordinary playlist.
router.delete("/:id/rules", noCache, async (req, res) => {
  if (!isNavidromePlaylistsEnabled()) {
    return res.status(404).json({ error: "Navidrome playlists are not enabled" });
  }
  try {
    const admin = await adminClientForOwnedPlaylist(req, res, req.params.id);
    if (!admin) return undefined;
    const record = await admin.getPlaylistRecord(req.params.id);
    await admin.setPlaylistRules(req.params.id, { name: record?.name, rules: null });
    return res.json({ smart: false });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not remove the rules in Navidrome");
  }
});

// Removing several at once. Subsonic takes every position in one call and
// applies them against the list as it was, so the positions do not shift
// under each other.
router.post("/:id/entries/remove", noCache, async (req, res) => {
  const client = userClient(req, res);
  if (!client) return undefined;
  const entries = (Array.isArray(req.body?.entries) ? req.body.entries : [])
    .map((entry) => ({
      index: Number(entry?.index),
      songId: String(entry?.songId || "").trim(),
    }))
    .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0);
  if (!entries.length) return res.status(400).json({ error: "entries are required" });
  if (entries.length > MAX_TRACKS_PER_REQUEST) {
    return res.status(400).json({ error: `At most ${MAX_TRACKS_PER_REQUEST} entries at a time` });
  }
  try {
    const playlist = await client.getSubsonicPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    for (const entry of entries) {
      const found = playlist.entry[entry.index];
      if (!found) return res.status(404).json({ error: "Entry not found" });
      if (entry.songId && String(found.id) !== entry.songId) {
        return res.status(409).json({
          error: "Playlist changed",
          message: "This playlist was edited elsewhere. Reload it and try again.",
        });
      }
    }
    const removed = await client.removePlaylistEntries(
      req.params.id,
      entries.map((entry) => entry.index),
    );
    return res.json({ removed });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not remove from the playlist in Navidrome");
  }
});

// Moving an entry. The caller says where it is now, where it should go, and
// which song it saw there, so a playlist edited elsewhere is left alone.
router.put("/:id/entries/:index/position", noCache, async (req, res) => {
  if (!isNavidromePlaylistsEnabled()) {
    return res.status(404).json({ error: "Navidrome playlists are not enabled" });
  }
  const fromIndex = Number(req.params.index);
  const toIndex = Number(req.body?.toIndex);
  if (!Number.isInteger(fromIndex) || fromIndex < 0) return res.status(400).json({ error: "Invalid entry index" });
  if (!Number.isInteger(toIndex) || toIndex < 0) return res.status(400).json({ error: "toIndex is required" });
  const expectedSongId = String(req.body?.songId || "").trim();
  try {
    const admin = await adminClientForOwnedPlaylist(req, res, req.params.id);
    if (!admin) return undefined;
    const rows = await admin.getPlaylistTracks(req.params.id);
    if (fromIndex >= rows.length || toIndex >= rows.length) {
      return res.status(400).json({ error: "Position is outside the playlist" });
    }
    if (fromIndex === toIndex) return res.json({ moved: false });
    const row = rows[fromIndex];
    const songId = String(row?.mediaFileId ?? row?.mediaFile?.id ?? "");
    if (expectedSongId && songId !== expectedSongId) {
      return res.status(409).json({
        error: "Playlist changed",
        message: "This playlist was edited elsewhere. Reload it and try again.",
      });
    }
    await admin.movePlaylistTrack(req.params.id, row.id, toIndex);
    return res.json({ moved: true, fromIndex, toIndex });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not reorder the playlist in Navidrome");
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
    forgetPlaylistFolder(req.user.id, req.params.id);
    return res.json({ deleted: true });
  } catch (error) {
    return sendNavidromeError(res, error, "Could not delete the playlist in Navidrome");
  }
});

export default router;
