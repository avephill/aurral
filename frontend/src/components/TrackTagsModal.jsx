import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import TooltipButton from "./TooltipButton";
import { DotLoader } from "./DotLoader";
import { useModalDialog } from "../hooks/useModalDialog.js";
import { useToast } from "../contexts/ToastContext";
import { getMyTags, getTagsForTrack, setTagsForTrack } from "../utils/api/endpoints/tags.js";

// Tagging one song. The tags an iTunes library brought are shown as they are
// and can be taken off; anything added here is the person's own.

export default function TrackTagsModal({ track, onClose, onSaved }) {
  const titleId = useId();
  const { showError } = useToast();
  const [tags, setTags] = useState([]);
  const [known, setKnown] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: Boolean(track),
    onClose,
    closeDisabled: saving,
  });

  useEffect(() => {
    if (!track?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    setDraft("");
    Promise.all([getTagsForTrack(track.id), getMyTags()])
      .then(([mine, all]) => {
        if (cancelled) return;
        setTags(Array.isArray(mine?.tags) ? mine.tags.filter((tag) => !tag.startsWith("-")) : []);
        setKnown((all?.tags || []).map((entry) => entry.tag));
      })
      .catch(() => {
        if (!cancelled) setTags([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [track?.id]);

  if (!track) return null;

  const add = (value) => {
    const tag = String(value || "").trim().toLowerCase();
    if (!tag || tags.includes(tag)) return;
    setTags([...tags, tag]);
    setDraft("");
  };

  const save = async () => {
    setSaving(true);
    try {
      await setTagsForTrack(track.id, tags);
      onSaved?.(tags);
      onClose?.();
    } catch (error) {
      showError(error.response?.data?.error || error.message || "Could not save those tags");
    } finally {
      setSaving(false);
    }
  };

  const suggestions = known.filter((tag) => !tags.includes(tag)).slice(0, 12);

  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <section
        ref={dialogRef}
        className="artist-modal recommend-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="artist-modal__header">
          <div>
            <p className="activity-info-modal__eyebrow">Tags</p>
            <h2 id={titleId} className="artist-modal__title">{track.title}</h2>
            {track.subtitle ? <p className="recommend-modal__subtitle">{track.subtitle}</p> : null}
          </div>
          <TooltipButton className="btn btn-ghost btn-icon-square" onClick={onClose} label="Close" disabled={saving}>
            <X className="artist-icon-md" aria-hidden="true" />
          </TooltipButton>
        </div>

        {loading ? (
          <DotLoader label="Reading its tags" />
        ) : (
          <>
            <div className="people-picker__field" role="presentation">
              {tags.map((tag) => (
                <span className="people-picker__chip" key={tag}>
                  {tag}
                  <button
                    type="button"
                    aria-label={`Take off ${tag}`}
                    onClick={() => setTags(tags.filter((entry) => entry !== tag))}
                    disabled={saving}
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={draft}
                placeholder={tags.length ? "" : "Type a tag and press enter"}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === ",") {
                    event.preventDefault();
                    add(draft);
                  }
                  if (event.key === "Backspace" && !draft && tags.length) {
                    setTags(tags.slice(0, -1));
                  }
                }}
                disabled={saving}
                aria-label="Add a tag"
                autoComplete="off"
              />
            </div>
            {suggestions.length ? (
              <div className="track-tags__suggestions">
                {suggestions.map((tag) => (
                  <button
                    type="button"
                    key={tag}
                    className="btn btn-secondary btn-xs"
                    onClick={() => add(tag)}
                    disabled={saving}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="recommend-modal__hint">
              Smart playlists read these, so one added here can put a song into a playlist that keeps itself.
            </p>
          </>
        )}

        <div className="recommend-modal__actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving || loading}>
            {saving ? "Saving..." : "Save tags"}
          </button>
        </div>
      </section>
    </div>
  );
}
