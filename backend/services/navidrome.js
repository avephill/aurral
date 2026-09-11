import axios from "../../lib/axiosFetch.js";
import crypto from "crypto";
import { logger } from "./logger.js";

const LEGACY_LIBRARY_DIR = "aurral-weekly-flow";
const PLAYLIST_LIBRARY_NAME = "Aurral Playlists";
const LEGACY_LIBRARY_NAMES = new Set(["Aurral Weekly Flow"]);
const PLAYLIST_SONG_BATCH_SIZE = 50;
const NAVIDROME_SONG_PAGE_SIZE = 1_000;
const NAVIDROME_PLAYLIST_TRACK_PAGE_SIZE = 1_000;
const NAVIDROME_PLAYLIST_WRITE_CHUNK = 500;
const NAVIDROME_RATE_LIMIT_RETRIES = 2;
const NAVIDROME_RATE_LIMIT_DELAY_MS = 250;
const NAVIDROME_RATE_LIMIT_MAX_DELAY_MS = 5_000;
const NAVIDROME_NETWORK_RETRIES = 2;
const NAVIDROME_RETRYABLE_READ_ENDPOINTS = new Set([
  "ping",
  "search3",
  "getPlaylists",
  "getPlaylist",
]);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeLibraryPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function isLegacyPlaylistLibraryPath(value) {
  const libraryPath = normalizeLibraryPath(value);
  return libraryPath.endsWith(`/${LEGACY_LIBRARY_DIR}`) || libraryPath === LEGACY_LIBRARY_DIR;
}

export class NavidromeClient {
  constructor(url, user, password) {
    this.url = url ? url.replace(/\/+$/, "") : null;
    this.user = user;
    this.password = password;
    this._libraryPaths = [];
    this._nativeTokenPromise = null;
    this._indexedSongsPromise = null;
  }

  isConfigured() {
    return !!(this.url && this.user && this.password);
  }

  // Extra headers for every Subsonic request. The per-user client uses this
  // to carry the trusted username header instead of a password.
  getRequestHeaders() {
    return {};
  }

  getAuthParams() {
    const salt = crypto.randomBytes(6).toString("hex");
    const token = crypto
      .createHash("md5")
      .update(this.password + salt)
      .digest("hex");
    return {
      u: this.user,
      t: token,
      s: salt,
      v: "1.16.1",
      c: "aurral",
      f: "json",
    };
  }

