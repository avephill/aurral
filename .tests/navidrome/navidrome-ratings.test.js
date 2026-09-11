import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

process.env.AURRAL_NAVIDROME_USER_AUTH = "reverse-proxy";
process.env.AURRAL_NAVIDROME_USER_HEADER = "X-Authentik-Username";

const [isolatedState, { db }, { dbOps, userOps }, libraryStore, annotations, resolver, stars, songIdStore] =
  await setupIsolatedBackend(
    "navidrome-ratings",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/libraryMediaStore.js",
    "backend/services/navidromeAnnotations.js",
    "backend/services/navidromeTrackResolver.js",
    "backend/services/subsonicLibraryService.js",
    "backend/services/navidromeSongIdStore.js",
  );

const RELATIVE = "Jethro Tull/Stand Up/01 A New Day Yesterday.flac";
const AURRAL_PATH = `/data/Music/Library/${RELATIVE}`;

const subsonicOk = (payload = {}) =>
  JSON.stringify({ "subsonic-response": { status: "ok", version: "1.16.1", ...payload } });
const subsonicFail = (code, message) =>
  JSON.stringify({ "subsonic-response": { status: "failed", version: "1.16.1", error: { code, message } } });

// One fake Navidrome: the native API for the admin (login + real paths) and
// the Subsonic API for the user, which only answers when the trusted header
// names the user.
function createFakeNavidrome() {
  const state = { ratings: {}, starred: new Set(), requests: [] };
  const handler = (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    state.requests.push({ method: req.method, path: url.pathname, params: url.searchParams, headers: req.headers });
    const reply = (body, status = 200, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };
    if (url.pathname === "/auth/login") return reply(JSON.stringify({ token: "admin-token" }));
    if (url.pathname === "/api/library") return reply(JSON.stringify([{ id: 1, name: "Music", path: "/music" }]));
    if (url.pathname.startsWith("/api/song/")) {
      const wantedId = url.pathname.slice("/api/song/".length);
      if (wantedId !== "nd-1") return reply(JSON.stringify({ error: "not found" }), 404);
      return reply(JSON.stringify({ id: "nd-1", title: "A New Day Yesterday", path: RELATIVE, libraryId: 1 }));
    }
    if (url.pathname === "/api/song") {
      const song = { id: "nd-1", title: "A New Day Yesterday", path: RELATIVE, libraryId: 1, albumId: "al-1" };
      // Several songs in one read, by id, is how playlists and stars resolve.
      const ids = url.searchParams.getAll("id");
      if (ids.length) return reply(JSON.stringify(ids.includes("nd-1") ? [song] : []));
      const wanted = url.searchParams.get("title") || url.searchParams.get("path");
      const matches = wanted && (RELATIVE.startsWith(wanted) || song.title.toLowerCase().includes(wanted.toLowerCase()));
      return reply(JSON.stringify(matches ? [song] : []));
    }
    if (url.pathname.startsWith("/rest/")) {
      const user = req.headers["x-authentik-username"];
      if (!user) return reply(subsonicFail(40, "Wrong username or password"));
      const id = url.searchParams.get("id");
      switch (url.pathname) {
        case "/rest/ping":
          return reply(subsonicOk());
        case "/rest/getSong":
          if (id !== "nd-1") return reply(subsonicFail(70, "Song not found"));
          return reply(subsonicOk({
            song: {
              id,
              title: "A New Day Yesterday",
              albumId: "al-1",
              artistId: "ar-1",
              userRating: state.ratings[`${user}:${id}`] || 0,
              starred: state.starred.has(`${user}:${id}`) ? "2026-09-09T00:00:00Z" : undefined,
            },
          }));
        case "/rest/setRating": {
          const rating = Number(url.searchParams.get("rating"));
          if (rating === 0) delete state.ratings[`${user}:${id}`];
          else state.ratings[`${user}:${id}`] = rating;
          return reply(subsonicOk());
        }
        case "/rest/star":
          state.starred.add(`${user}:${id}`);
          return reply(subsonicOk());
        case "/rest/getStarred2":
          return reply(subsonicOk({
            starred2: {
              song: [...state.starred]
                .filter((entry) => entry.startsWith(`${user}:`))
                .map((entry) => ({
                  id: entry.slice(user.length + 1),
                  title: "A New Day Yesterday",
                  // Subsonic hands out a made-up path, as Navidrome does.
                  path: "Jethro Tull/Stand Up/A New Day Yesterday.flac",
                })),
            },
          }));
        case "/rest/unstar":
          state.starred.delete(`${user}:${id}`);
          return reply(subsonicOk());
        default:
          return reply(subsonicFail(0, `unhandled ${url.pathname}`));
      }
    }
    return reply("not found", 404, "text/plain");
  };
  return { state, handler };
}

let server;
let fake;
let user;
let track;
let album;

test.before(async () => {
  resetDatabase(db);
  fake = createFakeNavidrome();
  server = await createMockHttpServer(fake.handler);
  dbOps.updateSettings({
    integrations: { navidrome: { url: server.url, username: "avery", password: "admin-secret" } },
  });
  user = userOps.getUserById(userOps.createUser("dunshill", "hash").id);

  const artist = libraryStore.upsertLibraryArtist({ identityKey: "jethro-tull", name: "Jethro Tull", metadata: {} });
  album = libraryStore.upsertLibraryAlbum({ identityKey: "stand-up", artistId: artist.id, title: "Stand Up", albumArtist: artist.name });
  track = libraryStore.upsertLibraryTrack({ identityKey: "a-new-day-yesterday", title: "A New Day Yesterday", artistName: artist.name });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "lidarr",
    path: AURRAL_PATH,
    format: "flac",
    available: true,
  });
  resolver.resetNavidromeTrackResolver();
});

