import { postData, putData } from "../core.js";

// Ratings and stars held in Navidrome for the signed-in user.

export const lookupTrackRatings = (tracks, { signal } = {}) =>
  postData("/navidrome-ratings/lookup", { tracks }, { signal });

export const setTrackRating = ({ trackId, albumId = null }, rating) =>
  putData("/navidrome-ratings/track", { trackId, albumId, rating });

export const setTrackStarred = ({ trackId, albumId = null }, starred) =>
  putData("/navidrome-ratings/track/star", { trackId, albumId, starred });
