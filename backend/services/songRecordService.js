import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { db } from "../config/db-sqlite.js";
import { resolveAurralDataDir } from "../config/data-dir.js";
import { getNavidromeRootMapping } from "../config/featureFlags.js";
import { getCanonicalMediaFilesByPaths } from "./libraryQueryService.js";
import { joinRoot, navidromeRelativePath, normalizePath } from "./navidromePathMapping.js";
import { buildCandidateIndex, matchRecords, normAlbum, normArtist } from "./songRecordMatching.js";
import { logger } from "./logger.js";

/**
 * A person's songs as their old music library knew them.
 *
 * The record is the backbone: title, artist, album, length and the tags the
 * person gave the song, kept whether or not the file is on the server. Which
 * canonical track a record is lives in song_record_links, made first from the
 * migration's match and afterwards by songRecordMatching whenever music
 * arrives. So a song rated in iTunes and ripped years later picks its tags
 * back up the day Lidarr imports it, even when MusicBrainz renamed it.
 */

// Where a person's old library came from. The shape of a record is the same
// either way; the name is what the pages call it, and it keeps one person's
// iPod from colliding with another's iTunes in (owner, source, source_key).
const SOURCES = {
  "psalter-itunes-library": "itunes",
  "psalter-ipod-library": "ipod",
};
const BUNDLE_FORMATS = Object.keys(SOURCES);
// Links the matcher may replace. An admin's confirm or reject is final.
const TRUSTED = new Set(["linked", "confirmed", "review"]);

const now = () => Date.now();
const clean = (value) => {
  const text = String(value ?? "").trim();
  return text || null;
};
const whole = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
};

export class SongRecordImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "SongRecordImportError";
    this.status = 400;
  }
}

/** Navidrome's library-relative path to the file Psalter indexes. */
function aurralPathForNavidromePath(navidromePath) {
  const roots = getNavidromeRootMapping();
  if (!roots?.aurralRoot) return null;
  return normalizePath(joinRoot(roots.aurralRoot, navidromeRelativePath(normalizePath(navidromePath), roots.navidromeRoot)));
}

const upsertRecordStmt = () => db.prepare(`
  INSERT INTO song_records (
    owner, source, source_key, title, artist, album_artist, album, disc_number, track_number,
    duration_ms, year, genre, comment, rating, loved, play_count, date_added, track_type,
    metadata_json, created_at, updated_at
  ) VALUES (
    @owner, @source, @sourceKey, @title, @artist, @albumArtist, @album, @discNumber, @trackNumber,
    @durationMs, @year, @genre, @comment, @rating, @loved, @playCount, @dateAdded, @trackType,
    @metadata, @at, @at
  )
  ON CONFLICT (owner, source, source_key) DO UPDATE SET
    title = excluded.title, artist = excluded.artist, album_artist = excluded.album_artist,
    album = excluded.album, disc_number = excluded.disc_number, track_number = excluded.track_number,
    duration_ms = excluded.duration_ms, year = excluded.year, genre = excluded.genre,
    comment = excluded.comment, rating = excluded.rating, loved = excluded.loved,
    play_count = excluded.play_count, date_added = excluded.date_added, track_type = excluded.track_type,
    metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
  RETURNING id
`);

/**
 * Take in the bundle export_psalter_library.py writes. Safe to repeat: records
 * are updated in place, admin decisions on links are kept, and a smart
 * playlist's switch and Navidrome playlist survive.
 */
