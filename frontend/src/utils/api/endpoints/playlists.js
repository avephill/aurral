import {
  getData,
  postData,
  putData,
  patchData,
  deleteData,
  buildAuthenticatedApiUrl,
} from "../core.js";
import { queryClient, queryKeys } from "../../../queryClient.js";

export const getFlowTrackStreamUrl = (jobId) =>
  buildAuthenticatedApiUrl(`/playlists/stream/${encodeURIComponent(jobId)}`);

export const getStagingStreamUrl = (jobId) =>
  buildAuthenticatedApiUrl(`/playlists/staging-stream/${encodeURIComponent(jobId)}`);

export const getFlowArtworkUrl = (playlistId, version = "current") =>
  buildAuthenticatedApiUrl(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
    { v: version },
  );

export const uploadFlowArtwork = (playlistId, file) =>
  putData(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
    file,
    {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
    },
  );

export const deleteFlowArtwork = (playlistId) =>
  deleteData(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
  );

export const generateFlowArtwork = (playlistId) =>
  postData(
    `/playlists/artwork/${encodeURIComponent(playlistId)}/generate`,
  );

// Where hand-made playlists live. "aurral" is the built-in store under
// /playlists; "navidrome" reads and edits the signed-in user's Navidrome
// playlists directly, so the shared-playlist helpers below route there and
// every "Add to playlist" menu in the app follows without knowing.
let playlistStoreMode = "aurral";

export const setPlaylistStoreMode = (mode) => {
  playlistStoreMode = mode === "navidrome" ? "navidrome" : "aurral";
};

export const getPlaylistStoreMode = () => playlistStoreMode;

export const isNavidromePlaylistStore = () => playlistStoreMode === "navidrome";

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
    `/navidrome-playlists/${encodeURIComponent(playlistId)}/entries/${encodeURIComponent(index)}`,
    { params: songId ? { songId } : {} },
  );

export const renameNavidromePlaylist = (playlistId, name) =>
  patchData(`/navidrome-playlists/${encodeURIComponent(playlistId)}`, { name });

export const deleteNavidromePlaylist = (playlistId) =>
  deleteData(`/navidrome-playlists/${encodeURIComponent(playlistId)}`);

export const invalidateNavidromePlaylists = () =>
  queryClient.invalidateQueries({ queryKey: queryKeys.navidromePlaylistsRoot });

const fetchPlaylistStatus = async (signal) => {
  const status = await getData("/playlists/status", { signal });
  if (!isNavidromePlaylistStore()) return status;
  // Aurral's own shared playlists are not in use; show the Navidrome ones in
  // their place so the menus that read status.sharedPlaylists keep working.
  try {
    const { playlists } = await getNavidromePlaylists({ signal });
    return { ...status, sharedPlaylists: Array.isArray(playlists) ? playlists : [] };
  } catch (error) {
    if (error?.name === "CanceledError" || error?.code === "ERR_CANCELED") throw error;
    return { ...status, sharedPlaylists: [], navidromePlaylistsError: error?.response?.data?.message || error?.message || "" };
  }
};

export const getFlowStatus = ({ signal, bypassCache = false } = {}) => {
  if (bypassCache) return fetchPlaylistStatus(signal);
  return queryClient.fetchQuery({
    queryKey: queryKeys.playlistStatus,
    queryFn: ({ signal: querySignal }) => fetchPlaylistStatus(querySignal),
    staleTime: 4_000,
  });
};

export const getFlowJobs = (flowId, limit = null, options = {}) => {
  const params = { ...(options.params || {}) };
  const parsedLimit = Number(limit);
  if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
    params.limit = Math.floor(parsedLimit);
  }
  return getData(`/playlists/jobs/${flowId}`, {
    ...options,
    params,
  });
};

export const getAllFlowJobs = (options = {}) =>
  getData("/playlists/jobs", options);

export const reSearchAllMissingTracks = () =>
  postData("/playlists/research-missing");

export const createFlow = (payload) => postData("/playlists/flows", payload);

export const updateFlow = (flowId, payload) =>
  putData(`/playlists/flows/${flowId}`, payload);

export const deleteFlow = (flowId) => deleteData(`/playlists/flows/${flowId}`);

export const convertFlowToStaticPlaylist = (flowId, payload = {}) =>
  postData(
    `/playlists/flows/${flowId}/static-playlist`,
    payload,
  );

export const createSharedPlaylist = async (payload) => {
  if (isNavidromePlaylistStore()) {
    const result = await createNavidromePlaylist(payload);
    invalidateNavidromePlaylists();
    return result?.playlist || result;
  }
  return postData("/playlists/shared-playlists", payload);
};

