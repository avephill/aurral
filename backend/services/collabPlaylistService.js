import { db } from "../config/db-sqlite.js";
import { normalizePath } from "./navidromePathMapping.js";
import { mediaPathsForNavidromeSongIds } from "./navidromeTrackResolver.js";
import { SocialError, defaultSocialDeps, resolveCopiesForUser } from "./socialService.js";
import { sharesWith } from "./congregationService.js";
import { logger } from "./logger.js";

/**
 * A playlist several people build together.
 *
 * Navidrome gives a playlist one owner and no way for anyone else to change
 * it, so there is no single playlist here that two people could both edit.
 * Instead the real list lives in Psalter as file paths - the one identity a
 * song keeps across everybody's libraries - and each member holds their own
 * copy of it in their own account, playable in any client.
 *
 * Each pass reads every member's copy and compares it against what Psalter
 * last wrote there. What they added is added for everyone; what they took out
 * goes for everyone. Then every copy is written again from the shared list.
 *
 * Comparing against what was last written to that person, rather than against
 * the shared list, is what makes it safe: a song their library does not hold
 * was never written to their copy, so its absence is not read as them removing
 * it.
 */

const now = () => Date.now();
const clean = (value, limit = 200) => String(value ?? "").trim().slice(0, limit);
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

/** One of Psalter's own rule-kept playlists, which are ordinary ones to Navidrome. */
const isTagPlaylist = (owner, name) => Boolean(db.prepare(
  "SELECT 1 FROM tag_playlists WHERE owner = ? AND enabled = 1 AND LOWER(TRIM(name)) = LOWER(TRIM(?))",
).get(owner, String(name || "")));

const knownUser = (username) =>
  Boolean(db.prepare("SELECT 1 FROM users WHERE username = ?").get(username));

const collabRow = (id) => db.prepare("SELECT * FROM collab_playlists WHERE id = ?").get(Number(id));

const memberRows = (collabId) => db.prepare(
  "SELECT * FROM collab_members WHERE collab_id = ? AND left_at IS NULL ORDER BY username",
).all(collabId);

const trackRows = (collabId) => db.prepare(
  "SELECT * FROM collab_tracks WHERE collab_id = ? ORDER BY position",
).all(collabId);

const isMember = (collabId, username) => Boolean(db.prepare(
  "SELECT 1 FROM collab_members WHERE collab_id = ? AND username = ? AND left_at IS NULL",
).get(collabId, username));

