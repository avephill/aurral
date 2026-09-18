import { getData, postData, putData } from "../core.js";

// Tagging songs. The tags an iTunes library arrived with are read-only
// history; these sit over them and are the only ones newer music can have.

export const getMyTags = (options = {}) => getData("/tags", options);

export const getTracksWithTag = (tag, options = {}) =>
  getData("/tags/tracks", { ...options, params: { tag } });

export const getTagsForTrack = (trackId, options = {}) =>
  getData(`/tags/track/${encodeURIComponent(trackId)}`, options);

export const setTagsForTrack = (trackId, tags) =>
  putData(`/tags/track/${encodeURIComponent(trackId)}`, { tags });

export const applyTag = ({ trackIds, tag, remove = false }) =>
  postData("/tags/apply", { trackIds, tag, remove });

export const renameTag = ({ from, to }) => postData("/tags/rename", { from, to });

export const deleteTag = (tag) => renameTag({ from: tag, to: "" });
