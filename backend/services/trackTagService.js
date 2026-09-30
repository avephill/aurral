import { db } from "../config/db-sqlite.js";
import { logger } from "./logger.js";

/**
 * Tags a person puts on their songs here.
 *
 * His iTunes library kept these in the comment field, comma separated. They
 * were first read straight from the imported records, as a read-only layer
 * that could only be hidden song by song. Now each record's tags are copied
 * once onto the song it is linked to, as tags of his own (adoptImportedTags),
 * and from then on they are simply his: renamed, removed or added like any
 * other. The imported records themselves stay exactly as exported.
 *
 * A song carries its own tags and those of any record it is on. A tag written
 * "-word" on a song is one taken off it that its record would otherwise give
 * it.
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

// A tag beginning with "-" is one taken off a song that a record it is on
// gives it: the record's tag belongs to every song on it, so the removal is
// recorded beside the one song instead.
const splitOwn = (tags) => ({
  added: tags.filter((tag) => !tag.startsWith("-")),
  removed: tags.filter((tag) => tag.startsWith("-")).map((tag) => tag.slice(1)),
});

// A record's tags as they are copied in. A leading dash is how a song's own
// tags say "taken off", so an iTunes tag that began with one ("- traditional")
// comes across without it rather than reading as a removal.
const adoptable = (comment) =>
  normalizeTags(tagsFromComment(comment).map((tag) => tag.replace(/^[-\s]+/, "")));

/**
 * Copy the tags each iTunes record carried onto the song it is linked to, as
 * the person's own - once per link, so a tag removed afterwards stays removed.
 * A link is marked with the track it was copied to; one that moves to another
 * track is copied again there. Cheap to call often: only links not yet copied
 * are read. The first time it runs, the table as it was is kept aside.
 */
export function adoptImportedTags({ owner = null } = {}) {
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'tags:adoptedItunes:v1'").get()) {
    db.exec("CREATE TABLE IF NOT EXISTS track_tags_before_adoption AS SELECT * FROM track_tags");
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('tags:adoptedItunes:v1', ?)").run(String(now()));
  }
  const rows = db.prepare(`
    SELECT link.record_id AS recordId, link.track_id AS trackId, link.tags_adopted_track_id AS adoptedTo,
           record.owner AS owner, record.comment AS comment
    FROM song_record_links AS link
    JOIN song_records AS record ON record.id = link.record_id
    WHERE link.status != 'rejected'
      AND (link.tags_adopted_track_id IS NULL OR link.tags_adopted_track_id != link.track_id)
      ${owner ? "AND record.owner = ?" : ""}
  `).all(...(owner ? [owner] : []));
  if (!rows.length) return { links: 0, songs: 0 };
  const mark = db.prepare("UPDATE song_record_links SET tags_adopted_track_id = ? WHERE record_id = ?");
  const touched = new Set();
  let songs = 0;
  db.transaction(() => {
    for (const row of rows) {
      // Relinked to another song: what it gave the first one goes with it.
      if (row.adoptedTo) releaseAdoptedTags(row.recordId);
      const tags = adoptable(row.comment);
      if (tags.length) {
        const current = getTrackTags({ owner: row.owner, trackId: row.trackId });
        const { removed } = splitOwn(current);
        // Taken off this song before the copy: the person already said no.
        const adding = tags.filter((tag) => !current.includes(tag) && !removed.includes(tag));
        if (adding.length) {
          write(row.owner, row.trackId, [...current, ...adding]);
          songs += 1;
          touched.add(row.owner);
        }
      }
      mark.run(row.trackId, row.recordId);
    }
  })();
  for (const person of touched) scheduleRebuild(person, "iTunes tags adopted");
  if (songs) logger.info("library", `[Tags] Copied iTunes tags onto ${songs} song(s) from ${rows.length} record link(s)`);
  return { links: rows.length, songs };
}

/**
 * A link judged wrong takes back the tags it copied, from the song it copied
 * them to - unless another record linked to that song carries them too.
 */
