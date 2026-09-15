import { db } from "../config/db-sqlite.js";
import { getCanonicalMediaFilesByPaths } from "./libraryQueryService.js";
import { createNavidromeUserClient } from "./navidromeUserClient.js";
import { getPersonalLibraryIdForUser, mediaPathsForNavidromeSongIds } from "./navidromeTrackResolver.js";
import { getLibraryIdsForNavidromeSongIds } from "./navidromeSongIdStore.js";
import { getRecordPlaylistTracks, getTrackTagsForOwner } from "./songRecordService.js";
import { logger } from "./logger.js";

/**
 * Smart playlists that Psalter evaluates and Navidrome only stores.
 *
 * Navidrome's own smart playlists read tags from the files, and the files on
 * the server are not the ones iTunes tagged: they are later copies with older
 * comments or none. The tags that made the playlists live in the person's song
 * records, so the rules are evaluated here over those tags, the ratings the
 * person keeps in Navidrome today, and the songs in their own library, and the
 * result is written to Navidrome as an ordinary playlist every client can play.
 *
 * Nothing is written until an admin switches a playlist on. Before that the
 * report shows what each would hold beside the playlist the person has now.
 */

const PAGE_SIZE = 500;
const MAX_PAGES = 400;
const SONGS_FRESH_MS = 10 * 60 * 1000;
const SAMPLE_SIZE = 8;

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const lower = (value) => String(value ?? "").toLowerCase();
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

const songsByOwner = new Map();

/**
 * The songs in a person's own Navidrome library, keyed by canonical track id,
 * with what Navidrome knows about each for that person: the song id of their
 * copy, their rating, play count and star.
 */
async function readOwnerSongs(owner) {
  const client = createNavidromeUserClient({ username: owner });
  if (!client) throw new Error("Navidrome is not configured");
  const libraryId = await getPersonalLibraryIdForUser(owner);
  const songs = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await client.request("search3", {
      query: '""',
      songCount: PAGE_SIZE,
      songOffset: page * PAGE_SIZE,
      artistCount: 0,
      albumCount: 0,
      ...(libraryId !== null && libraryId !== undefined ? { musicFolderId: libraryId } : {}),
    });
    const batch = asArray(data?.searchResult3?.song);
    songs.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  const ids = songs.map((song) => String(song.id));
  const paths = await mediaPathsForNavidromeSongIds(ids, { maxLookups: Number.POSITIVE_INFINITY });
  const libraries = getLibraryIdsForNavidromeSongIds(ids);
  const files = new Map(
    getCanonicalMediaFilesByPaths([...new Set(paths.values())]).map((file) => [file.path, file]),
  );
  const byTrack = new Map();
  let outside = 0;
  for (const song of songs) {
    const songId = String(song.id);
    // A search limited to his library should only return his copies; when the
    // store knows otherwise, believe the store.
    if (libraryId != null && libraries.has(songId) && Number(libraries.get(songId)) !== Number(libraryId)) {
      outside += 1;
      continue;
    }
    const trackId = Number(files.get(paths.get(songId))?.trackId);
    if (!Number.isSafeInteger(trackId) || trackId <= 0 || byTrack.has(trackId)) continue;
    byTrack.set(trackId, {
      trackId,
      songId,
      title: song.title || "",
      artist: song.artist || "",
      albumArtist: song.displayAlbumArtist || song.albumArtist || "",
      album: song.album || "",
      genre: song.genre || "",
      year: Number(song.year) || 0,
      discNumber: Number(song.discNumber) || 1,
      trackNumber: Number(song.track) || 0,
      created: song.created || "",
      rating: Number(song.userRating) || 0,
      playCount: Number(song.playCount) || 0,
      loved: Boolean(song.starred),
      lastPlayed: song.played || "",
    });
  }
  logger.info(
    "library",
    `[TagPlaylists] ${owner}: ${songs.length} song(s) in library ${libraryId ?? "(all)"}, ${byTrack.size} matched to tracks${outside ? `, ${outside} outside it` : ""}`,
  );
  return { libraryId, songs: byTrack, client };
}

