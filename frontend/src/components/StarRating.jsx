import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useTrackRating } from "../hooks/useTrackRating.js";
import "./starRating.css";

const STARS = [1, 2, 3, 4, 5];

/**
 * Five clickable stars. Clicking the current rating clears it, as in iTunes.
 * Keyboard: arrows change, Backspace or 0 clears.
 */
export function StarRating({
  value = 0,
  onChange,
  disabled = false,
  size = "md",
  label = "Rating",
  className = "",
}) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;

  const pick = (next) => {
    if (disabled) return;
    onChange?.(next === value ? 0 : next);
  };

  const onKeyDown = (event) => {
    if (disabled) return;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      onChange?.(Math.min(5, value + 1));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      onChange?.(Math.max(0, value - 1));
    } else if (event.key === "Backspace" || event.key === "Delete" || event.key === "0") {
      event.preventDefault();
      onChange?.(0);
    } else if (/^[1-5]$/.test(event.key)) {
      event.preventDefault();
      onChange?.(Number(event.key));
    }
  };

  return (
    <div
      className={`star-rating star-rating--${size}${value ? " has-value" : ""}${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={value}
      aria-valuetext={value ? `${value} of 5 stars` : "Not rated"}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHover(0)}
      onClick={(event) => event.stopPropagation()}
    >
      {STARS.map((star) => (
        <button
          key={star}
          type="button"
          tabIndex={-1}
          className={`star-rating__star${star <= shown ? " is-on" : ""}${hover && star <= hover ? " is-hover" : ""}`}
          aria-label={`${star} star${star === 1 ? "" : "s"}`}
          disabled={disabled}
          onMouseEnter={() => setHover(star)}
          onFocus={() => setHover(star)}
          onClick={(event) => {
            event.stopPropagation();
            pick(star);
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M10 1.6l2.5 5.3 5.8.7-4.3 4 1.1 5.8L10 14.5l-5.1 2.9 1.1-5.8-4.3-4 5.8-.7z" />
          </svg>
        </button>
      ))}
    </div>
  );
}

/**
 * A canonical track's Navidrome rating, live. Renders nothing when ratings
 * are not enabled on this server or the track is unknown to Navidrome.
 */
export function TrackRating({ trackId, albumId = null, title = "", size = "md", className = "", hideUnknown = false }) {
  const { bootstrap } = useAuth();
  const { showError } = useToast();
  const enabled = bootstrap?.navidromeRatingsEnabled === true;
  const { rating, known, loading, saving, unavailable, rate } = useTrackRating(enabled ? trackId : null, albumId);
  if (!enabled || !trackId) return null;
  if (unavailable) return null;
  if (hideUnknown && !loading && !known) return null;

  const handleChange = async (next) => {
    try {
      await rate(next);
    } catch (error) {
      showError(error?.response?.data?.message || error?.message || "Could not save the rating");
    }
  };

  return (
    <StarRating
      value={rating}
      onChange={handleChange}
      disabled={loading || saving || (!known && !loading)}
      size={size}
      label={title ? `Rating for ${title}` : "Rating"}
      className={`${className}${loading ? " is-loading" : ""}${!known && !loading ? " is-unknown" : ""}`}
    />
  );
}

export default StarRating;
