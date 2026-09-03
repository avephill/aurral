// Precomputed rollups of the artist -> album -> track -> media join.
//
// Listing artists or newly available albums used to aggregate that join on
// every request: fully indexed, but still hundreds of milliseconds of real
// work on a large library, repeated for results that cannot change between
// scans. These tables move that work to indexing time, where it happens once.
//
// Anything that writes to library_artists / library_albums / library_tracks /
// library_media_files must rebuild these afterwards, which libraryIndexService
// does at the end of every scan.

import { db } from "../config/db-sqlite.js";
import { logger } from "./logger.js";

// Media rows carry the album they belong to, except for older rows that
// predate that column; those still count toward their track's album.
const ALBUM_MEDIA_JOIN = `(media.album_id = album_track.album_id OR media.album_id IS NULL)`;

const ARTIST_STATS_SQL = `
  INSERT INTO library_artist_stats (
    artist_id, album_count, track_count, size_on_disk, sources, available, updated_at
  )
  SELECT
    artist.id,
    COUNT(DISTINCT album.id),
    COUNT(DISTINCT album_track.track_id),
    COALESCE(SUM(CASE WHEN media.available = 1 THEN media.size ELSE 0 END), 0),
    GROUP_CONCAT(DISTINCT media.source),
    COALESCE(MAX(CASE WHEN media.available = 1 THEN 1 ELSE 0 END), 0),
    ?
  FROM library_artists AS artist
  LEFT JOIN library_albums AS album ON album.artist_id = artist.id
  LEFT JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
  LEFT JOIN library_media_files AS media ON media.track_id = album_track.track_id
    AND ${ALBUM_MEDIA_JOIN}
  GROUP BY artist.id
`;

// Only albums with available media get a row, matching the inner joins the
// "newly available" query used to run: an album nobody can play was never in
// those results.
const ALBUM_STATS_SQL = `
  INSERT INTO library_album_stats (album_id, first_seen_at, track_count, updated_at)
  SELECT
    album.id,
    MIN(media.created_at),
    COUNT(DISTINCT album_track.track_id),
    ?
  FROM library_albums AS album
  JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
  JOIN library_media_files AS media ON media.track_id = album_track.track_id
    AND ${ALBUM_MEDIA_JOIN}
    AND media.available = 1
  GROUP BY album.id
`;

export function rebuildLibraryRollups() {
  const startedAt = Date.now();
  try {
    db.transaction(() => {
      db.prepare("DELETE FROM library_artist_stats").run();
      db.prepare(ARTIST_STATS_SQL).run(startedAt);
      db.prepare("DELETE FROM library_album_stats").run();
      db.prepare(ALBUM_STATS_SQL).run(startedAt);
    })();
  } catch (error) {
    logger.warn("library", `Library rollup rebuild failed: ${error.message}`);
    return false;
  }
  logger.info("library", `Rebuilt library rollups in ${Date.now() - startedAt}ms`);
  return true;
}

/**
 * Builds the rollups if they are missing but the library is populated, which
 * is the case exactly once per database: the upgrade that introduced them.
 * Reads fall back to zeroed counts until this runs, so it is safe to call
 * late, but nothing should have to serve those zeros twice.
 */
export function ensureLibraryRollups() {
  try {
    const hasArtists = db.prepare("SELECT 1 FROM library_artists LIMIT 1").get();
    if (!hasArtists) return false;
    const hasStats = db.prepare("SELECT 1 FROM library_artist_stats LIMIT 1").get();
    if (hasStats) return false;
  } catch {
    return false;
  }
  logger.info("library", "Library rollups are missing; building them once");
  return rebuildLibraryRollups();
}