async function getOwnerSongs(owner, { fresh = false } = {}) {
  const entry = songsByOwner.get(owner);
  if (!fresh && entry?.value && Date.now() - entry.at < SONGS_FRESH_MS) return entry.value;
  if (entry?.pending) return entry.pending;
  const pending = readOwnerSongs(owner)
    .then((value) => {
      songsByOwner.set(owner, { value, at: Date.now() });
      return value;
    })
    .finally(() => {
      const current = songsByOwner.get(owner);
      if (current?.pending === pending) songsByOwner.delete(owner);
    });
  songsByOwner.set(owner, { ...(entry || {}), pending });
  return pending;
}

/** Keep the kept songs in step with a rating just saved in Psalter. */
export function noteOwnerTrackRating(owner, trackId, rating) {
  const song = songsByOwner.get(owner)?.value?.songs?.get(Number(trackId));
  if (song) song.rating = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
}

export function resetTagPlaylistState() {
  songsByOwner.clear();
  for (const timer of rebuildTimers.values()) clearTimeout(timer);
  rebuildTimers.clear();
}

// ---------------------------------------------------------------- rules

/** A song's value for one field: his tag where he gave one, the file's otherwise. */
function fieldValue(song, tags, field) {
  switch (field) {
    case "comment": return lower(tags?.comment);
    case "genre": return lower(tags?.genre || song.genre);
    case "artist": return lower(tags?.artist || song.artist);
    case "albumartist": return lower(tags?.albumArtist || song.albumArtist);
    case "album": return lower(tags?.album || song.album);
    case "title": return lower(tags?.title || song.title);
    case "year": return Number(tags?.year || song.year) || 0;
    case "rating": return song.rating;
    case "playcount": return song.playCount;
    case "loved": return song.loved;
    case "dateadded": return String(tags?.dateAdded || song.created || "").slice(0, 10);
    case "lastplayed": return String(song.lastPlayed || "").slice(0, 10);
    default: return undefined;
  }
}

const TEXT = {
  is: (text, value) => text === value,
  isNot: (text, value) => text !== value,
  contains: (text, value) => text.includes(value),
  notContains: (text, value) => !text.includes(value),
  startsWith: (text, value) => text.startsWith(value),
  endsWith: (text, value) => text.endsWith(value),
};

const pair = (value) => (Array.isArray(value) ? value : String(value ?? "").split(",")).map((part) => String(part).trim());
const daysAgo = (days, today) => new Date(today - Number(days) * 86_400_000).toISOString().slice(0, 10);

function test(condition, song, tags, today) {
  const { field, operator } = condition;
  const actual = fieldValue(song, tags, field);
  if (actual === undefined) return undefined;
  const value = condition.value;
  if (typeof actual === "string" && ["comment", "genre", "artist", "albumartist", "album", "title"].includes(field)) {
    const check = TEXT[operator];
    return check ? check(actual, lower(value)) : undefined;
  }
  if (typeof actual === "boolean") {
    return operator === "is" ? actual === (value === true || lower(value) === "true") : undefined;
  }
  if (typeof actual === "number") {
    const number = Number(value);
    switch (operator) {
      case "is": return actual === number;
      case "isNot": return actual !== number;
      case "gt": return actual > number;
      case "lt": return actual < number;
      case "inTheRange": {
        const [low, high] = pair(value).map(Number);
        return actual >= low && actual <= high;
      }
      default: return undefined;
    }
  }
  // Dates, as YYYY-MM-DD strings; a song with no date is in no range.
  if (!actual) return operator === "notInTheLast" ? true : false;
  switch (operator) {
    case "before": return actual < String(value).slice(0, 10);
    case "after": return actual > String(value).slice(0, 10);
    case "inTheLast": return actual >= daysAgo(value, today);
    case "notInTheLast": return actual < daysAgo(value, today);
    case "inTheRange": {
      const [from, to] = pair(value);
      return actual >= from.slice(0, 10) && actual <= to.slice(0, 10);
    }
    default: return undefined;
  }
}

