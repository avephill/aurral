import assert from "node:assert/strict";
import test from "node:test";

import {
  RESTORE_CLIENT_NAME,
  capturePlayCounts,
  pathsMovedByLidarr,
  replayPlayCounts,
} from "../../backend/services/libraryMoves.js";

// Moving files without anyone losing what they did with them: where each
// file went, and the plays a new id would otherwise forget.

const ROOT = "/data/Music/Library";

test("Lidarr's history says where each file went, within the library", () => {
  const moved = pathsMovedByLidarr([
    { eventType: "trackFileImported", data: { droppedPath: `${ROOT}/alt‐J/An Awesome Wave/04 - Breezeblocks.mp3`, importedPath: `${ROOT}/alt-J/An Awesome Wave (2012)/04 - Breezeblocks.mp3` } },
    // From a download folder: it had no path in the library before.
    { eventType: "trackFileImported", data: { droppedPath: "/torrents/Complete/x/01.flac", importedPath: `${ROOT}/X/Y/01.flac` } },
    { eventType: "trackFileRenamed", data: { sourcePath: `${ROOT}/R.E.M_/Eponymous/01.mp3`, path: `${ROOT}/R.E.M/Eponymous/01.mp3` } },
    // Moved twice: it ends where it ended.
    { eventType: "trackFileRenamed", data: { sourcePath: `${ROOT}/R.E.M/Eponymous/01.mp3`, path: `${ROOT}/R.E.M/Eponymous (1988)/01.mp3` } },
  ], { musicRoot: ROOT });
  assert.deepEqual([...moved], [
    ["alt‐J/An Awesome Wave/04 - Breezeblocks.mp3", "alt-J/An Awesome Wave (2012)/04 - Breezeblocks.mp3"],
    ["R.E.M_/Eponymous/01.mp3", "R.E.M/Eponymous (1988)/01.mp3"],
    ["R.E.M/Eponymous/01.mp3", "R.E.M/Eponymous (1988)/01.mp3"],
  ]);
});

// A Navidrome with one file in two libraries, before and after it moves.
function world({ quietable = true } = {}) {
  const songs = new Map([
    ["old-main", { id: "old-main", path: "A/Old/1.mp3", libraryId: 1 }],
    ["old-dad", { id: "old-dad", path: "A/Old/1.mp3", libraryId: 5 }],
  ]);
  const plays = new Map([["dunshill:old-dad", 7], ["dunshill:old-main", 0]]);
  const players = [];
  const sent = [];
  const admin = {
    findSongsByPath: async (p) => [...songs.values()].filter((song) => song.path === p),
    getPlayers: async () => players.map((player) => ({ ...player })),
    updatePlayer: async (player) => {
      if (!quietable) return;
      Object.assign(players.find((entry) => entry.id === player.id), { scrobbleEnabled: player.scrobbleEnabled });
    },
  };
  const clientFor = (username, clientName = "aurral") => ({
    request: async (method) => {
      if (method === "ping" && !players.some((p) => p.client === clientName && p.userName === username)) {
        players.push({ id: `pl-${players.length}`, client: clientName, userName: username, scrobbleEnabled: true });
      }
    },
    getSong: async (id) => ({ id, playCount: plays.get(`${username}:${id}`) || 0, played: "2024-05-01T10:00:00Z" }),
    scrobble: async (id, { time }) => {
      sent.push({ username, id, time, client: clientName });
      plays.set(`${username}:${id}`, (plays.get(`${username}:${id}`) || 0) + 1);
    },
  });
  const move = () => {
    for (const [id, song] of [...songs]) {
      songs.delete(id);
      songs.set(id.replace("old", "new"), { ...song, id: id.replace("old", "new"), path: "A/New/1.mp3" });
    }
  };
  return { admin, clientFor, move, sent, plays, players };
}

test("plays lost to a move are sent again, dated as they were, once", async () => {
  const w = world();
  const captured = await capturePlayCounts({
    admin: w.admin, clientFor: (u) => w.clientFor(u), usernames: ["dunshill"], paths: ["A/Old/1.mp3"],
  });
  assert.deepEqual(captured, [{ username: "dunshill", libraryId: 5, path: "A/Old/1.mp3", playCount: 7, played: Date.parse("2024-05-01T10:00:00Z") }]);

  w.move();
  const pathMap = new Map([["A/Old/1.mp3", "A/New/1.mp3"]]);
  const restoreClientFor = (u) => w.clientFor(u, RESTORE_CLIENT_NAME);
  const first = await replayPlayCounts({ admin: w.admin, restoreClientFor, captured, pathMap });
  assert.equal(first.sent, 7);
  assert.equal(w.plays.get("dunshill:new-dad"), 7, "onto the copy in the same library");
  assert.ok(w.sent.every((s) => s.client === RESTORE_CLIENT_NAME && s.time === Date.parse("2024-05-01T10:00:00Z")));
  assert.equal(w.players.find((p) => p.client === RESTORE_CLIENT_NAME).scrobbleEnabled, false, "never to Last.fm or ListenBrainz");

  const again = await replayPlayCounts({ admin: w.admin, restoreClientFor, captured, pathMap });
  assert.equal(again.sent, 0, "running it twice adds nothing");
});

test("nothing is sent unless the restore player is kept off Last.fm and ListenBrainz", async () => {
  const w = world({ quietable: false });
  const captured = await capturePlayCounts({
    admin: w.admin, clientFor: (u) => w.clientFor(u), usernames: ["dunshill"], paths: ["A/Old/1.mp3"],
  });
  w.move();
  await assert.rejects(
    () => replayPlayCounts({
      admin: w.admin,
      restoreClientFor: (u) => w.clientFor(u, RESTORE_CLIENT_NAME),
      captured,
      pathMap: new Map([["A/Old/1.mp3", "A/New/1.mp3"]]),
    }),
    /Could not stop dunshill's restore player/,
  );
  assert.equal(w.sent.length, 0);
});