export function importSongRecordBundle(bundle) {
  const source = SOURCES[bundle?.format];
  if (!source || !Array.isArray(bundle.records)) {
    throw new SongRecordImportError(
      `This is not a Psalter library bundle (expected one of: ${BUNDLE_FORMATS.join(", ")})`,
    );
  }
  const owner = clean(bundle.owner);
  if (!owner) throw new SongRecordImportError("The bundle does not say whose library it is");
  if (!db.prepare("SELECT 1 FROM users WHERE username = ?").get(owner)) {
    throw new SongRecordImportError(`No Psalter user is called ${owner}`);
  }

  const at = now();
  const upsertRecord = upsertRecordStmt();
  const existingLink = db.prepare("SELECT status FROM song_record_links WHERE record_id = ?");
  const writeLink = db.prepare(`
    INSERT INTO song_record_links (record_id, track_id, method, status, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (record_id) DO UPDATE SET
      track_id = excluded.track_id, method = excluded.method, status = excluded.status, updated_at = excluded.updated_at
  `);

  const idByKey = new Map();
  const seeds = [];
  db.transaction(() => {
    for (const entry of bundle.records) {
      const sourceKey = clean(entry?.key);
      if (!sourceKey) continue;
      const { id } = upsertRecord.get({
        owner,
        source,
        sourceKey,
        title: clean(entry.title),
        artist: clean(entry.artist),
        albumArtist: clean(entry.albumArtist),
        album: clean(entry.album),
        discNumber: whole(entry.discNumber),
        trackNumber: whole(entry.trackNumber),
        durationMs: whole(entry.durationMs),
        year: whole(entry.year),
        genre: clean(entry.genre),
        comment: clean(entry.comment),
        rating: Math.max(0, Math.min(5, whole(entry.rating) || 0)),
        loved: entry.loved ? 1 : 0,
        playCount: Math.max(0, whole(entry.playCount) || 0),
        dateAdded: clean(entry.dateAdded),
        trackType: clean(entry.trackType),
        metadata: JSON.stringify({
          persistentId: entry.persistentId || null,
          skipCount: entry.skipCount || 0,
          lastPlayed: entry.lastPlayed || null,
          kind: entry.kind || null,
        }),
        at,
      });
      idByKey.set(sourceKey, id);
      if (entry.link?.navidromePath) seeds.push({ id, ...entry.link });
    }

    const paths = new Map(seeds.map((seed) => [seed.id, aurralPathForNavidromePath(seed.navidromePath)]));
    const files = new Map(
      getCanonicalMediaFilesByPaths([...new Set([...paths.values()].filter(Boolean))]).map((file) => [file.path, file]),
    );
    for (const seed of seeds) {
      const status = existingLink.get(seed.id)?.status;
      if (status === "confirmed" || status === "rejected") continue;
      const trackId = Number(files.get(paths.get(seed.id))?.trackId);
      if (!Number.isSafeInteger(trackId) || trackId <= 0) continue;
      writeLink.run(seed.id, trackId, `migration: ${seed.method || "matched"}`, seed.ambiguous ? "review" : "linked", at);
    }

    const writePlaylist = db.prepare(`
      INSERT INTO song_record_playlists (owner, name, kind, record_ids_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (owner, name) DO UPDATE SET
        kind = excluded.kind, record_ids_json = excluded.record_ids_json, updated_at = excluded.updated_at
    `);
    for (const playlist of Array.isArray(bundle.playlists) ? bundle.playlists : []) {
      const name = clean(playlist?.name);
      if (!name) continue;
      const ids = [...new Set((playlist.keys || []).map((key) => idByKey.get(key)).filter(Boolean))];
      writePlaylist.run(owner, name, clean(playlist.kind), JSON.stringify(ids), at);
    }

    const writeSmart = db.prepare(`
      INSERT INTO tag_playlists (owner, name, rules_json, unsupported_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (owner, name) DO UPDATE SET
        rules_json = excluded.rules_json, unsupported_json = excluded.unsupported_json, updated_at = excluded.updated_at
    `);
    for (const smart of Array.isArray(bundle.smartPlaylists) ? bundle.smartPlaylists : []) {
      const name = clean(smart?.name);
      const conditions = smart?.rules?.conditions;
      if (!name || !Array.isArray(conditions) || !conditions.length) continue;
      writeSmart.run(owner, name, JSON.stringify(smart.rules), JSON.stringify(smart.unsupported || []), at, at);
    }
  })();

  const seeded = db.prepare(
    `SELECT COUNT(*) AS count FROM song_record_links AS link
     JOIN song_records AS record ON record.id = link.record_id
     WHERE record.owner = ? AND link.status != 'rejected'`,
  ).get(owner).count;
  logger.info("library", `[SongRecords] Imported ${idByKey.size} song(s) for ${owner}; ${seeded} linked`);
  const relinked = relinkSongRecords({ owner });
  return { owner, source, records: idByKey.size, linked: seeded + relinked.linked, review: relinked.review };
}