/**
 * Whether one song passes a rule group. A condition this engine cannot judge
 * is left out of the verdict and reported, the same way the dry runs that
 * validated the conversion treated it.
 */
function passes(group, song, tags, today, skipped) {
  const match = group.match === "any" ? "any" : "all";
  const results = [];
  for (const condition of group.conditions || []) {
    const outcome = Array.isArray(condition?.conditions)
      ? passes(condition, song, tags, today, skipped)
      : test(condition, song, tags, today);
    if (outcome === undefined) {
      skipped.add(`${condition?.field} ${condition?.operator}`);
      continue;
    }
    results.push(outcome);
  }
  if (!results.length) return undefined;
  return match === "all" ? results.every(Boolean) : results.some(Boolean);
}

const byListOrder = (a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album)
  || a.discNumber - b.discNumber || a.trackNumber - b.trackNumber || a.title.localeCompare(b.title);

/** The songs a rule set picks from a person's library, in playlist order. */
export function evaluateTagPlaylistRules(rules, songs, tagsByTrack, { today = Date.now() } = {}) {
  const skipped = new Set();
  let picked = [];
  for (const song of songs.values()) {
    if (passes(rules, song, tagsByTrack.get(song.trackId), today, skipped)) picked.push(song);
  }
  if (rules.sort && rules.sort !== "random") {
    const direction = rules.order === "desc" ? -1 : 1;
    picked.sort((a, b) => {
      const left = fieldValue(a, tagsByTrack.get(a.trackId), rules.sort);
      const right = fieldValue(b, tagsByTrack.get(b.trackId), rules.sort);
      if (left === right) return byListOrder(a, b);
      return (left > right ? 1 : -1) * direction;
    });
  } else {
    picked.sort(byListOrder);
  }
  if (Number(rules.limit) > 0) picked = picked.slice(0, Number(rules.limit));
  return { songs: picked, skipped: [...skipped] };
}

// ---------------------------------------------------------------- report

const listRows = (owner) => db.prepare("SELECT * FROM tag_playlists WHERE owner = ? ORDER BY name COLLATE NOCASE").all(owner);

const describeSong = (song, tags) => `${tags?.title || song.title} — ${tags?.artist || song.artist}`;

function compare(picked, target) {
  if (!target) return null;
  let keeps = 0;
  for (const trackId of picked) if (target.has(trackId)) keeps += 1;
  const union = picked.size + target.size - keeps;
  return {
    count: target.size,
    keeps,
    drops: target.size - keeps,
    adds: picked.size - keeps,
    overlap: union ? keeps / union : 1,
  };
}

/** A person's current Navidrome playlists by lower-cased name, as canonical track sets. */
async function readCurrentPlaylists(client) {
  const playlists = new Map();
  for (const playlist of await client.getSubsonicPlaylists()) {
    const name = String(playlist?.name || "").trim().toLowerCase();
    if (!name || playlist.owner !== client.user) continue;
    const full = await client.getSubsonicPlaylist(playlist.id);
    const entries = full?.entry || [];
    const ids = entries.map((entry) => String(entry.id));
    const paths = await mediaPathsForNavidromeSongIds(ids, { maxLookups: Number.POSITIVE_INFINITY });
    const files = new Map(getCanonicalMediaFilesByPaths([...new Set(paths.values())]).map((file) => [file.path, file]));
    const tracks = new Set(ids.map((id) => Number(files.get(paths.get(id))?.trackId)).filter((id) => id > 0));
    const entry = { id: playlist.id, name: playlist.name, tracks, songCount: entries.length };
    // Two lists of one name: the bigger is the one he has been using.
    if (!playlists.has(name) || playlists.get(name).songCount < entry.songCount) playlists.set(name, entry);
  }
  return playlists;
}

/**
 * What every smart playlist would hold, beside the playlist of that name the
 * person has in Navidrome now and the list iTunes last exported. Writes
 * nothing.
 */