  async request(endpoint, params = {}) {
    if (!this.isConfigured()) throw new Error("Navidrome not configured");

    try {
      for (let attempt = 0; ; attempt += 1) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries({ ...this.getAuthParams(), ...params })) {
          if (Array.isArray(value)) {
            for (const item of value) query.append(key, item);
          } else if (value != null) {
            query.set(key, value);
          }
        }
        try {
          const endpointUrl = `${this.url}/rest/${endpoint}`;
          const headers = this.getRequestHeaders();
          const response = endpoint === "updatePlaylist"
            ? await axios.post(endpointUrl, query, { preserveMethodOnRedirect: true, headers })
            : await axios.get(`${endpointUrl}?${query}`, { headers });

          if (response.data["subsonic-response"]?.status === "failed") {
            const responseError = response.data["subsonic-response"].error || {};
            const error = new Error(responseError.message || "Navidrome request failed");
            error.code = responseError.code;
            throw error;
          }

          return response.data["subsonic-response"];
        } catch (error) {
          const isNetworkFailure = error instanceof TypeError && !error?.response;
          if (isNetworkFailure) {
            if (!NAVIDROME_RETRYABLE_READ_ENDPOINTS.has(endpoint) || attempt >= NAVIDROME_NETWORK_RETRIES) {
              throw error;
            }
            await wait(NAVIDROME_RATE_LIMIT_DELAY_MS);
            continue;
          }
          if (!error?.response) throw error;
          if (error.response.status !== 429 || attempt >= NAVIDROME_RATE_LIMIT_RETRIES) throw error;
          const retryAfterHeader = error.response.headers?.["retry-after"]?.trim();
          const retryAfter = Number(retryAfterHeader);
          const delay = retryAfterHeader && Number.isFinite(retryAfter) && retryAfter >= 0
            ? Math.min(retryAfter * 1000, NAVIDROME_RATE_LIMIT_MAX_DELAY_MS)
            : NAVIDROME_RATE_LIMIT_DELAY_MS;
          await wait(Math.max(0, delay));
        }
      }
    } catch (error) {
      console.error(`Navidrome Error [${endpoint}]:`, error.message);
      throw error;
    }
  }

  async ping() {
    return this.request("ping");
  }

  async findSong(_title, _artist, track = {}) {
    const normalizedPath = normalizeLibraryPath(track.path).toLowerCase();
    const relativePaths = this._libraryPaths
      .map((libraryPath) => normalizeLibraryPath(libraryPath).toLowerCase())
      .filter((libraryPath) => normalizedPath.startsWith(`${libraryPath}/`))
      .map((libraryPath) => normalizedPath.slice(libraryPath.length + 1));
    const indexedSongs = await this._getIndexedSongs();
    const normalizeSongPath = (song) => normalizeLibraryPath(song.path).toLowerCase();
    const exactPathMatch = normalizedPath
      ? indexedSongs.find((song) => normalizeSongPath(song) === normalizedPath)
      : null;
    if (exactPathMatch) return exactPathMatch;

    const relativeMatches = indexedSongs.filter((song) => {
      const songPath = normalizeSongPath(song);
      return songPath && relativePaths.includes(songPath);
    });
    if (relativeMatches.length === 1) return relativeMatches[0];

    const mbid = String(track.mbid || "").trim().toLowerCase();
    if (!mbid) return null;
    return indexedSongs.find(
      (song) => String(song.musicBrainzId || "").trim().toLowerCase() === mbid,
    ) || null;
  }

  async searchSongsByArtist(artistName, limit = 5) {
    const data = await this.request("search3", {
      query: artistName,
      songCount: limit,
      artistCount: 0,
      albumCount: 0,
    });
    const songs = data.searchResult3?.song || [];
    const list = Array.isArray(songs) ? songs : [songs];
    return list
      .filter((s) => s.artist && s.artist.toLowerCase() === artistName.toLowerCase())
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        title: s.title,
        album: s.album,
        duration: s.duration ?? 0,
      }));
  }

  getStreamUrl(songId) {
    if (!this.isConfigured()) throw new Error("Navidrome not configured");
    const params = new URLSearchParams(this.getAuthParams());
    params.delete("f");
    return `${this.url}/rest/stream?id=${encodeURIComponent(songId)}&${params.toString()}`;
  }

  // Subsonic reads that carry the caller's own annotations (starred,
  // userRating) and playlists. Used by the per-user client.
  async getSong(id) {
    const data = await this.request("getSong", { id });
    return data.song || null;
  }

  async searchSongs(query, { limit = 20 } = {}) {
    const data = await this.request("search3", {
      query,
      songCount: limit,
      artistCount: 0,
      albumCount: 0,
    });
    const songs = data.searchResult3?.song || [];
    return Array.isArray(songs) ? songs : [songs];
  }

  async getSubsonicPlaylists() {
    const data = await this.request("getPlaylists");
    const playlists = data.playlists?.playlist || [];
    return Array.isArray(playlists) ? playlists : [playlists];
  }

  async getSubsonicPlaylist(id) {
    const data = await this.request("getPlaylist", { id });
    const playlist = data.playlist || null;
    if (!playlist) return null;
    const entries = playlist.entry || [];
    return { ...playlist, entry: Array.isArray(entries) ? entries : [entries] };
  }

  async setRating(id, rating) {
    return this.request("setRating", { id, rating: Math.max(0, Math.min(5, Number(rating) || 0)) });
  }

  async star(id) {
    return this.request("star", { id });
  }

  async unstar(id) {
    return this.request("unstar", { id });
  }

  async getPlaylists() {
    const data = await this.request("getPlaylists");
    const playlists = data.playlists?.playlist || [];
    return Array.isArray(playlists) ? playlists : [playlists];
  }

  async getPlaylist(id) {
    const data = await this.request("getPlaylist", { id });
    return data.playlist || null;
  }

  async createPlaylist(name, songIds) {
    const ids = Array.isArray(songIds) ? songIds : [];
    const data = await this.request("createPlaylist", {
      name,
      songId: ids.slice(0, PLAYLIST_SONG_BATCH_SIZE),
    });
    const playlist = data.playlist || null;
    if (!playlist?.id) return playlist;
    for (let index = PLAYLIST_SONG_BATCH_SIZE; index < ids.length; index += PLAYLIST_SONG_BATCH_SIZE) {
      await this.request("updatePlaylist", {
        playlistId: playlist.id,
        songIdToAdd: ids.slice(index, index + PLAYLIST_SONG_BATCH_SIZE),
      });
    }
    return playlist;
  }

  async updatePlaylist(playlistId, { name, songIds = [] } = {}) {
    const playlist = await this.getPlaylist(playlistId);
    const entries = playlist?.entry
      ? Array.isArray(playlist.entry) ? playlist.entry : [playlist.entry]
      : [];
    const ids = Array.isArray(songIds) ? songIds : [];
    await this.request("updatePlaylist", {
      playlistId,
      name,
      songIndexToRemove: entries.map((_, index) => index),
      songIdToAdd: ids.slice(0, PLAYLIST_SONG_BATCH_SIZE),
    });
    for (let index = PLAYLIST_SONG_BATCH_SIZE; index < ids.length; index += PLAYLIST_SONG_BATCH_SIZE) {
      await this.request("updatePlaylist", {
        playlistId,
        songIdToAdd: ids.slice(index, index + PLAYLIST_SONG_BATCH_SIZE),
      });
    }
  }

  async renamePlaylist(playlistId, name) {
    return this.request("updatePlaylist", { playlistId, name });
  }

  async deletePlaylist(id) {
    return this.request("deletePlaylist", { id });
  }

  async addToPlaylist(playlistId, songId) {
    return this.request("updatePlaylist", {
      playlistId,
      songIdToAdd: songId,
    });
  }

  async removeFromPlaylist(playlistId, songId) {
    try {
      const playlistData = await this.request("getPlaylist", {
        id: playlistId,
      });
      const playlist = playlistData.playlist;

      if (!playlist || !playlist.entry) {
        throw new Error("Playlist not found or empty");
      }

      const entries = Array.isArray(playlist.entry) ? playlist.entry : [playlist.entry];
      const songIndex = entries.findIndex((entry) => entry.id === songId);

      if (songIndex === -1) {
        throw new Error("Song not found in playlist");
      }

      await this.request("updatePlaylist", {
        playlistId,
        songIndexToRemove: songIndex,
      });

      return { success: true };
    } catch (error) {
      throw new Error(`Failed to remove song from playlist: ${error.message}`);
    }
  }

  async _nativeLogin() {
    if (!this.isConfigured()) throw new Error("Navidrome not configured");
    if (!this._nativeTokenPromise) {
      this._nativeTokenPromise = axios.post(
        `${this.url}/auth/login`,
        { username: this.user, password: this.password },
        { headers: { "Content-Type": "application/json" } },
      ).then(({ data }) => {
        const token = data.token || data.Token;
        if (!token) throw new Error("No token in login response");
        return token;
      }).catch((error) => {
        this._nativeTokenPromise = null;
        throw error;
      });
    }
    return this._nativeTokenPromise;
  }

  async _nativeRequest(method, path, body = null) {
    const base = this.url;
    const url = path.startsWith("/") ? `${base}${path}` : `${base}/api/${path}`;
    let tokenRefreshes = 0;
    let rateLimitRetries = 0;
    for (;;) {
      let tokenPromise = this._nativeTokenPromise;
      if (!tokenPromise) {
        const token = await this._nativeLogin();
        tokenPromise = this._nativeTokenPromise || Promise.resolve(token);
      }
      const token = await tokenPromise;
      const headers = {
        "Content-Type": "application/json",
        "X-ND-Authorization": `Bearer ${token}`,
      };
      try {
        let response;
        if (method === "GET") {
          response = await axios.get(url, { headers });
        } else if (method === "POST") {
          response = await axios.post(url, body, { headers });
        } else if (method === "PUT") {
          response = await axios.put(url, body, { headers });
        } else if (method === "DELETE") {
          response = await axios.delete(url, { headers });
        } else {
          throw new Error(`Unsupported method: ${method}`);
        }
        const newToken = response.headers["x-nd-authorization"];
        if (newToken) this._nativeTokenPromise = Promise.resolve(newToken);
        return response.data;
      } catch (error) {
        const status = error?.response?.status;
        if (status === 401 && tokenRefreshes === 0) {
          tokenRefreshes += 1;
          if (this._nativeTokenPromise === tokenPromise) this._nativeTokenPromise = null;
          continue;
        }
        if (status === 429 && rateLimitRetries < NAVIDROME_RATE_LIMIT_RETRIES) {
          const retryAfterHeader = error.response.headers?.["retry-after"]?.trim();
          const retryAfter = Number(retryAfterHeader);
          const delay = retryAfterHeader && Number.isFinite(retryAfter) && retryAfter >= 0
            ? Math.min(retryAfter * 1000, NAVIDROME_RATE_LIMIT_MAX_DELAY_MS)
            : NAVIDROME_RATE_LIMIT_DELAY_MS;
          rateLimitRetries += 1;
          await wait(Math.max(0, delay));
          continue;
        }
        throw error;
      }
    }
  }

  async _requestPlaylistArtwork(method, playlistId, data, filename, contentType) {
    const url = `${this.url}/api/playlist/${encodeURIComponent(playlistId)}/image`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let tokenPromise = this._nativeTokenPromise;
      if (!tokenPromise) {
        const token = await this._nativeLogin();
        tokenPromise = this._nativeTokenPromise || Promise.resolve(token);
      }
      const token = await tokenPromise;
      const options = {
        method,
        headers: { "X-ND-Authorization": `Bearer ${token}` },
      };
      if (method === "POST") {
        const form = new FormData();
        form.append("image", new Blob([data], { type: contentType }), filename);
        options.body = form;
      }
      const response = await fetch(url, options);
      if (response.status === 401 && attempt === 0) {
        if (this._nativeTokenPromise === tokenPromise) this._nativeTokenPromise = null;
        continue;
      }
      if (!response.ok) {
        const action = method === "POST" ? "upload" : "deletion";
        throw new Error(`Playlist artwork ${action} failed with status ${response.status}`);
      }
      return;
    }
  }

  async _getIndexedSongs() {
    if (!this._indexedSongsPromise) {
      this._indexedSongsPromise = (async () => {
        const songs = [];
        for (let start = 0; ; ) {
          const page = await this._nativeRequest(
            "GET",
            `/api/song?_start=${start}&_end=${start + NAVIDROME_SONG_PAGE_SIZE}`,
          );
          if (!Array.isArray(page) || page.length === 0) break;
          songs.push(...page);
          if (page.length < NAVIDROME_SONG_PAGE_SIZE) break;
          start += page.length;
        }
        return songs;
      })()
        .catch(() => {
          this._indexedSongsPromise = null;
          return [];
        });
    }
    return this._indexedSongsPromise;
  }

  async uploadPlaylistArtwork(playlistId, data, filename = "cover.webp", contentType = "image/webp") {
    return this._requestPlaylistArtwork(
      "POST",
      playlistId,
      data,
      filename,
      contentType,
    );
  }

  async deletePlaylistArtwork(playlistId) {
    return this._requestPlaylistArtwork("DELETE", playlistId);
  }

  async getLibraries() {
    return this._nativeRequest("GET", "/api/library");
  }

  async createLibrary(name, path) {
    return this._nativeRequest("POST", "/api/library", { name, path });
  }

  async updateLibrary(id, payload) {
    return this._nativeRequest("PUT", `/api/library/${id}`, payload);
  }

  async getUsers() {
    const users = await this._nativeRequest("GET", "/api/user");
    return Array.isArray(users) ? users : [];
  }

  // Library access for a non-admin Navidrome user. Admins implicitly see every
  // library, and Navidrome rejects assignments for them.
  async getUserLibraries(userId) {
    const libraries = await this._nativeRequest("GET", `/api/user/${encodeURIComponent(userId)}/library`);
    return Array.isArray(libraries) ? libraries : [];
  }

  async setUserLibraries(userId, libraryIds) {
    return this._nativeRequest("PUT", `/api/user/${encodeURIComponent(userId)}/library`, {
      libraryIds: (Array.isArray(libraryIds) ? libraryIds : []).map((id) => Number(id)),
    });
  }

  async getPlaylists() {
    const playlists = await this._nativeRequest("GET", "/api/playlist?_end=1000");
    return Array.isArray(playlists) ? playlists : [];
  }

  // Navidrome pages this endpoint and playlists here run past ten thousand
  // tracks, so read page after page until one comes back short. Anything
  // that rewrites a playlist depends on seeing all of it.
  async getPlaylistTracks(playlistId, { limit = 200_000, pageSize = NAVIDROME_PLAYLIST_TRACK_PAGE_SIZE } = {}) {
    const tracks = [];
    for (let start = 0; start < limit; ) {
      const end = Math.min(start + pageSize, limit);
      const page = await this._nativeRequest(
        "GET",
        `/api/playlist/${encodeURIComponent(playlistId)}/tracks?_start=${start}&_end=${end}&_sort=id&_order=ASC`,
      );
      if (!Array.isArray(page) || page.length === 0) break;
      tracks.push(...page);
      if (page.length < end - start) break;
      start = end;
    }
    return tracks;
  }

  // A file's path is stored relative to its library root, so the same file
  // symlinked into a personal library carries the identical path there. That
  // is the only identity shared across libraries: Navidrome's own persistent
  // id deliberately prepends the library id, so it cannot be used for this.
  // Appends in payload order.
  async addPlaylistTracks(playlistId, mediaFileIds) {
    const ids = (Array.isArray(mediaFileIds) ? mediaFileIds : []).map(String);
    let last = null;
    for (let index = 0; index < ids.length; index += NAVIDROME_PLAYLIST_WRITE_CHUNK) {
      last = await this._nativeRequest(
        "POST",
        `/api/playlist/${encodeURIComponent(playlistId)}/tracks`,
        { ids: ids.slice(index, index + NAVIDROME_PLAYLIST_WRITE_CHUNK) },
      );
    }
    return last;
  }

  // Takes playlist_tracks ids (the entry), not media_file ids. Chunked: the
  // ids travel in the query string, and thousands of them exceed URL limits.
  //
  // Navidrome renumbers the remaining entries to 1..N after every delete, so
  // the chunks go from the highest ids down: removing the tail never changes
  // the ids of what is still ahead of it.
  async removePlaylistTracks(playlistId, playlistTrackIds) {
    const ids = [...new Set((Array.isArray(playlistTrackIds) ? playlistTrackIds : []).map(String))]
      .sort((a, b) => {
        const left = Number(a);
        const right = Number(b);
        if (Number.isFinite(left) && Number.isFinite(right)) return right - left;
        return b.localeCompare(a);
      });
    if (!ids.length) return null;
    let last = null;
    for (let index = 0; index < ids.length; index += NAVIDROME_PLAYLIST_WRITE_CHUNK) {
      const query = ids.slice(index, index + NAVIDROME_PLAYLIST_WRITE_CHUNK).map((id) => `id=${encodeURIComponent(id)}`).join("&");
      last = await this._nativeRequest(
        "DELETE",
        `/api/playlist/${encodeURIComponent(playlistId)}/tracks?${query}`,
      );
    }
    return last;
  }

  // Native API title search. Unlike the Subsonic search, the songs come back
  // with their real library-relative paths, which is what path matching needs.
  async searchSongsNative(title, { limit = 40 } = {}) {
    const query = String(title || "").trim();
    if (!query) return [];
    const songs = await this._nativeRequest(
      "GET",
      `/api/song?_start=0&_end=${Number(limit)}&title=${encodeURIComponent(query)}`,
    );
    return Array.isArray(songs) ? songs : [];
  }

  /**
   * Songs this user has starred in Navidrome, newest first. Read as the user,
   * so the answer is their own stars and nobody else's.
   */
  async getStarredSongs({ limit = 0 } = {}) {
    const data = await this.request("getStarred2");
    const songs = data.starred2?.song || [];
    const list = Array.isArray(songs) ? songs : [songs].filter(Boolean);
    return limit > 0 ? list.slice(0, limit) : list;
  }

  /**
   * Move one playlist entry. `rowId` is the playlist-track row's own id, and
   * `toIndex` is where the entry should end up, counting from zero, in the
   * list as it will read afterwards.
   *
   * Navidrome takes the entry out first and then inserts it before the
   * position given, so the value it wants is one past the destination.
   */
  async movePlaylistTrack(playlistId, rowId, toIndex) {
    const target = Math.max(0, Number(toIndex) || 0);
    return this._nativeRequest(
      "PUT",
      `/api/playlist/${encodeURIComponent(String(playlistId))}/tracks/${encodeURIComponent(String(rowId))}`,
      { insert_before: String(target + 1) },
    );
  }

  /** The playlist record itself, including its owner and any smart rules. */
  async getPlaylistRecord(playlistId) {
    return this._nativeRequest("GET", `/api/playlist/${encodeURIComponent(String(playlistId))}`);
  }

  /** One song read through the native API, which carries its real path. */
  async getSongNative(id) {
    const song = await this._nativeRequest("GET", `/api/song/${encodeURIComponent(String(id || ""))}`);
    return song && typeof song === "object" ? song : null;
  }

  async findSongsByPath(path) {
    const songs = await this._nativeRequest(
      "GET",
      `/api/song?_end=25&path=${encodeURIComponent(String(path || ""))}`,
    );
    return Array.isArray(songs) ? songs : [];
  }

  // The native library list reports scan state and authenticates the same way
  // the rest of the admin calls here do, so it keeps working when the stored
  // Subsonic password does not.
  async getScanStatusNative() {
    const libraries = await this._nativeRequest("GET", "/api/library");
    const rows = Array.isArray(libraries) ? libraries : [];
    const scanning = rows.some((library) => {
      if (library?.fullScanInProgress === true) return true;
      // A quick scan sets lastScanStartedAt and only moves lastScanAt once it
      // finishes. An idle library reports the zero time for the start.
      const started = Date.parse(library?.lastScanStartedAt || "");
      if (!Number.isFinite(started) || started <= 0) return false;
      const finished = Date.parse(library?.lastScanAt || "");
      return !Number.isFinite(finished) || finished < started;
    });
    return { scanning, count: rows.length };
  }

  async getScanStatus() {
    try {
      return await this.getScanStatusNative();
    } catch (nativeError) {
      try {
        const data = await this.request("getScanStatus");
        const status = data.scanStatus || {};
        return {
          scanning: status.scanning === true || status.scanning === "true",
          count: Number(status.count || 0),
        };
      } catch {
        throw nativeError;
      }
    }
  }

  // Navidrome's SQLite database locks up under a scan; playlist rewrites made
  // at the same time fail. Callers that write a lot wait for it first.
  async waitForScanToFinish({ timeoutMs = 10 * 60 * 1000, intervalMs = 5_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let status;
      try {
        status = await this.getScanStatus();
      } catch {
        return { waited: false, scanning: null };
      }
      if (!status.scanning) return { waited: true, scanning: false };
      if (Date.now() >= deadline) return { waited: true, scanning: true };
      await wait(intervalMs);
    }
  }

  async scanLibrary() {
    if (!this.isConfigured()) return null;
    try {
      this._indexedSongsPromise = null;
      return await this.request("startScan");
    } catch (err) {
      console.warn("[Navidrome] scanLibrary failed:", err?.message);
      return null;
    }
  }

  async ensureWeeklyFlowLibrary(libraryPath) {
    if (!this.isConfigured()) return null;
    const name = PLAYLIST_LIBRARY_NAME;
    const normalizedPath = normalizeLibraryPath(libraryPath);
    this._libraryPaths = [normalizedPath];
    try {
      const verifyLibrary = async (libraryId) => {
        const refreshed = await this.getLibraries();
        const list = Array.isArray(refreshed) ? refreshed : [];
        const byId = libraryId == null
          ? null
          : list.find((library) => String(library?.id || "") === String(libraryId));
        const verified = byId || list.find(
          (library) => normalizeLibraryPath(library?.path) === normalizedPath,
        );
        if (!verified || normalizeLibraryPath(verified.path) !== normalizedPath) {
          throw new Error(
            `Navidrome library path verification failed: expected ${normalizedPath}`,
          );
        }
        this._libraryPaths = [...new Set([
          normalizedPath,
          ...list.map((library) => normalizeLibraryPath(library.path)).filter(Boolean),
        ])];
        return verified;
      };
      const updateAndVerify = async (library) => {
        await this.updateLibrary(library.id, library);
        return verifyLibrary(library.id);
      };
      const libs = await this.getLibraries();
      const list = Array.isArray(libs) ? libs : [];
      this._libraryPaths = [...new Set([
        normalizedPath,
        ...list.map((lib) => normalizeLibraryPath(lib.path)).filter(Boolean),
      ])];
      const byPath = list.find((lib) => normalizeLibraryPath(lib.path) === normalizedPath);
      if (byPath) {
        if (byPath.name !== name) {
          return updateAndVerify({
            ...byPath,
            name,
            path: normalizedPath,
          });
        }
        return byPath;
      }

      const byName = list.find((lib) => lib.name === name || LEGACY_LIBRARY_NAMES.has(lib.name));
      if (byName) {
        if (normalizeLibraryPath(byName.path) !== normalizedPath) {
          return updateAndVerify({
            ...byName,
            name,
            path: normalizedPath,
          });
        }
        return byName;
      }

      const legacy = list.find((lib) => isLegacyPlaylistLibraryPath(lib.path));
      if (legacy) {
        return updateAndVerify({
          ...legacy,
          name,
          path: normalizedPath,
        });
      }

      const created = await this.createLibrary(name, normalizedPath);
      return verifyLibrary(created?.id);
    } catch (err) {
      const message = err?.response?.data?.error || err.message;
      if (err?.response?.status === 429) {
        logger.debug("navidrome", "Navidrome library setup was rate limited", { message });
      } else {
        logger.warn("navidrome", "Navidrome library setup failed", { message });
      }
      throw err;
    }
  }
}
