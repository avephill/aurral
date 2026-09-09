import { NavidromeClient } from "./navidrome.js";
import { getNavidromeUserHeader } from "../config/featureFlags.js";
import { dbOps } from "../db/helpers/index.js";

const PLAYLIST_SONG_BATCH_SIZE = 50;

/**
 * A Navidrome client that acts as one Aurral user rather than as the admin
 * account from Settings.
 *
 * It never holds a password. Every Subsonic call carries the trusted
 * username header that Navidrome's external-auth support reads (the same
 * mechanism a reverse-proxy SSO setup uses), so playlists, stars and ratings
 * land on that user's account. Navidrome only honours the header from
 * addresses in its trusted-sources list; anywhere else the call fails with a
 * Subsonic auth error, which callers surface as "not connected".
 */
export class NavidromeUserClient extends NavidromeClient {
  constructor(url, username, { header = getNavidromeUserHeader() } = {}) {
    super(url, username, null);
    this.header = header;
  }

  isConfigured() {
    return !!(this.url && this.user);
  }

  getAuthParams() {
    // No token or salt: the header authenticates. `u` is still sent so the
    // request reads sensibly in Navidrome's logs.
    return { u: this.user, v: "1.16.1", c: "aurral", f: "json" };
  }

  getRequestHeaders() {
    return { [this.header]: this.user };
  }

  // The native API needs a password login, which this client cannot do.
  async _nativeLogin() {
    throw new Error("Navidrome native API is not available for per-user requests");
  }

  async appendPlaylistSongs(playlistId, songIds) {
    const ids = (Array.isArray(songIds) ? songIds : []).filter(Boolean);
    for (let index = 0; index < ids.length; index += PLAYLIST_SONG_BATCH_SIZE) {
      await this.request("updatePlaylist", {
        playlistId,
        songIdToAdd: ids.slice(index, index + PLAYLIST_SONG_BATCH_SIZE),
      });
    }
    return ids.length;
  }

  async removePlaylistEntries(playlistId, indexes) {
    const values = [...new Set((Array.isArray(indexes) ? indexes : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0))];
    if (!values.length) return 0;
    await this.request("updatePlaylist", { playlistId, songIndexToRemove: values });
    return values.length;
  }
}

/**
 * Builds the per-user client for an Aurral user from the admin Navidrome
 * connection in Settings (only its URL is used). Returns null when Navidrome
 * is not configured or the user has no username to act as.
 */
export function createNavidromeUserClient(user, settings = dbOps.getSettings()) {
  const navidrome = settings?.integrations?.navidrome;
  const username = String(user?.username || "").trim();
  if (!navidrome?.url || !username) return null;
  return new NavidromeUserClient(navidrome.url, username);
}

/**
 * Subsonic error codes that mean "Navidrome did not accept the user header",
 * as opposed to a problem with the request itself.
 */
export function isNavidromeAuthError(error) {
  const code = Number(error?.code);
  return code === 10 || code === 40 || code === 41 || code === 50;
}
