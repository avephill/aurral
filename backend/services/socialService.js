import { db } from "../config/db-sqlite.js";
import { createNavidromeUserClient } from "./navidromeUserClient.js";
import { normalizePath } from "./navidromePathMapping.js";
import { getAdminNavidromeClient, getPersonalLibraryIdForUser } from "./navidromeTrackResolver.js";
import { logger } from "./logger.js";

/**
 * The social side of Psalter: playlists shared with one person, albums and
 * songs people point each other at, and what everyone has been playing.
 *
 * Navidrome has no per-user sharing - a playlist is private to its owner or
 * public to the whole server - so a shared playlist is written a second time
 * into the recipient's own account and kept in step. They own their copy, so
 * only they can see it, and it behaves like any other playlist in any client.
 *
 * A copy is resolved against the songs the recipient can actually reach:
 * personal libraries are deliberate subsets here, and a share must not hand
 * someone music their library does not hold. Songs left out are counted and
 * shown rather than silently dropped.
 */

const LIBRARY_CACHE_MS = 10 * 60 * 1000;
const MAX_NOTE = 500;

const now = () => Date.now();
const clean = (value, limit = 200) => String(value ?? "").trim().slice(0, limit);
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

export class SocialError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "SocialError";
    this.status = status;
  }
}

/** Everyone with an account here, so a person can choose who to share with. */
export function listPeople({ exclude = null } = {}) {
  return db.prepare("SELECT username FROM users ORDER BY username")
    .all()
    .map((row) => row.username)
    .filter((username) => username !== exclude);
}

const knownUser = (username) => Boolean(db.prepare("SELECT 1 FROM users WHERE username = ?").get(username));

export function getSocialSettings(username) {
  const row = db.prepare("SELECT share_listening AS shareListening FROM social_settings WHERE username = ?").get(username);
  return { username, shareListening: row ? Boolean(row.shareListening) : true };
}

export function setShareListening(username, shareListening) {
  db.prepare(`
    INSERT INTO social_settings (username, share_listening, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (username) DO UPDATE SET share_listening = excluded.share_listening, updated_at = excluded.updated_at
  `).run(username, shareListening ? 1 : 0, now());
  return getSocialSettings(username);
}

// ---------------------------------------------------------------- shares

const defaultDeps = {
  adminClient: () => getAdminNavidromeClient(),
  userClient: (username) => createNavidromeUserClient({ username }),
  personalLibraryId: (username) => getPersonalLibraryIdForUser(username),
  songsByPath: (path) => getAdminNavidromeClient().findSongsByPath(path),
};

const libraryCache = new Map();

/**
 * The Navidrome libraries one person can reach. An empty set means we could
 * not find out, and the share is then left to the resolver's own preference
 * rather than filtered on a guess.
 */
async function librariesFor(username, deps) {
  const cached = libraryCache.get(username);
  if (cached && now() - cached.at < LIBRARY_CACHE_MS) return cached.ids;
  const admin = deps.adminClient();
  let ids = new Set();
  try {
    const users = await admin.getUsers();
    const found = (Array.isArray(users) ? users : []).find((user) => user?.userName === username || user?.username === username);
    if (found?.id) {
      const libraries = await admin.getUserLibraries(found.id);
      ids = new Set((Array.isArray(libraries) ? libraries : []).map((library) => Number(library?.id ?? library)).filter(Number.isFinite));
    }
  } catch (error) {
    logger.warn("library", `[Social] Could not read ${username}'s libraries: ${error.message}`);
  }
  libraryCache.set(username, { ids, at: now() });
  return ids;
}

export function resetSocialCaches() {
  libraryCache.clear();
}

