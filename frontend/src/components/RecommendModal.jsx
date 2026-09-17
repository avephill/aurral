import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import TooltipButton from "./TooltipButton";
import { DotLoader } from "./DotLoader";
import { useModalDialog } from "../hooks/useModalDialog.js";
import PeoplePicker from "./PeoplePicker";
import { useToast } from "../contexts/ToastContext";
import { getSocialOverview, sendRecommendation } from "../utils/api/endpoints/social.js";

// Pointing someone at a record you are already looking at. The Social page can
// do this too, but it means searching for something you had in front of you.

const MAX_NOTE = 500;

export default function RecommendModal({ target, onClose }) {
  const titleId = useId();
  const { showError, showSuccess } = useToast();
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(false);
  const [recipients, setRecipients] = useState([]);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: Boolean(target),
    onClose,
    closeDisabled: sending,
  });

  useEffect(() => {
    if (!target) return undefined;
    let cancelled = false;
    setLoading(true);
    setRecipients([]);
    setNote("");
    getSocialOverview({})
      .then((data) => {
        if (!cancelled) setPeople(Array.isArray(data?.people) ? data.people : []);
      })
      .catch(() => {
        if (!cancelled) setPeople([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!target) return null;

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      const result = await sendRecommendation({
        kind: target.kind,
        targetId: target.id,
        note,
        recipients,
      });
      showSuccess(
        result?.toEveryone
          ? `Recommended ${target.title} to everyone`
          : `Recommended ${target.title} to ${recipients.join(", ")}`,
      );
      onClose?.();
    } catch (error) {
      showError(
        error.response?.data?.error ||
          error.response?.data?.message ||
          error.message ||
          "Could not send the recommendation",
      );
    } finally {
      setSending(false);
    }
  };

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
            <p className="activity-info-modal__eyebrow">
              Recommend {target.kind === "album" ? "album" : "song"}
            </p>
            <h2 id={titleId} className="artist-modal__title">{target.title}</h2>
            {target.subtitle ? <p className="recommend-modal__subtitle">{target.subtitle}</p> : null}
          </div>
          <TooltipButton
            className="btn btn-ghost btn-icon-square"
            onClick={onClose}
            label="Close"
            disabled={sending}
          >
            <X className="artist-icon-md" aria-hidden="true" />
          </TooltipButton>
        </div>

        {loading ? (
          <DotLoader label="Loading people" />
        ) : people.length ? (
          <label className="recommend-modal__field">
            <span>Send to</span>
            <PeoplePicker
              people={people}
              value={recipients}
              onChange={setRecipients}
              disabled={sending}
              placeholder="Type a name, or leave empty for everyone"
              emptyHint="Nobody chosen, so this goes to everyone."
            />
          </label>
        ) : (
          <p className="recommend-modal__hint">
            Nobody else has an account yet, so this would go to everyone.
          </p>
        )}

        <label className="recommend-modal__field">
          <span>Note (optional)</span>
          <textarea
            value={note}
            maxLength={MAX_NOTE}
            rows={3}
            placeholder="Why they should hear it"
            onChange={(event) => setNote(event.target.value)}
            disabled={sending}
          />
        </label>

        <div className="recommend-modal__actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={send} disabled={sending}>
            {sending ? "Sending..." : recipients.length ? "Send" : "Send to everyone"}
          </button>
        </div>
      </section>
    </div>
  );
}
