import { Heart } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useTrackRating } from "../hooks/useTrackRating.js";
import "./trackFavorite.css";

/**
 * A canonical track's Navidrome favourite, live. Shares the batched store with
 * the star rating, so a row showing both costs no extra lookup. Renders
 * nothing when the server has no per-user Navidrome connection or the track is
 * unknown there, matching TrackRating.
 */
export function TrackFavorite({
  trackId,
  albumId = null,
  title = "",
  className = "",
  hideUnknown = false,
}) {
  const { bootstrap } = useAuth();
  const { showError } = useToast();
  const enabled = bootstrap?.navidromeRatingsEnabled === true;
  const { starred, known, loading, saving, unavailable, star } = useTrackRating(
    enabled ? trackId : null,
    albumId,
  );
  if (!enabled || !trackId) return null;
  if (unavailable) return null;
  if (hideUnknown && !loading && !known) return null;

  const disabled = loading || saving || (!known && !loading);
  const label = starred ? "Remove from favourites" : "Add to favourites";

  const handleClick = async () => {
    try {
      await star(!starred);
    } catch (error) {
      showError(
        error?.response?.data?.message || error?.message || "Could not save the favourite",
      );
    }
  };

  return (
    <button
      type="button"
      className={
        "track-favorite"
        + (starred ? " is-active" : "")
        + (loading ? " is-loading" : "")
        + (!known && !loading ? " is-unknown" : "")
        + (className ? ` ${className}` : "")
      }
      onClick={handleClick}
      disabled={disabled}
      aria-pressed={starred}
      aria-label={title ? `${label}: ${title}` : label}
      title={label}
    >
      <Heart aria-hidden="true" fill={starred ? "currentColor" : "none"} />
    </button>
  );
}

export default TrackFavorite;