/** Share one of your playlists with people, and write their copies now. */
export async function sharePlaylist({ owner, playlistId, recipients = [], deps = defaultDeps } = {}) {
  const id = clean(playlistId);
  if (!id) throw new SocialError("playlistId is required");
  const admin = deps.adminClient();
  if (!admin?.isConfigured?.()) throw new SocialError("Navidrome admin connection not configured", 503);

  const record = await admin.getPlaylistRecord(id).catch(() => null);
  if (!record) throw new SocialError("No such playlist", 404);
  const ownerName = record.ownerName || record.owner;
  if (ownerName && ownerName !== owner) throw new SocialError("That playlist is not yours to share", 403);

  const wanted = [...new Set(recipients.map((name) => clean(name, 100)).filter(Boolean))]
    .filter((name) => name !== owner);
  if (!wanted.length) throw new SocialError("Choose at least one person");
  for (const recipient of wanted) {
    if (!knownUser(recipient)) throw new SocialError(`No Psalter user is called ${recipient}`);
  }

  const at = now();
  const name = clean(record.name || "Playlist");
  const results = [];
  for (const recipient of wanted) {
    db.prepare(`
      INSERT INTO playlist_shares (owner, recipient, source_playlist_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_playlist_id, recipient) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `).run(owner, recipient, id, name, at, at);
    const share = db.prepare("SELECT * FROM playlist_shares WHERE source_playlist_id = ? AND recipient = ?").get(id, recipient);
    results.push(await syncShare(share, deps));
  }
  return { playlistId: id, name, shared: results };
}

/**
 * Write one share's copy, or leave it alone when it already matches.
 *
 * The recipient's copy of each file is found through Navidrome by path rather
 * than through Psalter's own index: the index holds what Lidarr manages and
 * what a scan has seen, and a playlist can hold music it has never indexed -
 * 45 songs of one real Christmas playlist - which would otherwise vanish from
 * the copy without anyone noticing.
 */
export async function syncShare(share, deps = defaultDeps) {
  const at = now();
  try {
    const admin = deps.adminClient();
    const rows = await admin.getPlaylistTracks(share.source_playlist_id);
    const entries = rows
      .map((row) => ({
        songId: String(row?.mediaFileId ?? row?.mediaFile?.id ?? ""),
        path: normalizePath(row?.path ?? row?.mediaFile?.path ?? ""),
      }))
      .filter((entry) => entry.path);

    const preferLibraryId = await deps.personalLibraryId(share.recipient).catch(() => null);
    const allowed = await librariesFor(share.recipient, deps);

    // One lookup per distinct file, not per entry: a playlist often repeats one.
    const theirCopy = new Map();
    for (const entry of entries) {
      if (theirCopy.has(entry.path)) continue;
      const copies = await deps.songsByPath(entry.path).catch(() => []);
      const exact = (Array.isArray(copies) ? copies : [])
        .filter((song) => song?.id && normalizePath(song?.path) === entry.path);
      const pick = exact.find((song) => Number(song.libraryId) === Number(preferLibraryId))
        || exact.find((song) => allowed.size && allowed.has(Number(song.libraryId)))
        // Their libraries are unknown, so leave the copy the owner had rather
        // than guess at one they may not be able to play.
        || (allowed.size ? null : exact.find((song) => String(song.id) === entry.songId));
      theirCopy.set(entry.path, pick?.id ? String(pick.id) : null);
    }

    const mirrorSongIds = [];
    let missing = 0;
    for (const entry of entries) {
      const songId = theirCopy.get(entry.path);
      if (songId) mirrorSongIds.push(songId);
      else missing += 1;
    }

    const client = deps.userClient(share.recipient);
    if (!client) throw new SocialError("Navidrome is not configured", 503);
    const name = `${share.name} (from ${share.owner})`;
    let mirrorId = share.mirror_playlist_id;
    if (mirrorId && !await client.getSubsonicPlaylist(mirrorId).catch(() => null)) mirrorId = null;

    const unchanged = mirrorId && JSON.stringify(mirrorSongIds) === (share.last_song_ids_json || "");
    if (!unchanged) {
      if (mirrorId) await client.updatePlaylist(mirrorId, { name, songIds: mirrorSongIds });
      else mirrorId = (await client.createPlaylist(name, mirrorSongIds))?.id || null;
    }

    db.prepare(`
      UPDATE playlist_shares SET mirror_playlist_id = ?, last_song_ids_json = ?, missing_count = ?,
        last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
    `).run(mirrorId, JSON.stringify(mirrorSongIds), missing, at, at, share.id);
    return {
      recipient: share.recipient,
      songs: mirrorSongIds.length,
      missing,
      status: unchanged ? "unchanged" : "written",
    };
  } catch (error) {
    db.prepare("UPDATE playlist_shares SET last_error = ?, updated_at = ? WHERE id = ?").run(error.message, at, share.id);
    logger.warn("library", `[Social] Share of "${share.name}" to ${share.recipient} failed: ${error.message}`);
    return { recipient: share.recipient, status: "failed", error: error.message };
  }
}

