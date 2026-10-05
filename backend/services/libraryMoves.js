// Moving music files without anyone losing what they did with them.
//
// Navidrome gives a file a new id when its path changes, and ratings, play
// counts, favourites and playlist entries hang off that id. Library history
// puts ratings and playlists back by path once it knows where each file went;
// play counts it does not keep, so they are read beforehand and sent again
// afterwards as the plays they were.
//
// The order, for any change that moves files:
//
//   1. snapshot everyone who holds them (libraryHistoryService.takeSnapshot)
//      and capturePlayCounts for the files about to move;
//   2. move them (Lidarr's manual import or rename);
//   3. pathsMovedByLidarr since step 1 gives old path -> new;
//   4. once Navidrome has scanned and the playlist normaliser has run,
//      restoreSnapshot with that pathMap, and replayPlayCounts;
//   5. compareWithNow with the same pathMap should find nothing different.

import { normalizePath } from "./navidromePathMapping.js";

// A player of its own, with sending plays to Last.fm and ListenBrainz turned
// off: re-sent plays are old ones, already counted wherever they went.
export const RESTORE_CLIENT_NAME = "psalter-restore";

const relativeTo = (root, filePath) => {
  const base = `${String(root || "").replace(/\/+$/, "")}/`;
  const value = String(filePath || "");
  return value.startsWith(base) ? value.slice(base.length) : null;
};

/**
 * Where Lidarr moved files since a moment, from its history, as paths
 * relative to the main library: imports (droppedPath -> importedPath) and
 * renames (sourcePath -> path). Only moves within the library count; a file
 * imported from a download folder had no path here before.
 */
export function pathsMovedByLidarr(history, { musicRoot } = {}) {
  const moved = new Map();
  for (const event of Array.isArray(history) ? history : []) {
    const data = event?.data || {};
    const from = relativeTo(musicRoot, data.droppedPath || data.sourcePath);
    const to = relativeTo(musicRoot, data.importedPath || data.path);
    if (from && to && from !== to) moved.set(from, to);
  }
  // A file moved twice ends where it ended.
  for (const [from, to] of moved) {
    let end = to;
    const seen = new Set([from]);
    while (moved.has(end) && !seen.has(end)) {
      seen.add(end);
      end = moved.get(end);
    }
    moved.set(from, end);
  }
  return moved;
}

async function copiesOf(admin, songPath) {
  const songs = await admin.findSongsByPath(songPath);
  return songs.filter((song) => song?.id && normalizePath(song.path) === songPath);
}

/**
 * What each person has played of these files, copy by copy - every library a
 * file is in keeps its own count. Only what has been played is kept.
 */
export async function capturePlayCounts({ admin, clientFor, usernames, paths }) {
  const captured = [];
  for (const songPath of new Set(paths)) {
    const copies = await copiesOf(admin, songPath);
    for (const username of usernames) {
      const client = clientFor(username);
      for (const copy of copies) {
        const song = await client.getSong(copy.id).catch(() => null);
        const playCount = Number(song?.playCount) || 0;
        if (!playCount) continue;
        captured.push({
          username,
          libraryId: Number(copy.libraryId),
          path: songPath,
          playCount,
          played: song.played ? Date.parse(song.played) : null,
        });
      }
    }
  }
  return captured;
}

/**
 * Turn off sending plays to Last.fm and ListenBrainz for this person's restore
 * player, making it first if Navidrome has not seen it. Nothing is re-sent
 * unless that is confirmed.
 */
export async function quietRestorePlayer({ admin, client, username }) {
  await client.request("ping");
  const players = await admin.getPlayers();
  const player = players.find((entry) => entry.client === RESTORE_CLIENT_NAME
    && (entry.userName || entry.username) === username);
  if (!player) throw new Error(`Navidrome has no ${RESTORE_CLIENT_NAME} player for ${username}`);
  if (player.scrobbleEnabled !== false) await admin.updatePlayer({ ...player, scrobbleEnabled: false });
  const check = (await admin.getPlayers()).find((entry) => entry.id === player.id);
  if (check?.scrobbleEnabled !== false) {
    throw new Error(`Could not stop ${username}'s restore player sending plays to Last.fm and ListenBrainz`);
  }
}

/**
 * Send again what a move cost: for each copy that was played, as many plays
 * as its new copy is short, dated at its last play. Only the difference, so
 * running it twice adds nothing, and a count Navidrome carried across itself
 * is left alone.
 */
export async function replayPlayCounts({ admin, restoreClientFor, captured, pathMap = new Map() }) {
  const results = { sent: 0, copies: 0, unchanged: 0, notFound: [] };
  const quiet = new Set();
  for (const record of captured) {
    const nowPath = pathMap.get(record.path) || record.path;
    const copy = (await copiesOf(admin, nowPath)).find((song) => Number(song.libraryId) === record.libraryId);
    if (!copy) {
      results.notFound.push(`${record.username}: ${nowPath}`);
      continue;
    }
    const client = restoreClientFor(record.username);
    const current = Number((await client.getSong(copy.id))?.playCount) || 0;
    const missing = record.playCount - current;
    if (missing <= 0) {
      results.unchanged += 1;
      continue;
    }
    if (!quiet.has(record.username)) {
      await quietRestorePlayer({ admin, client, username: record.username });
      quiet.add(record.username);
    }
    for (let play = 0; play < missing; play += 1) {
      await client.scrobble(copy.id, { time: record.played || Date.now(), submission: true });
    }
    results.sent += missing;
    results.copies += 1;
  }
  return results;
}