/**
 * Import any bundle left in the data folder's imports directory, then rename
 * it so it is not imported again. The migration is a one-off, so dropping the
 * file beside the database is simpler than uploading it.
 */
export function importSongRecordBundlesFromDisk({ dir = path.join(resolveAurralDataDir(), "imports") } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /\.json(\.gz)?$/.test(name));
  } catch {
    return [];
  }
  const results = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    try {
      const bytes = fs.readFileSync(file);
      const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
      const result = importSongRecordBundle(JSON.parse(text));
      fs.renameSync(file, `${file}.imported-${new Date().toISOString().slice(0, 10)}`);
      logger.info("library", `[SongRecords] Imported ${name}: ${JSON.stringify(result)}`);
      results.push({ name, ...result });
    } catch (error) {
      logger.warn("library", `[SongRecords] Could not import ${name}: ${error.message}`);
      results.push({ name, error: error.message });
    }
  }
  return results;
}

/** Every available canonical track, in the shape the matcher reads. */
function loadCandidateTracks() {
  return db.prepare(`
    SELECT track.id AS trackId, track.title AS title, track.artist_name AS artistName,
           album.title AS albumTitle, COALESCE(album.album_artist, artist.name) AS albumArtist,
           album.id AS albumId, MAX(media.duration_ms) AS durationMs
    FROM library_tracks AS track
    JOIN library_media_files AS media ON media.track_id = track.id AND media.available = 1
    LEFT JOIN library_album_tracks AS membership ON membership.track_id = track.id
    LEFT JOIN library_albums AS album ON album.id = COALESCE(media.album_id, membership.album_id)
    LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
    GROUP BY track.id
  `).all();
}

const recordColumns = `
  record.id AS id, record.owner AS owner, record.title AS title, record.artist AS artist,
  record.album_artist AS albumArtist, record.album AS album, record.disc_number AS discNumber,
  record.track_number AS trackNumber, record.duration_ms AS durationMs, record.year AS year,
  record.genre AS genre, record.comment AS comment, record.rating AS rating, record.loved AS loved,
  record.play_count AS playCount, record.date_added AS dateAdded, record.track_type AS trackType,
  record.dismissed_at AS dismissedAt`;

/**
 * Look for the files of songs that have none yet. Runs after an import from
 * Lidarr and nightly; cheap, because only records still waiting are matched.
 * Returns how many links it made.
 */
export function relinkSongRecords({ owner = null } = {}) {
  const owners = owner
    ? [owner]
    : db.prepare("SELECT DISTINCT owner FROM song_records").all().map((row) => row.owner);
  const totals = { linked: 0, review: 0 };
  if (!owners.length) return totals;
  const index = buildCandidateIndex(loadCandidateTracks());
  const writeLink = db.prepare(`
    INSERT INTO song_record_links (record_id, track_id, method, status, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (record_id) DO UPDATE SET
      track_id = excluded.track_id, method = excluded.method, status = excluded.status, updated_at = excluded.updated_at
  `);

  for (const person of owners) {
    const rows = db.prepare(`
      SELECT ${recordColumns}, link.track_id AS linkedTrackId, link.status AS linkStatus
      FROM song_records AS record
      LEFT JOIN song_record_links AS link ON link.record_id = record.id
      WHERE record.owner = ?
    `).all(person);
    const claimed = new Set();
    const landed = new Map();
    const waiting = [];
    const rejected = new Map();
    for (const row of rows) {
      if (row.linkedTrackId && TRUSTED.has(row.linkStatus)) {
        claimed.add(row.linkedTrackId);
        const album = index.byTrackId.get(row.linkedTrackId)?.albumId;
        const key = `${normArtist(row.albumArtist || row.artist)}\n${normAlbum(row.album)}`;
        if (album && !landed.has(key)) landed.set(key, album);
      } else {
        // Cloud-only songs wait too: the CD may be ripped yet.
        if (row.linkStatus === "rejected") rejected.set(row.id, row.linkedTrackId);
        waiting.push(row);
      }
    }
    if (!waiting.length) continue;
    const links = matchRecords(waiting, index, { claimedTrackIds: claimed, linkedAlbums: landed });
    const at = now();
    let linked = 0;
    let review = 0;
    db.transaction(() => {
      for (const [recordId, link] of links) {
        // An admin already said this record is not that file.
        if (rejected.get(recordId) === link.trackId) continue;
        const status = link.ambiguous ? "review" : "linked";
        writeLink.run(recordId, link.trackId, link.method, status, at);
        if (status === "review") review += 1;
        else linked += 1;
      }
    })();
    if (linked || review) {
      logger.info("library", `[SongRecords] ${person}: ${linked} song(s) found on the server, ${review} to check`);
    }
    totals.linked += linked;
    totals.review += review;
  }
  return totals;
}