/** Keep every share in step; cheap, because an unchanged copy is not written. */
export async function syncAllShares(deps = defaultDeps) {
  const shares = db.prepare("SELECT * FROM playlist_shares").all();
  const counts = {};
  for (const share of shares) {
    const { status } = await syncShare(share, deps);
    counts[status] = (counts[status] || 0) + 1;
  }
  if (shares.length) logger.info("library", `[Social] Synced ${shares.length} shared playlist(s): ${JSON.stringify(counts)}`);
  return counts;
}

export function listSharesForRecipient(username) {
  return db.prepare(`
    SELECT id, owner, name, mirror_playlist_id AS playlistId, missing_count AS missing,
           last_synced_at AS syncedAt, last_error AS error, last_song_ids_json AS songIds
    FROM playlist_shares WHERE recipient = ? ORDER BY updated_at DESC
  `).all(username).map((row) => ({
    ...row,
    songIds: undefined,
    songCount: parse(row.songIds, []).length,
  }));
}

export function listSharesByOwner(username) {
  return db.prepare(`
    SELECT id, recipient, name, source_playlist_id AS sourcePlaylistId, missing_count AS missing,
           last_synced_at AS syncedAt, last_error AS error
    FROM playlist_shares WHERE owner = ? ORDER BY updated_at DESC
  `).all(username);
}

/**
 * Stop sharing. The recipient's copy is theirs, so it is left in place unless
 * the person who shared it asks for it to go.
 */
export async function removeShare({ id, requester, deleteCopy = false, deps = defaultDeps } = {}) {
  const share = db.prepare("SELECT * FROM playlist_shares WHERE id = ?").get(Number(id));
  if (!share) throw new SocialError("No such share", 404);
  if (share.owner !== requester && share.recipient !== requester) {
    throw new SocialError("That share is not yours", 403);
  }
  if (deleteCopy && share.mirror_playlist_id) {
    const client = deps.userClient(share.recipient);
    await client?.deletePlaylist(share.mirror_playlist_id).catch(() => {});
  }
  db.prepare("DELETE FROM playlist_shares WHERE id = ?").run(share.id);
  return { removed: true, copyDeleted: Boolean(deleteCopy && share.mirror_playlist_id) };
}

// ---------------------------------------------------------------- recommendations

/** What a recommendation points at, and proof it is really on the server. */
function describeTarget(kind, targetId) {
  if (kind === "album") {
    const row = db.prepare(`
      SELECT album.title AS title, COALESCE(album.album_artist, artist.name) AS subtitle
      FROM library_albums AS album LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
      WHERE album.id = ?
    `).get(Number(targetId));
    if (!row) throw new SocialError("That album is not in the library");
    return row;
  }
  if (kind === "track") {
    const row = db.prepare("SELECT title, artist_name AS subtitle FROM library_tracks WHERE id = ?").get(Number(targetId));
    if (!row) throw new SocialError("That song is not in the library");
    return row;
  }
  if (kind === "playlist") return { title: null, subtitle: null };
  throw new SocialError("A recommendation is for an album, a song or a playlist");
}

