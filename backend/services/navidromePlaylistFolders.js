import { db } from "../config/db-sqlite.js";

/**
 * Folders for Navidrome playlists, the way iTunes had them.
 *
 * Navidrome holds a playlist as a name and a list of songs; it has no folder,
 * and no field to keep one in. So the tree lives here, as one row per playlist
 * per person: a path like "Rock/Best of", or nothing for a playlist that sits
 * at the top.
 *
 * The cost of that is worth saying out loud: a folder exists in Aurral and
 * nowhere else. Every Navidrome client still shows one flat list. The gain is
 * that nothing about the playlists themselves is changed to carry it, so a
 * folder can be renamed or thrown away without touching a single playlist.
 */

const MAX_DEPTH = 5;
const MAX_SEGMENT = 60;

const upsertStmt = db.prepare(`
  INSERT INTO navidrome_playlist_folders (user_id, playlist_id, folder, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (user_id, playlist_id) DO UPDATE SET
    folder = excluded.folder,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare(
  "DELETE FROM navidrome_playlist_folders WHERE user_id = ? AND playlist_id = ?",
);
const listStmt = db.prepare(
  "SELECT playlist_id AS playlistId, folder FROM navidrome_playlist_folders WHERE user_id = ?",
);

export class PlaylistFolderError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlaylistFolderError";
    this.status = 400;
  }
}

/**
 * A folder path as it will be stored: trimmed segments, no empties, no
 * separators inside a name. Returns "" for the top level.
 */
export function normalizeFolder(value) {
  const segments = String(value ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) return "";
  if (segments.length > MAX_DEPTH) {
    throw new PlaylistFolderError(`Folders can be ${MAX_DEPTH} deep at most`);
  }
  for (const segment of segments) {
    if (segment.length > MAX_SEGMENT) {
      throw new PlaylistFolderError(`Folder names can be ${MAX_SEGMENT} characters at most`);
    }
  }
  return segments.join("/");
}

/** Where each of this person's playlists is filed, as a Map of id to folder. */
export function getPlaylistFolders(userId) {
  const rows = Number(userId) ? listStmt.all(Number(userId)) : [];
  return new Map(rows.map((row) => [String(row.playlistId), row.folder]));
}

/** Every folder this person has, including the ones only implied by a child. */
export function listFolders(userId) {
  const folders = new Set();
  for (const folder of getPlaylistFolders(userId).values()) {
    const segments = folder.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      folders.add(segments.slice(0, depth).join("/"));
    }
  }
  return [...folders].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** File one playlist. An empty folder puts it back at the top level. */
export function setPlaylistFolder(userId, playlistId, folder) {
  const id = String(playlistId ?? "").trim();
  if (!Number(userId) || !id) return "";
  const normalized = normalizeFolder(folder);
  if (!normalized) {
    deleteStmt.run(Number(userId), id);
    return "";
  }
  upsertStmt.run(Number(userId), id, normalized, Date.now());
  return normalized;
}

/**
 * Rename a folder, and with it everything filed underneath. Renaming "Rock"
 * to "Guitar" moves "Rock/Live" to "Guitar/Live" as well.
 */
export function renameFolder(userId, from, to) {
  const source = normalizeFolder(from);
  const target = normalizeFolder(to);
  if (!source) throw new PlaylistFolderError("Which folder should be renamed?");
  if (!target) throw new PlaylistFolderError("A folder needs a name");
  if (target === source) return 0;
  if (`${target}/`.startsWith(`${source}/`)) {
    throw new PlaylistFolderError("A folder cannot be moved inside itself");
  }

  let moved = 0;
  const rewrite = db.transaction(() => {
    for (const [playlistId, folder] of getPlaylistFolders(userId)) {
      if (folder !== source && !folder.startsWith(`${source}/`)) continue;
      const rest = folder.slice(source.length);
      upsertStmt.run(Number(userId), playlistId, normalizeFolder(`${target}${rest}`), Date.now());
      moved += 1;
    }
  });
  rewrite();
  return moved;
}

/**
 * Throw a folder away. The playlists in it are not touched: they move to the
 * folder above, or to the top level.
 */
export function removeFolder(userId, folder) {
  const source = normalizeFolder(folder);
  if (!source) throw new PlaylistFolderError("Which folder should go?");
  const parent = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";

  let moved = 0;
  const rewrite = db.transaction(() => {
    for (const [playlistId, current] of getPlaylistFolders(userId)) {
      if (current !== source && !current.startsWith(`${source}/`)) continue;
      const rest = current.slice(source.length).replace(/^\//, "");
      const next = [parent, rest].filter(Boolean).join("/");
      if (next) upsertStmt.run(Number(userId), playlistId, next, Date.now());
      else deleteStmt.run(Number(userId), playlistId);
      moved += 1;
    }
  });
  rewrite();
  return moved;
}

/** Forget a playlist that no longer exists. */
export function forgetPlaylistFolder(userId, playlistId) {
  const id = String(playlistId ?? "").trim();
  if (!Number(userId) || !id) return false;
  return deleteStmt.run(Number(userId), id).changes > 0;
}

/**
 * Drop rows for playlists Navidrome no longer has, so a folder tree does not
 * fill up with playlists deleted from a phone.
 */
export function pruneMissingPlaylists(userId, playlistIds = []) {
  const alive = new Set((Array.isArray(playlistIds) ? playlistIds : []).map((id) => String(id)));
  let removed = 0;
  const prune = db.transaction(() => {
    for (const playlistId of getPlaylistFolders(userId).keys()) {
      if (alive.has(playlistId)) continue;
      deleteStmt.run(Number(userId), playlistId);
      removed += 1;
    }
  });
  prune();
  return removed;
}
