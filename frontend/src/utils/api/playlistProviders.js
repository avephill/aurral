import {
  getData,
  postData,
  putData,
  patchData,
  deleteData,
} from "./core.js";
import { queryClient, queryKeys } from "../../queryClient.js";

/**
 * Where hand-made playlists live.
 *
 * Aurral can hold them itself, or leave them in Navidrome and read and edit
 * them there as the signed-in user. The two stores answer different endpoints
 * and disagree on small things (Navidrome addresses an entry by its position,
 * Aurral by a job id), so each one is written out here as a provider with the
 * same shape, and the rest of the app asks the current provider rather than
 * asking which store is in use.
 *
 * A provider offers: status, list, get, create, rename, addTracks, remove,
 * removeEntry and invalidate.
 */

export const PLAYLIST_STORES = ["aurral", "navidrome"];

let storeMode = "aurral";

export const setPlaylistStoreMode = (mode) => {
  storeMode = mode === "navidrome" ? "navidrome" : "aurral";
  return storeMode;
};

export const getPlaylistStoreMode = () => storeMode;

export const isNavidromePlaylistStore = () => storeMode === "navidrome";

// Navidrome-backed endpoints. Exported on their own as well, because the
// Navidrome playlists page speaks to that store directly.
export const getNavidromePlaylistStatus = ({ signal } = {}) =>
  getData("/navidrome-playlists/status", { signal });

export const getNavidromePlaylists = ({ signal } = {}) =>
  getData("/navidrome-playlists", { signal });

export const getNavidromePlaylist = (playlistId, { signal } = {}) =>
  getData(`/navidrome-playlists/${encodeURIComponent(playlistId)}`, { signal });

export const createNavidromePlaylist = (payload) => postData("/navidrome-playlists", payload);

export const addNavidromePlaylistTracks = (playlistId, payload) =>
  postData(`/navidrome-playlists/${encodeURIComponent(playlistId)}/tracks`, payload);

export const removeNavidromePlaylistEntry = (playlistId, index, songId = null) =>
  deleteData(
    `/navidrome-playlists/${encodeURIComponent(playlistId)}/entries/${encodeURIComponent(index)}`
    + (songId ? `?songId=${encodeURIComponent(songId)}` : ""),
  );

export const renameNavidromePlaylist = (playlistId, name) =>
  patchData(`/navidrome-playlists/${encodeURIComponent(playlistId)}`, { name });

export const deleteNavidromePlaylist = (playlistId) =>
  deleteData(`/navidrome-playlists/${encodeURIComponent(playlistId)}`);

export const invalidateNavidromePlaylists = () =>
  queryClient.invalidateQueries({ queryKey: queryKeys.navidromePlaylistsRoot });

const unwrapPlaylist = (result) => result?.playlist || result;

const aurralPlaylistProvider = {
  id: "aurral",
  // Aurral's own store addresses a track by the download job that produced it.
  entryAddressing: "jobId",
  status: ({ signal } = {}) => getData("/playlists/status", { signal }),
  list: async ({ signal } = {}) => {
    const status = await getData("/playlists/status", { signal });
    return { playlists: Array.isArray(status?.sharedPlaylists) ? status.sharedPlaylists : [] };
  },
  get: (playlistId, { signal } = {}) =>
    getData(`/playlists/shared-playlists/${encodeURIComponent(playlistId)}`, { signal }),
  create: (payload) => postData("/playlists/shared-playlists", payload),
  rename: (playlistId, payload) => putData(`/playlists/shared-playlists/${playlistId}`, payload),
  addTracks: (playlistId, payload) =>
    postData(`/playlists/shared-playlists/${playlistId}/tracks`, payload),
  remove: (playlistId) => deleteData(`/playlists/shared-playlists/${playlistId}`),
  removeEntry: (playlistId, { jobId } = {}) =>
    deleteData(`/playlists/shared-playlists/${playlistId}/tracks/${jobId}`),
  invalidate: () => queryClient.invalidateQueries({ queryKey: queryKeys.playlistStatus }),
};

// Every write goes through the same invalidation, so a change made here shows
// up wherever the Navidrome playlists are on screen.
const withInvalidate = async (work) => {
  const result = await work();
  invalidateNavidromePlaylists();
  return result;
};

const navidromePlaylistProvider = {
  id: "navidrome",
  // Navidrome addresses a playlist entry by its position in the list.
  entryAddressing: "index",
  status: getNavidromePlaylistStatus,
  list: getNavidromePlaylists,
  get: getNavidromePlaylist,
  create: (payload) => withInvalidate(() => createNavidromePlaylist(payload)).then(unwrapPlaylist),
  rename: (playlistId, payload) =>
    withInvalidate(() => renameNavidromePlaylist(playlistId, payload?.name)).then(unwrapPlaylist),
  addTracks: (playlistId, payload) =>
    withInvalidate(() => addNavidromePlaylistTracks(playlistId, payload)),
  remove: (playlistId) => withInvalidate(() => deleteNavidromePlaylist(playlistId)),
  removeEntry: (playlistId, { index, songId = null } = {}) =>
    withInvalidate(() => removeNavidromePlaylistEntry(playlistId, index, songId)),
  invalidate: invalidateNavidromePlaylists,
};

export const getPlaylistProvider = () =>
  (isNavidromePlaylistStore() ? navidromePlaylistProvider : aurralPlaylistProvider);

export { aurralPlaylistProvider, navidromePlaylistProvider };
