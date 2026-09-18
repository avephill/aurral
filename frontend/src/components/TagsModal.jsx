import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import TooltipButton from "./TooltipButton";
import { DotLoader } from "./DotLoader";
import { useModalDialog } from "../hooks/useModalDialog.js";
import { useToast } from "../contexts/ToastContext";
import {
  getMyTags,
  getTagsForAlbum,
  getTagsForTrack,
  setTagsForAlbum,
  setTagsForTrack,
} from "../utils/api/endpoints/tags.js";

// Tagging one song, or a whole record at once. A tag on a record belongs to
// every song on it, including any that turn up later, so it is kept there
// rather than copied onto each song. What a song only inherits - from its
// record, or from the iTunes comment it arrived with - is shown as such: the
// source cannot be rewritten for one song, so taking it off here is recorded
// as a removal beside it.

export default function TagsModal({ subject, onClose, onSaved }) {
  const titleId = useId();
  const { showError } = useToast();
  const [tags, setTags] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [inherited, setInherited] = useState([]);
  const [known, setKnown] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const isAlbum = subject?.kind === "album";
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: Boolean(subject),
    onClose,
    closeDisabled: saving,
  });

  useEffect(() => {
    if (!subject?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    setDraft("");
    setRemoved([]);
    setInherited([]);
    const read = isAlbum ? getTagsForAlbum(subject.id) : getTagsForTrack(subject.id);
    Promise.all([read, getMyTags()])
      .then(([mine, all]) => {
        if (cancelled) return;
        setTags(Array.isArray(mine?.tags) ? mine.tags.filter((tag) => !tag.startsWith("-")) : []);
        setRemoved(Array.isArray(mine?.removed) ? mine.removed : []);
        setInherited(Array.isArray(mine?.inherited) ? mine.inherited : []);
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
  }, [isAlbum, subject?.id]);

  if (!subject) return null;

  const add = (value) => {
    const tag = String(value || "").trim().toLowerCase();
    if (!tag || tags.includes(tag)) return;
    // Putting back one that was taken off means it applies again, so the note
    // recording the removal goes with it.
    setRemoved(removed.filter((entry) => entry !== tag));
    setInherited(inherited.filter((entry) => entry.tag !== tag));
    setTags([...tags, tag]);
    setDraft("");
  };

  const dropInherited = (tag) => {
    setInherited(inherited.filter((entry) => entry.tag !== tag));
    setRemoved(removed.includes(tag) ? removed : [...removed, tag]);
  };

  const save = async () => {
    setSaving(true);
    try {
      if (isAlbum) {
        await setTagsForAlbum(subject.id, tags);
      } else {
        await setTagsForTrack(subject.id, [...tags, ...removed.map((tag) => `-${tag}`)]);
      }
      onSaved?.(tags);
      onClose?.();
    } catch (error) {
      showError(error.response?.data?.error || error.message || "Could not save those tags");
    } finally {
      setSaving(false);
    }
  };

  const taken = new Set([...tags, ...inherited.map((entry) => entry.tag)]);
  const suggestions = known.filter((tag) => !taken.has(tag)).slice(0, 12);

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
            <h2 id={titleId} className="artist-modal__title">{subject.title}</h2>
            {subject.subtitle ? <p className="recommend-modal__subtitle">{subject.subtitle}</p> : null}
          </div>
          <TooltipButton className="btn btn-ghost btn-icon-square" onClick={onClose} label="Close" disabled={saving}>
            <X className="artist-icon-md" aria-hidden="true" />
          </TooltipButton>
        </div>

        {loading ? (
          <DotLoader label={isAlbum ? "Reading its tags" : "Reading its tags"} />
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
              {inherited.map((entry) => (
                <span className="people-picker__chip track-tags__chip--inherited" key={`from-${entry.tag}`}>
                  {entry.tag}
                  <em>from {entry.from}</em>
                  <button
                    type="button"
                    aria-label={`Take ${entry.tag} off this song`}
                    onClick={() => dropInherited(entry.tag)}
                    disabled={saving}
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={draft}
                placeholder={taken.size ? "" : "Type a tag and press enter"}
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
              {isAlbum
                ? "Every song on this record counts as tagged, including any added to it later, so a smart playlist built on one of these picks up the whole record."
                : "Smart playlists read these, so one added here can put a song into a playlist that keeps itself."}
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