/** Start one, optionally from a playlist the creator already has. */
export async function createCollabPlaylist({
  owner,
  name,
  members = [],
  fromPlaylistId = "",
  deps = defaultSocialDeps,
} = {}) {
  const title = clean(name);
  if (!title) throw new SocialError("A collaborative playlist needs a name");
  const people = [...new Set(members.map((entry) => clean(entry, 100)).filter(Boolean))]
    .filter((entry) => entry !== owner);
  for (const person of people) {
    if (!knownUser(person)) throw new SocialError(`No Psalter user is called ${person}`);
    if (!sharesWith(owner, person)) {
      throw new SocialError(`You and ${person} are not in a congregation together`);
    }
  }

  let paths = [];
  if (fromPlaylistId) {
    const admin = deps.adminClient();
    if (!admin?.isConfigured?.()) throw new SocialError("Navidrome admin connection not configured", 503);
    const record = await admin.getPlaylistRecord(fromPlaylistId).catch(() => null);
    if (!record) throw new SocialError("No such playlist", 404);
    const ownerName = record.ownerName || record.owner;
    if (ownerName && ownerName !== owner) throw new SocialError("That playlist is not yours to share", 403);
    // A smart playlist is a rule, not a list: whoever holds the rule decides
    // what is in it, so there is nothing for anyone else to add or take out,
    // and the next evaluation would undo them if they tried. Its songs can
    // start one of these off, but the rule itself does not come along.
    if (record.rules || isTagPlaylist(owner, record.name)) {
      throw new SocialError(
        "A smart playlist keeps itself, so it cannot be built together. Share it instead, or start this from its songs as they are now.",
      );
    }
    const rows = await admin.getPlaylistTracks(fromPlaylistId);
    paths = rows
      .map((row) => normalizePath(row?.path ?? row?.mediaFile?.path ?? ""))
      .filter(Boolean);
  }

  const at = now();
  const id = db.transaction(() => {
    const collabId = db.prepare(
      "INSERT INTO collab_playlists (owner, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(owner, title, at, at).lastInsertRowid;
    const insertTrack = db.prepare(
      "INSERT OR IGNORE INTO collab_tracks (collab_id, position, path, added_by, added_at) VALUES (?, ?, ?, ?, ?)",
    );
    paths.forEach((path, index) => insertTrack.run(collabId, index, path, owner, at));
    const insertMember = db.prepare(
      "INSERT INTO collab_members (collab_id, username, joined_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    for (const person of [owner, ...people]) insertMember.run(collabId, person, at, at);
    return collabId;
  })();

  await syncCollabPlaylist(id, deps);
  return { id, name: title, members: [owner, ...people], songs: paths.length };
}

// Song ids differ per library, so reading a copy means turning them back into
// paths. Injectable for the same reason the rest of this is: so a test can say
// what Navidrome would have answered.
const defaultPathsForSongIds = (ids) =>
  mediaPathsForNavidromeSongIds(ids, { maxLookups: Number.POSITIVE_INFINITY });

/** What one member's copy holds now, as paths, or null when it cannot be read. */
async function readCopyPaths(client, copyPlaylistId, deps) {
  if (!copyPlaylistId) return null;
  const playlist = await client.getSubsonicPlaylist(copyPlaylistId).catch(() => null);
  if (!playlist) return null;
  const entries = Array.isArray(playlist.entry) ? playlist.entry : playlist.entry ? [playlist.entry] : [];
  const ids = entries.map((entry) => String(entry.id));
  const lookup = deps.pathsForSongIds || defaultPathsForSongIds;
  const paths = await lookup(ids);
  return ids.map((id) => normalizePath(paths.get(id) || "")).filter(Boolean);
}

/**
 * Fold in what everyone has done to their copy, then write every copy again.
 *
 * A copy that cannot be read is left out of the round rather than taken as
 * empty, and one that reads as empty when Psalter last wrote songs to it is
 * treated the same way: emptying a playlist for everybody is not something to
 * do on the strength of one odd read.
 */
export async function syncCollabPlaylist(id, deps = defaultSocialDeps) {
  const collab = collabRow(id);
  if (!collab) return { status: "missing" };
  const at = now();
  const members = memberRows(collab.id);
  let list = trackRows(collab.id).map((row) => row.path);
  const changes = [];
  // What each copy was actually holding this pass. Comparing the write against
  // this rather than against what was last written is what lets a copy that
  // has drifted - emptied, or edited in a way this pass declined to fold in -
  // be put back instead of left wrong.
  const observed = new Map();

  for (const member of members) {
    const client = deps.userClient(member.username);
    if (!client) continue;
    let current;
    try {
      current = await readCopyPaths(client, member.copy_playlist_id, deps);
    } catch (error) {
      db.prepare("UPDATE collab_members SET last_error = ?, updated_at = ? WHERE collab_id = ? AND username = ?")
        .run(error.message, at, collab.id, member.username);
      continue;
    }
    if (current === null) {
      // Their copy is gone. Deleting a playlist of yours is how anyone leaves.
      if (member.copy_playlist_id) {
        db.prepare("UPDATE collab_members SET left_at = ?, copy_playlist_id = NULL, updated_at = ? WHERE collab_id = ? AND username = ?")
          .run(at, at, collab.id, member.username);
        logger.info("library", `[Collab] ${member.username} deleted their copy of "${collab.name}" and has left it`);
      }
      continue;
    }
    const written = parse(member.last_paths_json, null);
    if (!Array.isArray(written)) continue;
    observed.set(member.username, current);
    if (!current.length && written.length) {
      logger.warn("library", `[Collab] ${member.username}'s copy of "${collab.name}" came back empty; leaving the list alone`);
      continue;
    }
    const before = new Set(written);
    const after = new Set(current);
    const added = current.filter((path) => !before.has(path));
    const removed = written.filter((path) => !after.has(path));
    if (added.length) {
      list = [...list.filter((path) => !added.includes(path)), ...added];
      changes.push(`${member.username} added ${added.length}`);
    }
    if (removed.length) {
      const gone = new Set(removed);
      list = list.filter((path) => !gone.has(path));
      changes.push(`${member.username} removed ${removed.length}`);
    }
    if (added.length) {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO collab_tracks (collab_id, position, path, added_by, added_at) VALUES (?, ?, ?, ?, ?)",
      );
      db.transaction(() => {
        for (const path of added) insert.run(collab.id, list.indexOf(path), path, member.username, at);
      })();
    }
    if (removed.length) {
      const remove = db.prepare("DELETE FROM collab_tracks WHERE collab_id = ? AND path = ?");
      db.transaction(() => {
        for (const path of removed) remove.run(collab.id, path);
      })();
    }
  }

  // Positions follow the list as it now reads, so everyone sees one order.
  db.transaction(() => {
    const position = db.prepare("UPDATE collab_tracks SET position = ? WHERE collab_id = ? AND path = ?");
    list.forEach((path, index) => position.run(index, collab.id, path));
  })();

  const written = [];
  for (const member of memberRows(collab.id)) {
    const client = deps.userClient(member.username);
    if (!client) continue;
    try {
      const copies = await resolveCopiesForUser({ username: member.username, paths: list, deps });
      const songIds = [];
      let missing = 0;
      for (const path of list) {
        const songId = copies.get(path);
        if (songId) songIds.push(songId);
        else missing += 1;
      }
      const theirs = list.filter((path) => copies.get(path));
      let copyId = member.copy_playlist_id;
      const seen = observed.get(member.username);
      const unchanged = copyId && (Array.isArray(seen)
        ? JSON.stringify(seen) === JSON.stringify(theirs)
        : JSON.stringify(songIds) === (member.last_song_ids_json || ""));
      if (!unchanged) {
        if (copyId) await client.updatePlaylist(copyId, { name: collab.name, songIds });
        else copyId = (await client.createPlaylist(collab.name, songIds))?.id || null;
      }
      db.prepare(`
        UPDATE collab_members SET copy_playlist_id = ?, last_song_ids_json = ?, last_paths_json = ?,
          missing_count = ?, last_error = NULL, updated_at = ? WHERE collab_id = ? AND username = ?
      `).run(copyId, JSON.stringify(songIds), JSON.stringify(theirs), missing, at, collab.id, member.username);
      written.push({ username: member.username, songs: songIds.length, missing, status: unchanged ? "unchanged" : "written" });
    } catch (error) {
      db.prepare("UPDATE collab_members SET last_error = ?, updated_at = ? WHERE collab_id = ? AND username = ?")
        .run(error.message, at, collab.id, member.username);
      written.push({ username: member.username, status: "failed", error: error.message });
    }
  }

  db.prepare("UPDATE collab_playlists SET updated_at = ? WHERE id = ?").run(at, collab.id);
  if (changes.length) logger.info("library", `[Collab] "${collab.name}": ${changes.join(", ")}`);
  return { status: "synced", songs: list.length, changes, members: written };
}

export async function syncAllCollabPlaylists(deps = defaultSocialDeps) {
  const rows = db.prepare("SELECT id FROM collab_playlists").all();
  for (const row of rows) {
    await syncCollabPlaylist(row.id, deps).catch((error) =>
      logger.warn("library", `[Collab] Sync of ${row.id} failed: ${error.message}`));
  }
  return { synced: rows.length };
}

/** The collaborative playlists one person is in. */
export function listCollabPlaylistsFor(username) {
  const rows = db.prepare(`
    SELECT collab.* FROM collab_playlists AS collab
    JOIN collab_members AS member ON member.collab_id = collab.id
    WHERE member.username = ? AND member.left_at IS NULL
    ORDER BY collab.updated_at DESC
  `).all(username);
  return rows.map((row) => {
    const mine = db.prepare("SELECT * FROM collab_members WHERE collab_id = ? AND username = ?")
      .get(row.id, username);
    return {
      id: row.id,
      name: row.name,
      owner: row.owner,
      isOwner: row.owner === username,
      members: memberRows(row.id).map((member) => member.username),
      songCount: db.prepare("SELECT COUNT(*) AS count FROM collab_tracks WHERE collab_id = ?").get(row.id).count,
      playlistId: mine?.copy_playlist_id || null,
      missing: mine?.missing_count || 0,
      error: mine?.last_error || null,
      updatedAt: row.updated_at,
    };
  });
}

export async function addCollabMember({ id, requester, username, deps = defaultSocialDeps } = {}) {
  const collab = collabRow(id);
  if (!collab) throw new SocialError("No such playlist", 404);
  if (!isMember(collab.id, requester)) throw new SocialError("That playlist is not yours", 403);
  const person = clean(username, 100);
  if (!knownUser(person)) throw new SocialError(`No Psalter user is called ${person}`);
  if (!sharesWith(requester, person)) {
    throw new SocialError(`You and ${person} are not in a congregation together`);
  }
  const at = now();
  db.prepare(`
    INSERT INTO collab_members (collab_id, username, joined_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (collab_id, username) DO UPDATE SET left_at = NULL, copy_playlist_id = NULL,
      last_song_ids_json = NULL, last_paths_json = NULL, updated_at = excluded.updated_at
  `).run(collab.id, person, at, at);
  await syncCollabPlaylist(collab.id, deps);
  return { added: person };
}

/**
 * Leave, or put someone out. Either way the copy stays in their account as
 * their own playlist: it is theirs, and it stops following the shared list.
 */
export function removeCollabMember({ id, requester, username } = {}) {
  const collab = collabRow(id);
  if (!collab) throw new SocialError("No such playlist", 404);
  const person = clean(username, 100) || requester;
  if (person !== requester && collab.owner !== requester) {
    throw new SocialError("Only the person who started it can put someone out", 403);
  }
  if (person === collab.owner && person !== requester) {
    throw new SocialError("The person who started it cannot be put out", 403);
  }
  db.prepare("UPDATE collab_members SET left_at = ?, updated_at = ? WHERE collab_id = ? AND username = ?")
    .run(now(), now(), collab.id, person);
  return { left: person };
}

/** Stop the whole thing. Everyone keeps the copy they have. */
export function deleteCollabPlaylist({ id, requester } = {}) {
  const collab = collabRow(id);
  if (!collab) throw new SocialError("No such playlist", 404);
  if (collab.owner !== requester) throw new SocialError("That playlist is not yours to end", 403);
  db.prepare("DELETE FROM collab_playlists WHERE id = ?").run(collab.id);
  db.prepare("DELETE FROM collab_members WHERE collab_id = ?").run(collab.id);
  db.prepare("DELETE FROM collab_tracks WHERE collab_id = ?").run(collab.id);
  return { ended: true };
}