export const setFlowEnabled = (flowId, enabled) =>
  putData(`/playlists/flows/${flowId}/enabled`, {
    enabled,
  });

export const importSharedPlaylist = (payload) =>
  postData(
    "/playlists/shared-playlists/import",
    payload,
  );

export const updateSharedPlaylist = async (playlistId, payload) => {
  if (isNavidromePlaylistStore()) {
    const result = await renameNavidromePlaylist(playlistId, payload?.name);
    invalidateNavidromePlaylists();
    return result?.playlist || result;
  }
  return putData(
    `/playlists/shared-playlists/${playlistId}`,
    payload,
  );
};

export const addSharedPlaylistTracks = async (playlistId, payload) => {
  if (isNavidromePlaylistStore()) {
    const result = await addNavidromePlaylistTracks(playlistId, payload);
    invalidateNavidromePlaylists();
    return result;
  }
  return postData(
    `/playlists/shared-playlists/${playlistId}/tracks`,
    payload,
  );
};

export const deleteSharedPlaylist = async (playlistId) => {
  if (isNavidromePlaylistStore()) {
    const result = await deleteNavidromePlaylist(playlistId);
    invalidateNavidromePlaylists();
    return result;
  }
  return deleteData(
    `/playlists/shared-playlists/${playlistId}`,
  );
};

export const deleteSharedPlaylistTrack = (playlistId, jobId) =>
  deleteData(
    `/playlists/shared-playlists/${playlistId}/tracks/${jobId}`,
  );

export const reSearchSharedPlaylistTrack = (playlistId, jobId) =>
  postData(
    `/playlists/shared-playlists/${playlistId}/tracks/${jobId}/research`,
  );

export const reSearchFlowTrack = (playlistId, jobId) =>
  postData(
    `/playlists/flows/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(jobId)}/research`,
  );

export const reSearchMissingSharedPlaylistTracks = (playlistId) =>
  postData(
    `/playlists/shared-playlists/${playlistId}/research-missing`,
  );

export const searchTrackUpgrade = (playlistId, jobId) =>
  postData(
    `/playlists/quality-upgrades/${encodeURIComponent(playlistId)}/${encodeURIComponent(jobId)}`,
  );

export const searchPlaylistUpgrades = (playlistId) =>
  postData(`/playlists/quality-upgrades/${encodeURIComponent(playlistId)}`);

export const searchAllUpgrades = () => postData("/playlists/quality-upgrades");

export const approveBlockedJob = (jobId) =>
  postData(`/playlists/jobs/${jobId}/approve`);

export const denyBlockedJob = (jobId) =>
  postData(`/playlists/jobs/${jobId}/deny`);

export const startFlowPlaylist = (flowId, limit = 30) =>
  postData(`/playlists/start/${flowId}`, {
    limit,
  });

export const getSpotifyImportStatus = () => getData("/playlists/import/spotify/status");

export const startSpotifyOAuth = (callbackUrl) =>
  postData("/playlists/import/spotify/oauth/start", { callbackUrl });

export const completeSpotifyOAuth = (payload) =>
  postData("/playlists/import/spotify/oauth/complete", payload);

export const disconnectSpotify = () => deleteData("/playlists/import/spotify");

export const getSpotifyPlaylists = () => getData("/playlists/import/spotify/playlists");

export const previewSpotifyPlaylist = (playlistId) =>
  postData("/playlists/import/spotify/preview", { playlistId });

export const importSpotifyPlaylist = (payload) =>
  postData("/playlists/import/spotify", payload);

export const getListenBrainzPlaylists = () =>
  getData("/playlists/import/listenbrainz/playlists");

export const previewListenBrainzPlaylist = (playlistId, playlistType = null) =>
  postData("/playlists/import/listenbrainz/preview", {
    playlistId,
    ...(playlistType ? { playlistType } : {}),
  });

export const importListenBrainzPlaylist = (payload) =>
  postData("/playlists/import/listenbrainz", payload);

export const getLastfmPlaylists = (username = "") =>
  getData("/playlists/import/lastfm/playlists", {
    params: username ? { username } : undefined,
  });

export const previewLastfmPlaylist = (playlistId, username = "") =>
  postData("/playlists/import/lastfm/preview", {
    playlistId,
    username,
  });

export const importLastfmPlaylist = (payload) =>
  postData("/playlists/import/lastfm", payload);

export const syncSharedPlaylistImport = (playlistId) =>
  postData(`/playlists/shared-playlists/${encodeURIComponent(playlistId)}/sync`);

export const getFlowLidarrImportListUrl = (flowId) =>
  getData(`/playlists/flows/${encodeURIComponent(flowId)}/lidarr-import-list`);
