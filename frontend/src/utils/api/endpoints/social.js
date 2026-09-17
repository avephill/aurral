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
