import { db } from "../config/db-sqlite.js";
import { logger } from "./logger.js";

/**
 * Tags a person puts on their songs here.
 *
 * His iTunes library kept these in the comment field, comma separated, and the
 * smart playlists he built read them there - so a tag is still a word in a
 * comment as far as a rule is concerned, and this only changes who can write
 * one. The imported records stay exactly as exported; what is added here is a
 * layer over them, which is also the only way music that arrived after the
 * export can be tagged at all.
 */

const now = () => Date.now();
const MAX_TAG = 60;
const MAX_TAGS = 50;

/** One tag, as it is stored and compared: trimmed, lower case, no commas. */
export const normalizeTag = (value) =>
  String(value ?? "").replace(/,/g, " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_TAG);

export const normalizeTags = (values) => {
  const seen = [];
  for (const value of Array.isArray(values) ? values : []) {
    const tag = normalizeTag(value);
    if (tag && !seen.includes(tag)) seen.push(tag);
  }
  return seen.slice(0, MAX_TAGS);
};

/** The tags a comment holds, the way iTunes wrote them. */
export const tagsFromComment = (comment) =>
  normalizeTags(String(comment ?? "").split(/[,\n]/));

const parse = (text) => {
  try {
    const value = JSON.parse(text || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

export function getOwnTagsForOwner(owner) {
  const rows = db.prepare("SELECT track_id AS trackId, tags_json AS tags FROM track_tags WHERE owner = ?").all(owner);
  return new Map(rows.map((row) => [row.trackId, parse(row.tags)]));
}

// A tag beginning with "-" is one taken off a song that iTunes tagged: the
// imported comment cannot be rewritten, so the removal is recorded beside it.
const splitOwn = (tags) => ({
  added: tags.filter((tag) => !tag.startsWith("-")),
  removed: tags.filter((tag) => tag.startsWith("-")).map((tag) => tag.slice(1)),
});

/** The tags each song arrived from iTunes with. */
function importedTagsByTrack(owner) {
  const byTrack = new Map();
  for (const row of db.prepare(`
    SELECT link.track_id AS trackId, record.comment AS comment
    FROM song_record_links AS link
    JOIN song_records AS record ON record.id = link.record_id
    WHERE record.owner = ? AND link.status != 'rejected' AND record.comment IS NOT NULL AND record.comment != ''
  `).all(owner)) {
    byTrack.set(row.trackId, [...(byTrack.get(row.trackId) || []), ...tagsFromComment(row.comment)]);
  }
  return byTrack;
}

/**
 * The tags a song inherits from an album it is on.
 *
 * A tag put on a record belongs to every song on it - that is the whole point
 * of tagging a record rather than twelve songs - and it is stored once, so a
 * track that joins the album later is already tagged and a rename is one row.
 */
export function albumTagsByTrack(owner) {
  const byTrack = new Map();
  for (const row of db.prepare(`
    SELECT link.track_id AS trackId, album.tags_json AS tags
    FROM album_tags AS album
    JOIN library_album_tracks AS link ON link.album_id = album.album_id
    WHERE album.owner = ?
  `).all(owner)) {
    byTrack.set(row.trackId, [...new Set([...(byTrack.get(row.trackId) || []), ...parse(row.tags)])]);
  }
  return byTrack;
}

/**
 * Every song with a tag on it, and which side each tag came from.
 *
 * The three sources are settled here once so that counting, searching and
 * rule evaluation cannot disagree: a tag taken off a song beats all of them,
 * and a tag arriving from two sides is still one tag on one song.
 */
function tagIndex(owner, { includeImported = true } = {}) {
  const index = new Map();
  const entryFor = (trackId) => {
    let entry = index.get(trackId);
    if (!entry) {
      entry = { own: new Set(), album: new Set(), imported: new Set(), removed: new Set() };
      index.set(trackId, entry);
    }
    return entry;
  };

  for (const [trackId, tags] of getOwnTagsForOwner(owner)) {
    const { added, removed } = splitOwn(tags);
    const entry = entryFor(trackId);
    for (const tag of added) entry.own.add(tag);
    for (const tag of removed) entry.removed.add(tag);
  }
  for (const [trackId, tags] of albumTagsByTrack(owner)) {
    const entry = entryFor(trackId);
    for (const tag of tags) entry.album.add(tag);
  }
  if (includeImported) {
    for (const [trackId, tags] of importedTagsByTrack(owner)) {
      const entry = entryFor(trackId);
      for (const tag of tags) entry.imported.add(tag);
    }
  }

  for (const entry of index.values()) {
    for (const tag of entry.removed) {
      entry.own.delete(tag);
      entry.album.delete(tag);
      entry.imported.delete(tag);
    }
    // Where a tag has more than one origin, the nearest one owns it, so a
    // song is counted once and under the side a person can act on.
    for (const tag of entry.own) {
      entry.album.delete(tag);
      entry.imported.delete(tag);
    }
    for (const tag of entry.album) entry.imported.delete(tag);
    entry.all = new Set([...entry.own, ...entry.album, ...entry.imported]);
  }
  return index;
}

export function getAlbumTags({ owner, albumId }) {
  const row = db.prepare("SELECT tags_json AS tags FROM album_tags WHERE owner = ? AND album_id = ?")
    .get(owner, Number(albumId));
  return parse(row?.tags);
}

function writeAlbum(owner, albumId, tags) {
  const at = now();
  if (!tags.length) {
    db.prepare("DELETE FROM album_tags WHERE owner = ? AND album_id = ?").run(owner, Number(albumId));
    return [];
  }
  db.prepare(`
    INSERT INTO album_tags (owner, album_id, tags_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (owner, album_id) DO UPDATE SET tags_json = excluded.tags_json, updated_at = excluded.updated_at
  `).run(owner, Number(albumId), JSON.stringify(tags), at);
  return tags;
}

/** Replace what one record is tagged with, and so every song on it. */
export function setAlbumTags({ owner, albumId, tags }) {
  const wanted = normalizeTags(tags).filter((tag) => !tag.startsWith("-"));
  const saved = writeAlbum(owner, albumId, wanted);
  scheduleRebuild(owner, "album tags changed");
  return { albumId: Number(albumId), tags: saved };
}

export function getTrackTags({ owner, trackId }) {
  const row = db.prepare("SELECT tags_json AS tags FROM track_tags WHERE owner = ? AND track_id = ?")
    .get(owner, Number(trackId));
  return parse(row?.tags);
}

function write(owner, trackId, tags) {
  const at = now();
  if (!tags.length) {
    db.prepare("DELETE FROM track_tags WHERE owner = ? AND track_id = ?").run(owner, Number(trackId));
    return [];
  }
  db.prepare(`
    INSERT INTO track_tags (owner, track_id, tags_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (owner, track_id) DO UPDATE SET tags_json = excluded.tags_json, updated_at = excluded.updated_at
  `).run(owner, Number(trackId), JSON.stringify(tags), at);
  return tags;
}

/**
 * What one song shows: the tags it carries in its own right, and the ones it
 * only inherits - from a record it is on, or from the iTunes comment. An
 * inherited tag cannot be deleted at the source without changing every other
 * song, so taking it off here is recorded as a removal beside it.
 */
export function getTrackTagDetail({ owner, trackId }) {
  const id = Number(trackId);
  const { added, removed } = splitOwn(getTrackTags({ owner, trackId: id }));
  const seen = new Set(added);
  const inherited = [];
  const take = (tag, from) => {
    if (!tag || seen.has(tag) || removed.includes(tag)) return;
    seen.add(tag);
    inherited.push({ tag, from });
  };
  for (const row of db.prepare(`
    SELECT album.title AS title, tags.tags_json AS tags
    FROM album_tags AS tags
    JOIN library_album_tracks AS link ON link.album_id = tags.album_id
    JOIN library_albums AS album ON album.id = tags.album_id
    WHERE tags.owner = ? AND link.track_id = ?
  `).all(owner, id)) {
    for (const tag of parse(row.tags)) take(tag, row.title || "this record");
  }
  for (const tag of importedTagsByTrack(owner).get(id) || []) take(tag, "iTunes");
  return { trackId: id, tags: added, removed, inherited };
}

/** Replace what one song is tagged with. */
export function setTrackTags({ owner, trackId, tags }) {
  const wanted = normalizeTags(tags);
  const saved = write(owner, trackId, wanted);
  scheduleRebuild(owner, "tags changed");
  return { trackId: Number(trackId), tags: saved };
}

/** Put a tag on songs, or take it off them, without touching their others. */
export function tagTracks({ owner, trackIds = [], tag, remove = false }) {
  const value = normalizeTag(tag);
  if (!value) return { changed: 0, tag: "" };
  const ids = [...new Set(trackIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  let changed = 0;
  db.transaction(() => {
    const inherited = remove ? tagIndex(owner) : null;
    for (const trackId of ids) {
      const current = getTrackTags({ owner, trackId });
      const has = current.includes(value);
      if (remove) {
        const next = current.filter((entry) => entry !== value);
        // A tag the song only inherits - from its record, or from the iTunes
        // comment - cannot be deleted at the source without changing every
        // other song, so the song keeps a note that this one does not apply.
        const source = inherited.get(trackId);
        const stillThere = source?.album.has(value) || source?.imported.has(value);
        if (stillThere && !next.includes(`-${value}`)) next.push(`-${value}`);
        if (has || stillThere) {
          write(owner, trackId, next);
          changed += 1;
        }
      } else if (!has) {
        write(owner, trackId, [...current.filter((entry) => entry !== `-${value}`), value]);
        changed += 1;
      }
    }
  })();
  if (changed) scheduleRebuild(owner, remove ? "tag removed" : "tag added");
  return { changed, tag: value };
}

/** Every tag this person uses, with how many songs carry it. */
export function listTags({ owner, includeImported = true } = {}) {
  const counts = new Map();
  for (const entry of tagIndex(owner, { includeImported }).values()) {
    for (const [key, tags] of [["own", entry.own], ["album", entry.album], ["imported", entry.imported]]) {
      for (const tag of tags) {
        const row = counts.get(tag) || { tag, songs: 0, own: 0, album: 0, imported: 0 };
        row.songs += 1;
        row[key] += 1;
        counts.set(tag, row);
      }
    }
  }
  const albums = new Map();
  for (const row of db.prepare("SELECT tags_json AS tags FROM album_tags WHERE owner = ?").all(owner)) {
    for (const tag of parse(row.tags)) albums.set(tag, (albums.get(tag) || 0) + 1);
  }
  for (const [tag, count] of albums) {
    // A record can be tagged before Aurral knows any of its songs, and the
    // tag is still real - it should not vanish from the list until it goes.
    const row = counts.get(tag) || { tag, songs: 0, own: 0, album: 0, imported: 0 };
    counts.set(tag, { ...row, albums: count });
  }
  return [...counts.values()]
    .map((row) => ({ albums: 0, ...row }))
    .sort((a, b) => b.songs - a.songs || a.tag.localeCompare(b.tag));
}

/**
 * Rename a tag everywhere this person has it, or drop it.
 *
 * A tag on a record is one row, so it is renamed there rather than written
 * onto every song it reaches. A tag that came in from iTunes lives in a
 * comment on the imported record, which is left alone: the rename is written
 * as one of their own tags on the same songs, and the old one is recorded as
 * retired so it stops counting.
 */
export function renameTag({ owner, from, to }) {
  const before = normalizeTag(from);
  const after = normalizeTag(to);
  if (!before) return { changed: 0, albums: 0 };
  const imported = importedTagsByTrack(owner);
  let changed = 0;
  let albums = 0;
  db.transaction(() => {
    for (const row of db.prepare("SELECT album_id AS albumId, tags_json AS tags FROM album_tags WHERE owner = ?").all(owner)) {
      const current = parse(row.tags);
      if (!current.includes(before)) continue;
      const next = current.filter((entry) => entry !== before);
      if (after && !next.includes(after)) next.push(after);
      writeAlbum(owner, row.albumId, next);
      albums += 1;
    }

    const own = getOwnTagsForOwner(owner);
    const candidates = new Set();
    for (const [trackId, tags] of own) {
      if (splitOwn(tags).added.includes(before)) candidates.add(trackId);
    }
    for (const [trackId, tags] of imported) {
      // One already retired on this song is not on it, so leave it alone.
      if (tags.includes(before) && !splitOwn(own.get(trackId) || []).removed.includes(before)) {
        candidates.add(trackId);
      }
    }

    for (const trackId of candidates) {
      const current = getTrackTags({ owner, trackId });
      const next = current.filter((entry) => entry !== before);
      if (after && !next.includes(after)) next.push(after);
      // An imported tag cannot be unwritten - the record is what was exported -
      // so the song keeps a note that this one no longer applies. Renaming as
      // much as removing: otherwise the old name comes back on the next read.
      if ((imported.get(trackId) || []).includes(before) && !next.includes(`-${before}`)) {
        next.push(`-${before}`);
      }
      write(owner, trackId, next);
      changed += 1;
    }
  })();
  if (changed || albums) scheduleRebuild(owner, "tag renamed");
  return { changed, albums, from: before, to: after };
}

/** The canonical tracks one tag is on, from any of the three sides. */
export function tracksWithTag({ owner, tag }) {
  const value = normalizeTag(tag);
  if (!value) return [];
  const ids = [];
  for (const [trackId, entry] of tagIndex(owner)) {
    if (entry.all.has(value)) ids.push(trackId);
  }
  return ids;
}

/**
 * The tags a rule should see for each song: what iTunes brought, plus what
 * they have put on it here, minus anything they have taken off.
 */
export function mergeOwnTags(tagsByTrack, owner) {
  const own = getOwnTagsForOwner(owner);
  const fromAlbum = albumTagsByTrack(owner);
  for (const trackId of new Set([...own.keys(), ...fromAlbum.keys()])) {
    const entry = tagsByTrack.get(trackId) || { comment: "", genre: "" };
    const { added, removed } = splitOwn(own.get(trackId) || []);
    const merged = [
      ...new Set([...tagsFromComment(entry.comment), ...(fromAlbum.get(trackId) || []), ...added]),
    ].filter((tag) => !removed.includes(tag));
    tagsByTrack.set(trackId, { ...entry, comment: merged.join(", ") });
  }
  return tagsByTrack;
}

function scheduleRebuild(owner, reason) {
  import("./tagPlaylistService.js")
    .then(({ scheduleTagPlaylistRebuild }) => scheduleTagPlaylistRebuild(owner, { reason }))
    .catch((error) => logger.warn("library", `[Tags] Could not schedule a rebuild: ${error.message}`));
}