/** Point people at something. With no recipients it is meant for everyone. */
export function createRecommendation({ sender, kind, targetId, note = "", recipients = [] } = {}) {
  const type = clean(kind, 20);
  const target = clean(targetId, 100);
  if (!target) throw new SocialError("targetId is required");
  const described = describeTarget(type, target);
  const people = [...new Set(recipients.map((name) => clean(name, 100)).filter(Boolean))].filter((name) => name !== sender);
  for (const person of people) {
    if (!knownUser(person)) throw new SocialError(`No Psalter user is called ${person}`);
  }
  const at = now();
  const insert = db.prepare(`
    INSERT INTO recommendations (sender, recipient, kind, target_id, title, subtitle, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rows = people.length ? people : [null];
  const ids = db.transaction(() => rows.map((recipient) => insert.run(
    sender, recipient, type, target, described.title, described.subtitle, clean(note, MAX_NOTE) || null, at,
  ).lastInsertRowid))();
  return { sent: ids.length, toEveryone: !people.length, ids };
}

const recommendationView = (row) => ({
  id: row.id,
  sender: row.sender,
  recipient: row.recipient,
  toEveryone: row.recipient === null,
  kind: row.kind,
  targetId: row.target_id,
  title: row.title,
  subtitle: row.subtitle,
  note: row.note,
  createdAt: row.created_at,
  readAt: row.read_at,
});

/** What is waiting for one person: theirs by name, plus anything for everyone. */
export function listRecommendationsFor(username, { limit = 50 } = {}) {
  const inbox = db.prepare(`
    SELECT * FROM recommendations
    WHERE (recipient = ? OR (recipient IS NULL AND sender != ?)) AND dismissed_at IS NULL
    ORDER BY created_at DESC LIMIT ?
  `).all(username, username, limit).map(recommendationView);
  const sent = db.prepare(`
    SELECT * FROM recommendations WHERE sender = ? ORDER BY created_at DESC LIMIT ?
  `).all(username, limit).map(recommendationView);
  return { inbox, sent, unread: inbox.filter((entry) => !entry.readAt).length };
}

export function markRecommendationsRead(username) {
  const at = now();
  return db.prepare(`
    UPDATE recommendations SET read_at = ?
    WHERE read_at IS NULL AND dismissed_at IS NULL AND (recipient = ? OR recipient IS NULL)
  `).run(at, username).changes;
}

export function dismissRecommendation({ id, requester } = {}) {
  const row = db.prepare("SELECT * FROM recommendations WHERE id = ?").get(Number(id));
  if (!row) throw new SocialError("No such recommendation", 404);
  if (row.recipient !== requester && row.sender !== requester && row.recipient !== null) {
    throw new SocialError("That recommendation is not yours", 403);
  }
  db.prepare("UPDATE recommendations SET dismissed_at = ? WHERE id = ?").run(now(), row.id);
  return { dismissed: true };
}

// ---------------------------------------------------------------- listening

const albumView = (album) => ({
  id: String(album?.id ?? ""),
  name: album?.name || album?.album || "",
  artist: album?.artist || "",
  year: Number(album?.year) || null,
  playCount: Number(album?.playCount) || 0,
});

/**
 * What people have been playing, for anyone who lets it be shown. Read from
 * Navidrome as each person, so it is their own listening and nobody else's.
 */
export async function getListeningHighlights({ deps = defaultDeps, people = null } = {}) {
  const usernames = people || listPeople();
  const entries = [];
  for (const username of usernames) {
    if (!getSocialSettings(username).shareListening) continue;
    const client = deps.userClient(username);
    if (!client) continue;
    const albums = async (type) => {
      const data = await client.request("getAlbumList2", { type, size: 6 }).catch(() => null);
      const list = data?.albumList2?.album;
      return (Array.isArray(list) ? list : list ? [list] : []).map(albumView);
    };
    const [recent, frequent] = await Promise.all([albums("recent"), albums("frequent")]);
    if (recent.length || frequent.length) entries.push({ username, recent, frequent });
  }
  return { people: entries };
}

let syncTimer = null;

/** Keep shared copies in step in the background. */
export function startSocialSync({ intervalMs = 15 * 60 * 1000 } = {}) {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    syncAllShares().catch((error) => logger.warn("library", `[Social] Share sync failed: ${error.message}`));
  }, intervalMs);
  syncTimer.unref?.();
}

export function stopSocialSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}
