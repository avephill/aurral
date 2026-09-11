import { db } from "../config/db-sqlite.js";

/**
 * Navidrome's song id for one file, remembered per Navidrome library.
 *
 * Both systems index the same files, but Navidrome gives every library its own
 * copy of a file its own id, and those ids are the only handle its API takes.
 * Working them out costs a path query, sometimes a title search, so the answer
 * is kept here: after the first resolution a lookup is a single indexed read,
 * and a song id coming back from Navidrome (a star, a playlist entry) can be
 * turned into a file without asking Navidrome anything.
 *
 * Ids survive a restart but not a file being removed and re-added on the
 * Navidrome side, so callers that get a "not found" back should forget the id
 * and resolve it again.
 */

const CHUNK = 400;

const upsertStmt = db.prepare(`
  INSERT INTO navidrome_song_ids (media_path, library_id, song_id, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (media_path, library_id) DO UPDATE SET
    song_id = excluded.song_id,
    updated_at = excluded.updated_at
`);

const deleteBySongIdStmt = db.prepare("DELETE FROM navidrome_song_ids WHERE song_id = ?");
const deleteByPathStmt = db.prepare("DELETE FROM navidrome_song_ids WHERE media_path = ?");

const clean = (value) => String(value ?? "").trim();
const libraryKey = (value) => {
  // A copy whose library Navidrome did not name still deserves a row; -1 keeps
  // it from colliding with a real library id, and never reads back as 0.
  if (value === null || value === undefined || value === "") return -1;
  const id = Number(value);
  return Number.isFinite(id) ? id : -1;
};

/** Remember one id. `libraryId` may be null when Navidrome did not say. */
export function rememberNavidromeSongId({ mediaPath, libraryId = null, songId } = {}) {
  const path = clean(mediaPath);
  const id = clean(songId);
  if (!path || !id) return false;
  upsertStmt.run(path, libraryKey(libraryId), id, Date.now());
  return true;
}

/** Remember several at once. Entries are the same shape as above. */
export function rememberNavidromeSongIds(entries = []) {
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      path: clean(entry?.mediaPath),
      libraryId: libraryKey(entry?.libraryId),
      songId: clean(entry?.songId),
    }))
    .filter((entry) => entry.path && entry.songId);
  if (!rows.length) return 0;
  const now = Date.now();
  const write = db.transaction(() => {
    for (const row of rows) upsertStmt.run(row.path, row.libraryId, row.songId, now);
  });
  write();
  return rows.length;
}

/**
 * The known id for one file in one library, or in any library when
 * `libraryId` is left out. Returns `{ songId, libraryId }` or null.
 */
export function getNavidromeSongId(mediaPath, { libraryId = null } = {}) {
  const path = clean(mediaPath);
  if (!path) return null;
  const row = libraryId === null || libraryId === undefined
    ? db.prepare(
      "SELECT song_id AS songId, library_id AS libraryId FROM navidrome_song_ids WHERE media_path = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(path)
    : db.prepare(
      "SELECT song_id AS songId, library_id AS libraryId FROM navidrome_song_ids WHERE media_path = ? AND library_id = ?",
    ).get(path, libraryKey(libraryId));
  return row ? { songId: row.songId, libraryId: row.libraryId < 0 ? null : row.libraryId } : null;
}

/** Every known copy of one file, as `{ songId, libraryId }`. */
export function getNavidromeSongCopies(mediaPath) {
  const path = clean(mediaPath);
  if (!path) return [];
  return db.prepare(
    "SELECT song_id AS songId, library_id AS libraryId FROM navidrome_song_ids WHERE media_path = ? ORDER BY library_id",
  ).all(path).map((row) => ({ songId: row.songId, libraryId: row.libraryId < 0 ? null : row.libraryId }));
}

/**
 * File paths for Navidrome song ids, as a Map keyed by song id. The reverse
 * direction: a star or a playlist entry named by id becomes a file.
 */
export function getMediaPathsForNavidromeSongIds(songIds = []) {
  const ids = [...new Set((Array.isArray(songIds) ? songIds : []).map(clean).filter(Boolean))];
  const found = new Map();
  for (let index = 0; index < ids.length; index += CHUNK) {
    const chunk = ids.slice(index, index + CHUNK);
    const rows = db.prepare(
      `SELECT song_id AS songId, media_path AS mediaPath
       FROM navidrome_song_ids
       WHERE song_id IN (${chunk.map(() => "?").join(",")})`,
    ).all(...chunk);
    for (const row of rows) if (!found.has(row.songId)) found.set(row.songId, row.mediaPath);
  }
  return found;
}

/** Drop an id Navidrome no longer recognises. */
export function forgetNavidromeSongId(songId) {
  const id = clean(songId);
  if (!id) return false;
  return deleteBySongIdStmt.run(id).changes > 0;
}

/** Drop everything known about one file. */
export function forgetNavidromeSongIdsForPath(mediaPath) {
  const path = clean(mediaPath);
  if (!path) return false;
  return deleteByPathStmt.run(path).changes > 0;
}

/** Used by tests and by a settings change that repoints Navidrome. */
export function clearNavidromeSongIds() {
  db.prepare("DELETE FROM navidrome_song_ids").run();
}

export function countNavidromeSongIds() {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM navidrome_song_ids").get()?.count || 0);
}