let relinkTimer = null;

/**
 * Relink soon, once: several imports in a row cost one pass. Tag playlists
 * that are switched on are rebuilt afterwards when anything changed.
 */
export function scheduleSongRecordRelink({ delayMs = 30_000 } = {}) {
  if (relinkTimer) return;
  relinkTimer = setTimeout(async () => {
    relinkTimer = null;
    try {
      const totals = relinkSongRecords();
      const { scheduleTagPlaylistRebuild } = await import("./tagPlaylistService.js");
      for (const { owner } of db.prepare("SELECT DISTINCT owner FROM tag_playlists WHERE enabled = 1").all()) {
        scheduleTagPlaylistRebuild(owner, { reason: totals.linked ? "new songs linked" : "library changed" });
      }
    } catch (error) {
      logger.warn("library", `[SongRecords] Relink failed: ${error.message}`);
    }
  }, delayMs);
  relinkTimer.unref?.();
}

/** People with an imported library, and how far along each one's is. */
/** Whether this person's library came in from iTunes, records and all. */
export function hasSongRecords(owner) {
  if (!owner) return false;
  return Boolean(db.prepare("SELECT 1 FROM song_records WHERE owner = ? LIMIT 1").get(owner));
}

export function listSongRecordOwners() {
  return db.prepare(`
    SELECT record.owner AS owner,
           MIN(record.source) AS source,
           COUNT(*) AS records,
           SUM(CASE WHEN link.status IN ('linked', 'confirmed') THEN 1 ELSE 0 END) AS linked,
           SUM(CASE WHEN link.status = 'review' THEN 1 ELSE 0 END) AS review,
           SUM(CASE WHEN link.record_id IS NULL OR link.status = 'rejected' THEN 1 ELSE 0 END) AS unlinked,
           SUM(CASE WHEN record.rating > 0 THEN 1 ELSE 0 END) AS rated
    FROM song_records AS record
    LEFT JOIN song_record_links AS link ON link.record_id = record.id
    GROUP BY record.owner
    ORDER BY record.owner
  `).all();
}

function playlistNamesByRecord(owner) {
  const names = new Map();
  for (const row of db.prepare(
    "SELECT name, kind, record_ids_json AS ids FROM song_record_playlists WHERE owner = ?",
  ).all(owner)) {
    // A smart playlist's songs follow from the tags; only lists he made by hand
    // say he wanted that particular song.
    if (row.kind !== "user") continue;
    for (const id of JSON.parse(row.ids || "[]")) {
      const list = names.get(id);
      if (list) list.push(row.name);
      else names.set(id, [row.name]);
    }
  }
  return names;
}

const songView = (row, playlists) => ({
  id: row.id,
  title: row.title,
  artist: row.artist,
  album: row.album,
  discNumber: row.discNumber,
  trackNumber: row.trackNumber,
  durationMs: row.durationMs,
  year: row.year,
  genre: row.genre,
  comment: row.comment,
  rating: row.rating,
  loved: Boolean(row.loved),
  playCount: row.playCount,
  dateAdded: row.dateAdded,
  cloudOnly: row.trackType === "Remote",
  dismissed: Boolean(row.dismissedAt),
  playlists: playlists.get(row.id) || [],
});

/**
 * The songs of a person's old library that have no file on the server,
 * gathered by album, most wanted first: albums with the most rated songs, then
 * the most loved and most played. A record whose file was linked once but has
 * since gone from disk counts as missing too.
 */