export async function getTagPlaylistReport({ owner, fresh = false } = {}) {
  const { songs, client, libraryId } = await getOwnerSongs(owner, { fresh });
  const tags = getTrackTagsForOwner(owner);
  const originals = getRecordPlaylistTracks(owner);
  const current = await readCurrentPlaylists(client);
  const inLibrary = new Set(songs.keys());

  const items = listRows(owner).map((row) => {
    const rules = parse(row.rules_json, { conditions: [] });
    const { songs: picked, skipped } = evaluateTagPlaylistRules(rules, songs, tags);
    const pickedIds = new Set(picked.map((song) => song.trackId));
    const now = current.get(row.name.trim().toLowerCase()) || null;
    const original = originals.get(row.name.trim().toLowerCase());
    const originalHere = original ? new Set([...original].filter((id) => inLibrary.has(id))) : null;
    const sample = (ids) => ids.slice(0, SAMPLE_SIZE).map((id) => {
      const song = songs.get(id);
      return song ? describeSong(song, tags.get(id)) : `Track ${id}`;
    });
    return {
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      rules,
      unsupported: parse(row.unsupported_json, []),
      notEvaluated: skipped,
      count: picked.length,
      current: now
        ? {
          playlistId: now.id,
          ...compare(pickedIds, now.tracks),
          addSample: sample([...pickedIds].filter((id) => !now.tracks.has(id))),
          dropSample: [...now.tracks].filter((id) => !pickedIds.has(id)).slice(0, SAMPLE_SIZE).map((id) => {
            const song = songs.get(id);
            const tag = tags.get(id);
            return song ? describeSong(song, tag) : tag ? `${tag.title} — ${tag.artist} (not in his library)` : `Track ${id}`;
          }),
        }
        : null,
      itunes: originalHere ? compare(pickedIds, originalHere) : null,
      navidromePlaylistId: row.navidrome_playlist_id,
      lastBuiltAt: row.last_built_at,
      lastError: row.last_error,
      hasSnapshot: Boolean(db.prepare("SELECT 1 FROM tag_playlist_snapshots WHERE tag_playlist_id = ?").get(row.id)),
    };
  });

  items.sort((a, b) => {
    // Holiday first: it is the season, and the one he will notice.
    const holiday = (item) => (item.name.trim().toLowerCase() === "holiday" ? 0 : 1);
    return holiday(a) - holiday(b) || (b.itunes?.overlap ?? -1) - (a.itunes?.overlap ?? -1) || a.name.localeCompare(b.name);
  });
  return { owner, libraryId, songsInLibrary: songs.size, taggedSongs: [...inLibrary].filter((id) => tags.has(id)).length, items };
}

// ---------------------------------------------------------------- writing

/**
 * Write one switched-on playlist to Navidrome as an ordinary playlist. The
 * first write keeps what the playlist held before, for undo. An unchanged
 * result writes nothing.
 */
