import { getData, postData } from "../core.js";

// Admin tools for people's imported iTunes libraries.

const SLOW_TIMEOUT_MS = 180000;

export const getSongRecordOwners = ({ signal } = {}) => getData("/song-records/owners", { signal });

// The bundle goes up as raw bytes; the server reads gzip or plain JSON.
export const importSongRecordBundle = (file) =>
  postData("/song-records/import", file, {
    headers: { "Content-Type": "application/octet-stream" },
    timeout: SLOW_TIMEOUT_MS,
  });

export const relinkSongRecords = (owner) =>
  postData("/song-records/relink", { owner }, { timeout: SLOW_TIMEOUT_MS });

export const getMissingSongs = ({ owner, dismissed = false, duplicates = false, signal } = {}) =>
  getData("/song-records/missing", {
    signal,
    params: { owner, ...(dismissed ? { dismissed: 1 } : {}), ...(duplicates ? { duplicates: 1 } : {}) },
  });

export const getSongLinkReview = ({ owner, signal } = {}) =>
  getData("/song-records/review", { signal, params: { owner } });

export const decideSongLink = (recordId, decision) =>
  postData(`/song-records/records/${encodeURIComponent(recordId)}/link`, { decision });

export const dismissSongRecords = (ids, dismissed = true) =>
  postData("/song-records/records/dismiss", { ids, dismissed });

export const getRatingRestorePlan = ({ owner, signal } = {}) =>
  getData("/song-records/ratings/plan", { signal, timeout: SLOW_TIMEOUT_MS, params: { owner } });

export const applyRatingRestore = ({ owner, includeUnsure = false } = {}) =>
  postData("/song-records/ratings/apply", { owner, includeUnsure }, { timeout: SLOW_TIMEOUT_MS });

export const repairSplitRatings = ({ owner, dryRun = false } = {}) =>
  postData("/song-records/ratings/repair", { owner, dryRun }, { timeout: SLOW_TIMEOUT_MS });

export const getTagPlaylistReport = ({ owner, fresh = false, signal } = {}) =>
  getData("/song-records/tag-playlists", {
    signal,
    timeout: SLOW_TIMEOUT_MS,
    params: { owner, ...(fresh ? { fresh: 1 } : {}) },
  });

export const setTagPlaylistEnabled = (id, enabled) =>
  postData(`/song-records/tag-playlists/${encodeURIComponent(id)}/enabled`, { enabled }, { timeout: SLOW_TIMEOUT_MS });

export const undoTagPlaylist = (id) =>
  postData(`/song-records/tag-playlists/${encodeURIComponent(id)}/undo`, {}, { timeout: SLOW_TIMEOUT_MS });
