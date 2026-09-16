import { db } from "../config/db-sqlite.js";
import { isNavidromeUserAuthEnabled } from "../config/featureFlags.js";
import { createNavidromeUserClient } from "./navidromeUserClient.js";
import { getPersonalLibraryIdForUser } from "./navidromeTrackResolver.js";
import { logger } from "./logger.js";

/**
 * Which music belongs to one person, as Navidrome sees it.
 *
 * Every personal library here is a symlinked subset of the one shared library,
 * and Navidrome decides what each person can play. Psalter's own index knows
 * none of that - it holds everything on disk - so browsing showed Avery's dad
 * music that is not his. This asks Navidrome, as that person, which artists
 * and albums their library holds, and matches them to the canonical index by
 * name.
 *
 * Names rather than ids because the two systems identify things differently;
 * an occasional near-miss shows a record in the wrong half of a search, which
 * is a smaller price than a listener browsing a library that is not theirs.
 */

const FRESH_MS = 15 * 60 * 1000;
const PAGE_SIZE = 500;
const MAX_PAGES = 60;

const entries = new Map();
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

export const normalizeName = (value) => String(value || "")
  .normalize("NFKD")
  .replace(/[̀-ͯ]/g, "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const albumKey = (artist, album) => `${normalizeName(artist)}|${normalizeName(album)}`;

async function readScope(username) {
  const client = createNavidromeUserClient({ username });
  if (!client) return null;
  const libraryId = await getPersonalLibraryIdForUser(username).catch(() => null);
  // No personal library of their own: everything they can see is the shared
  // library, and there is nothing to narrow.
  if (libraryId === null || libraryId === undefined) return null;

  const startedAt = Date.now();
  const artists = new Set();
  const albums = new Set();
  const folder = { musicFolderId: libraryId };

  const index = await client.request("getArtists", folder);
  for (const group of asArray(index?.artists?.index)) {
    for (const artist of asArray(group?.artist)) {
      if (artist?.name) artists.add(normalizeName(artist.name));
    }
  }

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await client.request("getAlbumList2", {
      type: "alphabeticalByName",
      size: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      ...folder,
    });
    const list = asArray(data?.albumList2?.album);
    for (const album of list) {
      if (album?.name) albums.add(albumKey(album.artist, album.name));
      if (album?.artist) artists.add(normalizeName(album.artist));
    }
    if (list.length < PAGE_SIZE) break;
  }

  logger.info(
    "library",
    `[Scope] ${username}: ${artists.size} artist(s), ${albums.size} album(s) in library ${libraryId} (${Date.now() - startedAt}ms)`,
  );
  return { libraryId, artists, albums, loadedAt: Date.now(), canonical: null };
}

function refresh(username) {
  const entry = entries.get(username) || {};
  if (entry.pending) return entry.pending;
  const pending = readScope(username)
    .then((scope) => {
      entries.set(username, { scope, loadedAt: Date.now(), pending: null });
      return scope;
    })
    .catch((error) => {
      const current = entries.get(username);
      if (current) current.pending = null;
      logger.warn("library", `[Scope] Could not read ${username}'s library: ${error.message}`);
      throw error;
    });
  entries.set(username, { ...entry, pending });
  return pending;
}

/**
 * The person's own library, or null when they have none of their own (and so
 * see the whole shared library). A stale answer is served while a fresh one
 * loads, so only the first read waits on Navidrome.
 */
export async function getUserLibraryScope(user) {
  const username = String(user?.username || "").trim();
  if (!username || !isNavidromeUserAuthEnabled()) return null;
  const entry = entries.get(username);
  if (entry && "scope" in entry) {
    if (Date.now() - entry.loadedAt >= FRESH_MS) {
      refresh(username).catch(() => {});
    }
    return entry.scope;
  }
  try {
    return await refresh(username);
  } catch {
    return null;
  }
}

/** Whether one thing is in that person's library. Unknown scope means yes. */
export function isInScope(scope, { artistName = "", albumTitle = "" } = {}) {
  if (!scope) return true;
  if (albumTitle && scope.albums.has(albumKey(artistName, albumTitle))) return true;
  if (artistName && scope.artists.has(normalizeName(artistName))) return true;
  return false;
}

/**
 * The canonical artists and albums that person's library covers, for the
 * library pages. Worked out once per scope read and kept with it.
 */
export async function getCanonicalScope(user) {
  const scope = await getUserLibraryScope(user);
  if (!scope) return null;
  if (scope.canonical) return scope.canonical;

  const artistIds = new Set();
  for (const row of db.prepare("SELECT id, name FROM library_artists").all()) {
    if (scope.artists.has(normalizeName(row.name))) artistIds.add(row.id);
  }
  const albumIds = new Set();
  for (const row of db.prepare(`
    SELECT album.id AS id, album.artist_id AS artistId, album.title AS title,
           COALESCE(album.album_artist, artist.name) AS artistName
    FROM library_albums AS album
    LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
  `).all()) {
    // Either the record itself is in their library, or its artist is: a
    // personal library holds whole artists as often as single albums.
    if (scope.albums.has(albumKey(row.artistName, row.title)) || artistIds.has(row.artistId)) {
      albumIds.add(row.id);
    }
  }
  scope.canonical = { artistIds, albumIds };
  logger.info(
    "library",
    `[Scope] ${user.username}: ${artistIds.size} canonical artist(s), ${albumIds.size} album(s) matched`,
  );
  return scope.canonical;
}

export function resetUserLibraryScope() {
  entries.clear();
}
