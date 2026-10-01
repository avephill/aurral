import { deleteData, getData, postData, putData } from "../core.js";

// The Social page: shared playlists, recommendations, and what people play.

const SLOW_TIMEOUT_MS = 120000;

export const getSocialOverview = ({ signal } = {}) => getData("/social/overview", { signal });

export const getListeningHighlights = ({ signal } = {}) =>
  getData("/social/highlights", { signal, timeout: SLOW_TIMEOUT_MS });

export const sharePlaylistWith = (playlistId, recipients) =>
  postData(`/social/playlists/${encodeURIComponent(playlistId)}/share`, { recipients }, { timeout: SLOW_TIMEOUT_MS });

export const syncShare = (id) =>
  postData(`/social/shares/${encodeURIComponent(id)}/sync`, {}, { timeout: SLOW_TIMEOUT_MS });

export const stopSharing = (id, { deleteCopy = false } = {}) =>
  deleteData(`/social/shares/${encodeURIComponent(id)}`, { params: deleteCopy ? { deleteCopy: 1 } : {} });

export const sendRecommendation = ({ kind, targetId, note, recipients }) =>
  postData("/social/recommendations", { kind, targetId, note, recipients });

export const markRecommendationsRead = () => postData("/social/recommendations/read", {});

export const dismissRecommendation = (id) =>
  postData(`/social/recommendations/${encodeURIComponent(id)}/dismiss`, {});

export const withdrawRecommendation = (id) =>
  deleteData(`/social/recommendations/${encodeURIComponent(id)}`);

export const setShareListening = (shareListening) => putData("/social/settings", { shareListening });

// Playlists built together: the list lives in Psalter and each member holds a
// copy, so what they do to theirs is read back on the next pass.

export const createCollabPlaylist = ({ name, members, fromPlaylistId }) =>
  postData("/social/collabs", { name, members, fromPlaylistId }, { timeout: SLOW_TIMEOUT_MS });

export const syncCollabPlaylist = (id) =>
  postData(`/social/collabs/${encodeURIComponent(id)}/sync`, {}, { timeout: SLOW_TIMEOUT_MS });

export const addCollabMember = (id, username) =>
  postData(`/social/collabs/${encodeURIComponent(id)}/members`, { username }, { timeout: SLOW_TIMEOUT_MS });

export const leaveCollabPlaylist = (id, username) =>
  deleteData(`/social/collabs/${encodeURIComponent(id)}/members/${encodeURIComponent(username)}`);

export const endCollabPlaylist = (id) => deleteData(`/social/collabs/${encodeURIComponent(id)}`);

// What adding a shared playlist would put into your library, and adding it.
export const previewShare = (id, { signal } = {}) =>
  getData(`/social/shares/${encodeURIComponent(id)}/preview`, { signal, timeout: SLOW_TIMEOUT_MS });

export const acceptShare = (id) =>
  postData(`/social/shares/${encodeURIComponent(id)}/accept`, {}, { timeout: SLOW_TIMEOUT_MS });

// Playlists shown to a congregation, for anyone there to take a copy of.
export const showPlaylistTo = (playlistId, congregationIds) =>
  postData(`/social/playlists/${encodeURIComponent(playlistId)}/list`, { congregationIds }, { timeout: SLOW_TIMEOUT_MS });

export const stopShowingPlaylist = (id) => deleteData(`/social/listings/${encodeURIComponent(id)}`);

export const previewListing = (id, { signal } = {}) =>
  getData(`/social/listings/${encodeURIComponent(id)}/preview`, { signal, timeout: SLOW_TIMEOUT_MS });

export const takeListing = (id) =>
  postData(`/social/listings/${encodeURIComponent(id)}/take`, {}, { timeout: SLOW_TIMEOUT_MS });

// The albums a collaborative playlist's songs need, for a member missing some.
export const previewCollabAlbums = (id, { signal } = {}) =>
  getData(`/social/collabs/${encodeURIComponent(id)}/albums`, { signal, timeout: SLOW_TIMEOUT_MS });

export const addCollabAlbums = (id) =>
  postData(`/social/collabs/${encodeURIComponent(id)}/albums`, {}, { timeout: SLOW_TIMEOUT_MS });
