import { useEffect, useId, useMemo, useState } from "react";
import { X } from "lucide-react";
import TooltipButton from "./TooltipButton";
import { DotLoader } from "./DotLoader";
import { useModalDialog } from "../hooks/useModalDialog.js";
import { useToast } from "../contexts/ToastContext";

// Taking a playlist into your account can put albums into your library, so
// this says which before anything is added. No changes nothing.
//
// `request` says what is being taken: a heading, how to ask what it needs
// (load), and how to say yes (confirm). A shared playlist, one shown to a
// congregation, and one built together all come through here.

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const errorText = (error, fallback) => error?.response?.data?.error || error?.message || fallback;

export default function AddSharedPlaylistModal({ request, onClose, onAdded }) {
  const titleId = useId();
  const { showError, showSuccess } = useToast();
  const [plan, setPlan] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [adding, setAdding] = useState(false);
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: Boolean(request),
    onClose,
    closeDisabled: adding,
  });

  useEffect(() => {
    if (!request) return undefined;
    const controller = new AbortController();
    setPlan(null);
    setLoadError("");
    request.load({ signal: controller.signal })
      .then(setPlan)
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(errorText(error, "Could not work out what this playlist needs"));
      });
    return () => controller.abort();
  }, [request]);

  const byArtist = useMemo(() => {
    const groups = new Map();
    for (const album of plan?.albums || []) {
      if (!groups.has(album.artist)) groups.set(album.artist, []);
      groups.get(album.artist).push(album);
    }
    return [...groups];
  }, [plan]);

  if (!request) return null;

  const albums = plan?.albums?.length || 0;

  const add = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const result = await request.confirm();
      showSuccess(result?.albumsAdded
        ? `Added. ${plural(result.albumsAdded, "album")} are on their way into your library, and the playlist fills in as they arrive - usually a few minutes.`
        : request.done || "Added.");
      onAdded?.();
      onClose?.();
    } catch (error) {
      showError(errorText(error, "Could not add the playlist"));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <section
        ref={dialogRef}
        className="artist-modal recommend-modal add-shared-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="artist-modal__header">
          <div>
            <p className="activity-info-modal__eyebrow">{request.eyebrow || "Shared playlist"}</p>
            <h2 id={titleId} className="artist-modal__title">{request.heading}</h2>
          </div>
          <TooltipButton className="btn btn-ghost btn-icon-square" onClick={onClose} label="Close" disabled={adding}>
            <X className="artist-icon-md" aria-hidden="true" />
          </TooltipButton>
        </div>

        {loadError ? (
          <p className="social__warning">{loadError}</p>
        ) : !plan ? (
          <DotLoader label="Checking your library" />
        ) : (
          <>
            {plan.missing === 0 ? (
              <p className="artist-modal__copy">
                You already have all {plural(plan.songs, "song")} in it. Nothing will be added to your library.
              </p>
            ) : albums ? (
              <p className="artist-modal__copy">
                {plan.missing} of its {plural(plan.songs, "song")} aren&apos;t in your library. Adding it puts{" "}
                <strong>{plural(albums, "album")} by {plural(plan.artists, "artist")}</strong> into your
                personal library.
              </p>
            ) : null}
            {albums ? (
              <details className="add-shared-modal__albums">
                <summary>See the albums</summary>
                <ul>
                  {byArtist.map(([artist, list]) => (
                    <li key={artist}>
                      <span className="add-shared-modal__artist">{artist}</span>
                      <ul>
                        {list.map((album) => (
                          <li key={album.folder}>
                            {album.album}
                            <span className="social__muted"> · {plural(album.songs, "song")} on the playlist</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {plan.unavailable ? (
              <p className="artist-modal__subcopy">
                {plural(plan.unavailable, "song")} can&apos;t be added to your library and will be left out.
              </p>
            ) : null}
          </>
        )}

        <div className="recommend-modal__actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={adding}>
            No
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={add} disabled={adding || !plan}>
            {adding ? "Adding..." : albums ? "Yes, add them" : "Yes, add it"}
          </button>
        </div>
      </section>
    </div>
  );
}