export function getMissingSongsReport({ owner, includeDismissed = false, includeDuplicates = false } = {}) {
  const rows = db.prepare(`
    SELECT ${recordColumns}
    FROM song_records AS record
    LEFT JOIN song_record_links AS link ON link.record_id = record.id AND link.status != 'rejected'
    WHERE record.owner = ?
      AND (link.record_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM library_media_files AS media WHERE media.track_id = link.track_id AND media.available = 1
      ))
  `).all(owner);
  const playlists = playlistNamesByRecord(owner);

  // A record that duplicates one already linked - same album, same length, the
  // untitled "Track 04" beside the titled song - is a second copy in his old
  // library, not music the server lacks.
  const twins = new Set();
  for (const row of db.prepare(`
    SELECT record.album AS album, record.duration_ms AS durationMs
    FROM song_records AS record
    JOIN song_record_links AS link ON link.record_id = record.id AND link.status != 'rejected'
    WHERE record.owner = ? AND record.duration_ms > 0
      AND EXISTS (SELECT 1 FROM library_media_files AS media
                  WHERE media.track_id = link.track_id AND media.available = 1)
  `).all(owner)) {
    const seconds = Math.round(row.durationMs / 1000);
    // A second either way, because the two copies are rips of the same disc
    // rather than the same file.
    for (const offset of [-1, 0, 1]) twins.add(`${normAlbum(row.album)}|${seconds + offset}`);
  }
  const isDuplicate = (row) => row.durationMs > 0
    && twins.has(`${normAlbum(row.album)}|${Math.round(row.durationMs / 1000)}`);

  const albums = new Map();
  let duplicates = 0;
  for (const row of rows) {
    if (row.dismissedAt && !includeDismissed) continue;
    if (isDuplicate(row)) {
      duplicates += 1;
      if (!includeDuplicates) continue;
    }
    const artist = row.albumArtist || row.artist || "Unknown artist";
    const key = `${normArtist(artist)}\n${normAlbum(row.album)}`;
    let album = albums.get(key);
    if (!album) {
      album = { key, album: row.album || "Unknown album", artist, songs: [] };
      albums.set(key, album);
    }
    album.songs.push(songView(row, playlists));
  }
  const items = [...albums.values()].map((album) => {
    const rated = album.songs.filter((song) => song.rating > 0);
    album.songs.sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0));
    return {
      ...album,
      songCount: album.songs.length,
      ratedCount: rated.length,
      topRating: Math.max(0, ...rated.map((song) => song.rating)),
      lovedCount: album.songs.filter((song) => song.loved).length,
      playCount: album.songs.reduce((sum, song) => sum + (song.playCount || 0), 0),
      inPlaylists: album.songs.filter((song) => song.playlists.length).length,
      cloudOnly: album.songs.every((song) => song.cloudOnly),
    };
  });
  items.sort((a, b) => b.ratedCount - a.ratedCount || b.lovedCount - a.lovedCount
    || b.inPlaylists - a.inPlaylists || b.playCount - a.playCount || a.artist.localeCompare(b.artist));
  const songs = items.flatMap((album) => album.songs);
  return {
    owner,
    totals: {
      albums: items.length,
      songs: songs.length,
      duplicates,
      rated: songs.filter((song) => song.rating > 0).length,
      loved: songs.filter((song) => song.loved).length,
      inPlaylists: songs.filter((song) => song.playlists.length).length,
    },
    items,
  };
}

/** Links the matcher was not sure of, beside the file it guessed. */
export function getSongLinkReview({ owner } = {}) {
  const rows = db.prepare(`
    SELECT ${recordColumns}, link.method AS method, link.track_id AS trackId,
           track.title AS trackTitle, track.artist_name AS trackArtist,
           album.title AS trackAlbum, MAX(media.duration_ms) AS trackDurationMs
    FROM song_record_links AS link
    JOIN song_records AS record ON record.id = link.record_id
    LEFT JOIN library_tracks AS track ON track.id = link.track_id
    LEFT JOIN library_media_files AS media ON media.track_id = link.track_id AND media.available = 1
    LEFT JOIN library_albums AS album ON album.id = media.album_id
    WHERE record.owner = ? AND link.status = 'review'
    GROUP BY link.record_id
    ORDER BY record.rating DESC, record.artist, record.album, record.track_number
  `).all(owner);
  const playlists = playlistNamesByRecord(owner);
  return {
    owner,
    items: rows.map((row) => ({
      record: songView(row, playlists),
      method: row.method,
      track: {
        id: row.trackId,
        title: row.trackTitle,
        artist: row.trackArtist,
        album: row.trackAlbum,
        durationMs: row.trackDurationMs,
      },
    })),
  };
}