export async function buildTagPlaylist(id, { fresh = false } = {}) {
  const row = db.prepare("SELECT * FROM tag_playlists WHERE id = ?").get(Number(id));
  if (!row) return { status: "missing" };
  if (!row.enabled) return { status: "disabled" };
  const at = Date.now();
  try {
    const { songs, client } = await getOwnerSongs(row.owner, { fresh });
    const { songs: picked } = evaluateTagPlaylistRules(parse(row.rules_json, { conditions: [] }), songs, getTrackTagsForOwner(row.owner));
    const songIds = picked.map((song) => song.songId);

    let playlistId = row.navidrome_playlist_id;
    if (playlistId) {
      const exists = await client.getSubsonicPlaylist(playlistId).catch(() => null);
      if (!exists) playlistId = null;
    }
    if (!playlistId) {
      const existing = (await client.getSubsonicPlaylists())
        .filter((playlist) => playlist.owner === client.user && String(playlist.name).trim().toLowerCase() === row.name.trim().toLowerCase())
        .sort((a, b) => (b.songCount || 0) - (a.songCount || 0))[0];
      playlistId = existing?.id || null;
    }

    if (playlistId && !db.prepare("SELECT 1 FROM tag_playlist_snapshots WHERE tag_playlist_id = ?").get(row.id)) {
      const before = await client.getSubsonicPlaylist(playlistId);
      db.prepare(
        "INSERT INTO tag_playlist_snapshots (tag_playlist_id, navidrome_playlist_id, song_ids_json, created_at) VALUES (?, ?, ?, ?)",
      ).run(row.id, playlistId, JSON.stringify((before?.entry || []).map((entry) => String(entry.id))), at);
    }

    const unchanged = playlistId && row.navidrome_playlist_id === playlistId
      && JSON.stringify(songIds) === (row.last_song_ids_json || "");
    if (unchanged) {
      db.prepare("UPDATE tag_playlists SET last_built_at = ?, last_error = NULL WHERE id = ?").run(at, row.id);
      return { status: "unchanged", count: songIds.length };
    }
    if (playlistId) {
      await client.updatePlaylist(playlistId, { name: row.name, songIds });
    } else {
      playlistId = (await client.createPlaylist(row.name, songIds))?.id || null;
    }
    db.prepare(
      `UPDATE tag_playlists SET navidrome_playlist_id = ?, last_song_ids_json = ?, last_built_at = ?,
         last_error = NULL, updated_at = ? WHERE id = ?`,
    ).run(playlistId, JSON.stringify(songIds), at, at, row.id);
    logger.info("library", `[TagPlaylists] ${row.owner} / ${row.name}: wrote ${songIds.length} song(s)`);
    return { status: "written", count: songIds.length, playlistId };
  } catch (error) {
    db.prepare("UPDATE tag_playlists SET last_error = ?, updated_at = ? WHERE id = ?").run(error.message, at, row.id);
    logger.warn("library", `[TagPlaylists] ${row.owner} / ${row.name}: ${error.message}`);
    return { status: "failed", error: error.message };
  }
}

/** Switch a playlist on (and write it now) or off (Navidrome keeps what it has). */
export async function setTagPlaylistEnabled(id, enabled) {
  const result = db.prepare("UPDATE tag_playlists SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, Date.now(), Number(id));
  if (!result.changes) return { status: "missing" };
  return enabled ? buildTagPlaylist(id) : { status: "disabled" };
}

/** Put back what the playlist held before Psalter first wrote it, and switch it off. */
export async function undoTagPlaylist(id) {
  const row = db.prepare("SELECT * FROM tag_playlists WHERE id = ?").get(Number(id));
  const snapshot = row && db.prepare(
    "SELECT * FROM tag_playlist_snapshots WHERE tag_playlist_id = ? ORDER BY id LIMIT 1",
  ).get(row.id);
  if (!row || !snapshot?.navidrome_playlist_id) return { status: "missing" };
  const client = createNavidromeUserClient({ username: row.owner });
  await client.updatePlaylist(snapshot.navidrome_playlist_id, { name: row.name, songIds: parse(snapshot.song_ids_json, []) });
  db.prepare(
    "UPDATE tag_playlists SET enabled = 0, last_song_ids_json = NULL, updated_at = ? WHERE id = ?",
  ).run(Date.now(), row.id);
  db.prepare("DELETE FROM tag_playlist_snapshots WHERE tag_playlist_id = ?").run(row.id);
  return { status: "restored", count: parse(snapshot.song_ids_json, []).length };
}

const rebuildTimers = new Map();

/** Rebuild a person's switched-on playlists soon, once for a burst of changes. */
export function scheduleTagPlaylistRebuild(owner, { delayMs = 20_000, reason = "" } = {}) {
  if (!owner || rebuildTimers.has(owner)) return;
  const enabled = db.prepare("SELECT id FROM tag_playlists WHERE owner = ? AND enabled = 1").all(owner);
  if (!enabled.length) return;
  const timer = setTimeout(async () => {
    rebuildTimers.delete(owner);
    const counts = {};
    for (const { id } of enabled) {
      const { status } = await buildTagPlaylist(id);
      counts[status] = (counts[status] || 0) + 1;
    }
    logger.info("library", `[TagPlaylists] Rebuilt ${owner}'s playlists${reason ? ` (${reason})` : ""}: ${JSON.stringify(counts)}`);
  }, delayMs);
  timer.unref?.();
  rebuildTimers.set(owner, timer);
}