export function releaseAdoptedTags(recordId) {
  const row = db.prepare(`
    SELECT link.tags_adopted_track_id AS trackId, record.owner AS owner, record.comment AS comment
    FROM song_record_links AS link JOIN song_records AS record ON record.id = link.record_id
    WHERE link.record_id = ?
  `).get(Number(recordId));
  if (!row?.trackId) return 0;
  const others = new Set(db.prepare(`
    SELECT record.comment AS comment FROM song_record_links AS link
    JOIN song_records AS record ON record.id = link.record_id
    WHERE link.tags_adopted_track_id = ? AND link.record_id != ? AND link.status != 'rejected' AND record.owner = ?
  `).all(row.trackId, Number(recordId), row.owner).flatMap((other) => adoptable(other.comment)));
  const taking = adoptable(row.comment).filter((tag) => !others.has(tag));
  const current = getTrackTags({ owner: row.owner, trackId: row.trackId });
  const next = current.filter((tag) => !taking.includes(tag));
  if (next.length !== current.length) {
    write(row.owner, row.trackId, next);
    scheduleRebuild(row.owner, "a wrong link let go");
  }
  db.prepare("UPDATE song_record_links SET tags_adopted_track_id = NULL WHERE record_id = ?").run(Number(recordId));
  return current.length - next.length;
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
function tagIndex(owner) {
  const index = new Map();
  const entryFor = (trackId) => {
    let entry = index.get(trackId);
    if (!entry) {
      entry = { own: new Set(), album: new Set(), removed: new Set() };
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

  for (const entry of index.values()) {
    for (const tag of entry.removed) {
      entry.own.delete(tag);
      entry.album.delete(tag);
    }
    // Where a tag has both origins, the song's own owns it, so a song is
    // counted once and under the side a person can act on.
    for (const tag of entry.own) entry.album.delete(tag);
    entry.all = new Set([...entry.own, ...entry.album]);
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
 * only inherits from a record it is on. An inherited tag cannot be deleted at
 * the record without changing every other song on it, so taking it off here
 * is recorded as a removal beside it.
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
        // A tag the song only inherits from its record cannot be deleted
        // there without changing every other song on it, so the song keeps a
        // note that this one does not apply.
        const source = inherited.get(trackId);
        const stillThere = source?.album.has(value);
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
export function listTags({ owner } = {}) {
  const counts = new Map();
  for (const entry of tagIndex(owner).values()) {
    for (const [key, tags] of [["own", entry.own], ["album", entry.album]]) {
      for (const tag of tags) {
        const row = counts.get(tag) || { tag, songs: 0, own: 0, album: 0 };
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
    // A record can be tagged before Psalter knows any of its songs, and the
    // tag is still real - it should not vanish from the list until it goes.
    const row = counts.get(tag) || { tag, songs: 0, own: 0, album: 0 };
    counts.set(tag, { ...row, albums: count });
  }
  return [...counts.values()]
    .map((row) => ({ albums: 0, ...row }))
    .sort((a, b) => b.songs - a.songs || a.tag.localeCompare(b.tag));
}

/**
 * Rename a tag everywhere this person has it, or drop it. A tag on a record is
 * one row, so it is renamed there rather than written onto every song it
 * reaches.
 */
export function renameTag({ owner, from, to }) {
  const before = normalizeTag(from);
  const after = normalizeTag(to);
  if (!before) return { changed: 0, albums: 0 };
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

    for (const trackId of candidates) {
      const current = getTrackTags({ owner, trackId });
      const next = current.filter((entry) => entry !== before);
      if (after && !next.includes(after)) next.push(after);
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
 * The songs carrying several tags: all of them, or any one of them. A song's
 * tags are its own and its record's, minus what has been taken off it - the
 * same as a smart playlist sees.
 */
export function tracksWithTags({ owner, tags = [], match = "all" }) {
  const wanted = [...new Set(tags.map(normalizeTag).filter(Boolean))];
  if (!wanted.length) return [];
  const ids = [];
  for (const [trackId, entry] of tagIndex(owner)) {
    const hit = match === "any"
      ? wanted.some((tag) => entry.all.has(tag))
      : wanted.every((tag) => entry.all.has(tag));
    if (hit) ids.push(trackId);
  }
  return ids;
}

/**
 * The tags a rule should see for each song, set on each entry both as a list
 * (for "has the tag") and as the comma-separated comment iTunes rules read
 * ("comment contains"). The imported comment is not read: its tags were
 * copied in as the person's own, and may have been changed since.
 */
export function mergeOwnTags(tagsByTrack, owner) {
  const index = tagIndex(owner);
  for (const trackId of new Set([...tagsByTrack.keys(), ...index.keys()])) {
    const entry = tagsByTrack.get(trackId) || { comment: "", genre: "" };
    const tags = [...(index.get(trackId)?.all || [])];
    // Written the way his iTunes comments were, every tag followed by a comma
    // ("holiday, mellow,"): rules he wrote such as "contains country," rely on
    // it to tell country from country rock, wherever the tag falls.
    tagsByTrack.set(trackId, { ...entry, tags, comment: tags.length ? `${tags.join(", ")},` : "" });
  }
  return tagsByTrack;
}

function scheduleRebuild(owner, reason) {
  import("./tagPlaylistService.js")
    .then(({ scheduleTagPlaylistRebuild }) => scheduleTagPlaylistRebuild(owner, { reason }))
    .catch((error) => logger.warn("library", `[Tags] Could not schedule a rebuild: ${error.message}`));
}