/** An admin's verdict on a guessed link: confirm keeps it, reject frees the record. */
export function decideSongLink(recordId, decision) {
  const id = Number(recordId);
  if (!["confirm", "reject"].includes(decision)) throw new SongRecordImportError("Decision must be confirm or reject");
  const result = db.prepare("UPDATE song_record_links SET status = ?, updated_at = ? WHERE record_id = ?")
    .run(decision === "confirm" ? "confirmed" : "rejected", now(), id);
  return result.changes > 0;
}

/** Hide a song from the missing list (not wanted any more), or bring it back. */
export function dismissSongRecords(recordIds = [], dismissed = true) {
  const ids = (Array.isArray(recordIds) ? recordIds : [recordIds]).map(Number).filter(Number.isSafeInteger);
  if (!ids.length) return 0;
  const stmt = db.prepare("UPDATE song_records SET dismissed_at = ?, updated_at = ? WHERE id = ?");
  const at = now();
  return db.transaction(() => ids.reduce((sum, id) => sum + stmt.run(dismissed ? at : null, at, id).changes, 0))();
}

/**
 * The tags a person gave each canonical track, merged across the records
 * linked to it (iTunes kept duplicates). Guessed links count: the migration's
 * playlists were built on them too.
 */
export function getTrackTagsForOwner(owner) {
  const tags = new Map();
  for (const row of db.prepare(`
    SELECT link.track_id AS trackId, ${recordColumns}
    FROM song_record_links AS link
    JOIN song_records AS record ON record.id = link.record_id
    WHERE record.owner = ? AND link.status != 'rejected'
  `).all(owner)) {
    const current = tags.get(row.trackId);
    if (!current) {
      tags.set(row.trackId, {
        recordIds: [row.id],
        title: row.title,
        artist: row.artist,
        albumArtist: row.albumArtist,
        album: row.album,
        genre: row.genre || "",
        comment: row.comment || "",
        year: row.year || 0,
        dateAdded: row.dateAdded || "",
        itunesRating: row.rating || 0,
        itunesPlayCount: row.playCount || 0,
      });
      continue;
    }
    current.recordIds.push(row.id);
    if (row.comment && !current.comment.includes(row.comment)) current.comment = [current.comment, row.comment].filter(Boolean).join("\n");
    if (row.genre && !current.genre.includes(row.genre)) current.genre = [current.genre, row.genre].filter(Boolean).join("\n");
    current.year = current.year || row.year || 0;
    if (row.dateAdded && (!current.dateAdded || row.dateAdded < current.dateAdded)) current.dateAdded = row.dateAdded;
    current.itunesRating = Math.max(current.itunesRating, row.rating || 0);
    current.itunesPlayCount += row.playCount || 0;
  }
  return tags;
}

/** Old playlists by lower-cased name, as sets of the canonical tracks they hold now. */
export function getRecordPlaylistTracks(owner) {
  const trackByRecord = new Map(db.prepare(`
    SELECT link.record_id AS recordId, link.track_id AS trackId
    FROM song_record_links AS link JOIN song_records AS record ON record.id = link.record_id
    WHERE record.owner = ? AND link.status != 'rejected'
  `).all(owner).map((row) => [row.recordId, row.trackId]));
  const playlists = new Map();
  for (const row of db.prepare("SELECT name, record_ids_json AS ids FROM song_record_playlists WHERE owner = ?").all(owner)) {
    const tracks = new Set(JSON.parse(row.ids || "[]").map((id) => trackByRecord.get(id)).filter(Boolean));
    playlists.set(row.name.trim().toLowerCase(), tracks);
  }
  return playlists;
}
