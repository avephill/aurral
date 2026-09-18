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
    for (const trackId of ids) {
      const current = getTrackTags({ owner, trackId });
      const has = current.includes(value);
      if (remove === has) {
        write(owner, trackId, remove ? current.filter((entry) => entry !== value) : [...current, value]);
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
  const add = (tag, key) => {
    const entry = counts.get(tag) || { tag, songs: 0, own: 0, imported: 0 };
    entry.songs += 1;
    entry[key] += 1;
    counts.set(tag, entry);
  };
  const seen = new Map();
  const retired = new Map();
  for (const [trackId, tags] of getOwnTagsForOwner(owner)) {
    const { added, removed } = splitOwn(tags);
    seen.set(trackId, new Set(added));
    retired.set(trackId, new Set(removed));
    for (const tag of added) add(tag, "own");
  }
  if (includeImported) {
    const rows = db.prepare(`
      SELECT link.track_id AS trackId, record.comment AS comment
      FROM song_record_links AS link
      JOIN song_records AS record ON record.id = link.record_id
      WHERE record.owner = ? AND link.status != 'rejected' AND record.comment IS NOT NULL AND record.comment != ''
    `).all(owner);
    for (const row of rows) {
      const already = seen.get(row.trackId) || new Set();
      const gone = retired.get(row.trackId) || new Set();
      for (const tag of tagsFromComment(row.comment)) {
        // A tag on a song from both sides is one tag on one song, and one
        // taken off here is not on it at all.
        if (already.has(tag) || gone.has(tag)) continue;
        already.add(tag);
        add(tag, "imported");
      }
      seen.set(row.trackId, already);
    }
  }
  return [...counts.values()].sort((a, b) => b.songs - a.songs || a.tag.localeCompare(b.tag));
}

/**
 * Rename a tag everywhere this person has it, or drop it.
 *
 * A tag that came in from iTunes lives in a comment on the imported record,
 * which is left alone: the rename is written as one of their own tags on the
 * same songs, and the old one is recorded as retired so it stops counting.
 */
export function renameTag({ owner, from, to }) {
  const before = normalizeTag(from);
  const after = normalizeTag(to);
  if (!before) return { changed: 0 };
  const tracks = tracksWithTag({ owner, tag: before });
  const imported = importedTagsByTrack(owner);
  let changed = 0;
  db.transaction(() => {
    for (const trackId of tracks) {
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
  if (changed) scheduleRebuild(owner, "tag renamed");
  return { changed, from: before, to: after };
}

/** The canonical tracks one tag is on, from either side. */
export function tracksWithTag({ owner, tag }) {
  const value = normalizeTag(tag);
  if (!value) return [];
  const ids = new Set();
  const retired = new Set();
  for (const [trackId, tags] of getOwnTagsForOwner(owner)) {
    const { added, removed } = splitOwn(tags);
    if (added.includes(value)) ids.add(trackId);
    if (removed.includes(value)) retired.add(trackId);
  }
  const rows = db.prepare(`
    SELECT link.track_id AS trackId, record.comment AS comment
    FROM song_record_links AS link
    JOIN song_records AS record ON record.id = link.record_id
    WHERE record.owner = ? AND link.status != 'rejected' AND record.comment LIKE ?
  `).all(owner, `%${value}%`);
  for (const row of rows) {
    if (retired.has(row.trackId)) continue;
    if (tagsFromComment(row.comment).includes(value)) ids.add(row.trackId);
  }
  return [...ids];
}

/**
 * The tags a rule should see for each song: what iTunes brought, plus what
 * they have put on it here, minus anything they have taken off.
 */
export function mergeOwnTags(tagsByTrack, owner) {
  for (const [trackId, own] of getOwnTagsForOwner(owner)) {
    const entry = tagsByTrack.get(trackId) || { comment: "", genre: "" };
    const { added, removed } = splitOwn(own);
    const merged = [...new Set([...tagsFromComment(entry.comment), ...added])]
      .filter((tag) => !removed.includes(tag));
    tagsByTrack.set(trackId, { ...entry, comment: merged.join(", ") });
  }
  return tagsByTrack;
}

function scheduleRebuild(owner, reason) {
  import("./tagPlaylistService.js")
    .then(({ scheduleTagPlaylistRebuild }) => scheduleTagPlaylistRebuild(owner, { reason }))
    .catch((error) => logger.warn("library", `[Tags] Could not schedule a rebuild: ${error.message}`));
}