test.after(async () => {
  await server?.close();
  await cleanupIsolatedState(isolatedState);
});

test("ratings are read as the user through the trusted header", async () => {
  fake.state.ratings["dunshill:nd-1"] = 4;
  const result = await annotations.lookupTrackAnnotations(user, [
    { trackId: track.id, albumId: album.id },
    { trackId: 999999, albumId: null },
  ]);
  assert.equal(result.enabled, true);
  assert.equal(result.connected, true);
  assert.deepEqual(result.tracks[String(track.id)], {
    known: true,
    songId: "nd-1",
    rating: 4,
    starred: false,
    navidromeAlbumId: "al-1",
    navidromeArtistId: "ar-1",
  });
  assert.equal(result.tracks["999999"].known, false);

  const userCalls = fake.state.requests.filter((request) => request.path === "/rest/getSong");
  assert.ok(userCalls.length >= 1);
  for (const call of userCalls) {
    assert.equal(call.headers["x-authentik-username"], "dunshill");
    assert.equal(call.params.get("t"), null, "no password token on user calls");
  }
  const adminCalls = fake.state.requests.filter((request) => request.path.startsWith("/api/"));
  assert.ok(adminCalls.length >= 1, "path lookups go through the admin native API");
  for (const call of adminCalls) assert.equal(call.headers["x-nd-authorization"], "Bearer admin-token");
});

test("setting and clearing a rating writes to Navidrome for that user only", async () => {
  const saved = await annotations.setTrackRating(user, { trackId: track.id, albumId: album.id }, 5);
  assert.equal(saved.rating, 5);
  assert.equal(fake.state.ratings["dunshill:nd-1"], 5);
  assert.equal(fake.state.ratings["avery:nd-1"], undefined);

  const cleared = await annotations.setTrackRating(user, { trackId: track.id, albumId: album.id }, 0);
  assert.equal(cleared.rating, 0);
  assert.equal(fake.state.ratings["dunshill:nd-1"], undefined);

  await assert.rejects(
    () => annotations.setTrackRating(user, { trackId: 424242 }, 3),
    (error) => error.status === 404,
  );
});

test("a heart in Aurral becomes a star in Navidrome, and unhearting removes it", async () => {
  const favoriteId = `song:${encodeURIComponent("a-new-day-yesterday")}`;
  assert.deepEqual(await annotations.mirrorFavoritesToNavidrome(user, [favoriteId], true), { mirrored: 1 });
  assert.ok(fake.state.starred.has("dunshill:nd-1"));
  assert.deepEqual(await annotations.mirrorFavoritesToNavidrome(user, [favoriteId], false), { mirrored: 1 });
  assert.ok(!fake.state.starred.has("dunshill:nd-1"));
  // Artists are not mirrored; unknown ids are skipped quietly.
  assert.deepEqual(await annotations.mirrorFavoritesToNavidrome(user, ["artist:x", "song:nope"], true), { mirrored: 0 });
});

test("an untrusted header is reported as not connected rather than as empty ratings", async () => {
  const stranger = userOps.getUserById(userOps.createUser("", "hash")?.id) || { id: 0, username: "" };
  const result = await annotations.lookupTrackAnnotations(stranger, [{ trackId: track.id, albumId: album.id }]);
  // No username means no client at all.
  assert.equal(result.connected, false);
});

test("stars set in Navidrome come back as Aurral favourites", async () => {
  resolver.resetNavidromeTrackResolver();
  fake.state.starred.add("dunshill:nd-1");

  const result = await annotations.importStarsFromNavidrome(user);
  assert.equal(result.connected, true);
  assert.equal(result.starred, 1);
  assert.equal(result.imported, 1);

  const favourites = stars.getStarredIdentityKeys(user);
  assert.ok(favourites.has("song:a-new-day-yesterday"));

  // Running it again changes nothing and does not double up.
  const second = await annotations.importStarsFromNavidrome(user);
  assert.equal(second.imported, 0);
  assert.equal(stars.getStarredIdentityKeys(user).size, favourites.size);
});

test("a star on a song this server does not hold is skipped quietly", async () => {
  resolver.resetNavidromeTrackResolver();
  fake.state.starred.add("dunshill:nd-unknown");
  const result = await annotations.importStarsFromNavidrome(user);
  assert.equal(result.connected, true);
  assert.equal(result.matched, 1, "only the song we hold matched");
});

test("with nothing remembered, stars are matched by reading the songs themselves", () => {
  // The store is what makes a repeat pass cheap; this is the first pass.
  songIdStore.clearNavidromeSongIds();
  resolver.resetNavidromeTrackResolver();
  return annotations.importStarsFromNavidrome(user).then((result) => {
    assert.equal(result.connected, true);
    assert.equal(result.matched, 1);
    assert.ok(songIdStore.countNavidromeSongIds() >= 1, "and the answer is kept for next time");
  });
});
