import { useEffect, useMemo, useState } from "react";
import { History } from "lucide-react";
import { ModalShell } from "../../../components/PlaylistModals";
import { DotLoader } from "../../../components/DotLoader";
import { useToast } from "../../../contexts/ToastContext";
import {
  compareLibrarySnapshot,
  getLibraryHistory,
  restoreLibrarySnapshot,
  takeLibrarySnapshot,
} from "../../../utils/api/endpoints/auth.js";
import "./libraryHistory.css";

// One person's library history: a copy of their playlists, ratings,
// favourites, tags and library taken each day, what is different now from
// any of them, and putting parts back. A copy of how things are is taken
// before every restore, so a restore can be undone the same way.

const errorText = (error, fallback) => error?.response?.data?.error || error?.message || fallback;
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const when = (value) => new Date(value).toLocaleString(undefined, {
  weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});
const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(bytes < 1_000_000 ? 2 : 1)} MB`;

const SECTION_LABELS = {
  playlists: "Playlists",
  ratings: "Ratings",
  favourites: "Favourites",
  tags: "Tags",
  library: "Library",
};

function describePlaylist(change) {
  switch (change.change) {
    case "gone": return change.songs != null ? `deleted since (had ${plural(change.songs, "song")})` : "deleted since";
    case "new": return "made since - left alone";
    case "songs": {
      const parts = [];
      if (change.removed) parts.push(`${change.removed} taken out`);
      if (change.added) parts.push(`${change.added} added`);
      if (!parts.length) parts.push("reordered");
      return `${parts.join(", ")} (${change.then} then, ${change.now} now)`;
    }
    case "rules": return "its rules have changed";
    case "kind": return "changed from a list into a smart playlist, or back";
    case "folder": return `moved from ${change.then || "the top"} to ${change.now || "the top"}`;
    default: return "changed";
  }
}

function sectionSummary(section, difference) {
  if (difference == null) return "Not in this snapshot";
  switch (section) {
    case "ratings":
      return difference.total
        ? [
          difference.changed && `${plural(difference.changed, "song")} rated differently`,
          difference.cleared && `${difference.cleared} rated then, not now`,
          difference.added && `${difference.added} rated since`,
        ].filter(Boolean).join(", ")
        : "";
    case "favourites":
      return difference.added || difference.removed
        ? [difference.removed && `${difference.removed} no longer favourites`, difference.added && `${difference.added} new favourites`]
          .filter(Boolean).join(", ")
        : "";
    case "tags": {
      if (!difference.songs && !difference.albums) return "";
      const head = [difference.songs && `${plural(difference.songs, "song")} tagged differently`, difference.albums && `${plural(difference.albums, "record")}`]
        .filter(Boolean).join(", ");
      const detail = difference.tags.slice(0, 6).map((entry) => `${entry.tag}: ${entry.then} → ${entry.now}`).join("; ");
      return detail ? `${head} - ${detail}${difference.moreTags ? `, and ${difference.moreTags} more` : ""}` : head;
    }
    case "library": {
      const parts = [
        difference.artistsRemoved.length && `${plural(difference.artistsRemoved.length, "artist")} taken out (${difference.artistsRemoved.slice(0, 4).join(", ")}${difference.artistsRemoved.length > 4 ? "…" : ""})`,
        difference.artistsAdded.length && `${plural(difference.artistsAdded.length, "artist")} added since`,
        difference.albumsRemoved.length && `${plural(difference.albumsRemoved.length, "album")} taken out`,
        difference.albumsAdded.length && `${plural(difference.albumsAdded.length, "album")} added since`,
      ].filter(Boolean);
      return parts.join(", ");
    }
    default: return "";
  }
}

export function LibraryHistoryModal({ user, onClose }) {
  const { showError, showSuccess } = useToast();
  const [history, setHistory] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState("");
  const [sections, setSections] = useState(() => new Set());
  const [playlists, setPlaylists] = useState(() => new Set());

  const load = () => getLibraryHistory(user.id)
    .then(setHistory)
    .catch((error) => showError(errorText(error, "Could not read the history")));

  useEffect(() => {
    if (user) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const compare = async (snapshotId) => {
    setSelectedId(snapshotId);
    setComparison(null);
    setComparing(true);
    try {
      const result = await compareLibrarySnapshot(user.id, snapshotId);
      setComparison(result);
      // Everything that differs is ticked; a playlist made since is not
      // something a snapshot can put back.
      const differing = Object.entries(result.differences)
        .filter(([section, difference]) => difference && (section === "playlists"
          ? difference.some((change) => change.change !== "new")
          : sectionSummary(section, difference)))
        .map(([section]) => section);
      setSections(new Set(differing));
      setPlaylists(new Set((result.differences.playlists || [])
        .filter((change) => change.change !== "new").map((change) => change.name)));
    } catch (error) {
      showError(errorText(error, "Could not compare that day with now"));
      setSelectedId(null);
    } finally {
      setComparing(false);
    }
  };

  const takeNow = async () => {
    setBusy("snapshot");
    try {
      const result = await takeLibrarySnapshot(user.id);
      showSuccess(result.unchanged ? "Snapshot taken - nothing has changed since the last one" : "Snapshot taken");
      await load();
    } catch (error) {
      showError(errorText(error, "Could not take a snapshot"));
    } finally {
      setBusy("");
    }
  };

  const restore = async () => {
    setBusy("restore");
    try {
      const result = await restoreLibrarySnapshot(user.id, selectedId, {
        sections: [...sections],
        playlists: [...playlists],
      });
      const missing = (result.results.playlists || []).reduce((sum, entry) => sum + (entry.missing || 0), 0);
      showSuccess(`Restored ${[...sections].map((section) => SECTION_LABELS[section].toLowerCase()).join(", ")}.${
        missing ? ` ${plural(missing, "song")} from those playlists are no longer on the server.` : ""} The way things were just before is snapshot ${result.undoSnapshot}.`);
      setComparison(null);
      setSelectedId(null);
      await load();
    } catch (error) {
      showError(errorText(error, "Could not restore"));
    } finally {
      setBusy("");
    }
  };

  const toggle = (setter, value) => setter((current) => {
    const next = new Set(current);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  });

  const ready = sections.size > 0 && (!sections.has("playlists") || playlists.size > 0);
  const snapshots = useMemo(() => history?.snapshots || [], [history]);

  return (
    <ModalShell
      open={Boolean(user)}
      title={`${user?.username}'s library history`}
      description="A copy of their playlists, ratings, favourites, tags and library is kept each day: every day for a month, then one a month for a year."
      onClose={onClose}
      disableClose={busy === "restore"}
      className="library-history"
      footer={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={takeNow} disabled={Boolean(busy)}>
            {busy === "snapshot" ? <DotLoader size="xs" label={null} /> : <History className="artist-icon-sm" aria-hidden="true" />}
            Take a snapshot now
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy === "restore"}>
            Close
          </button>
          {comparison ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={restore} disabled={!ready || Boolean(busy)}>
              {busy === "restore" ? <DotLoader size="xs" label={null} /> : null}
              Restore what is ticked
            </button>
          ) : null}
        </>
      )}
    >
      {!history ? (
        <DotLoader label="Reading the history" />
      ) : (
        <div className="library-history__body">
          <ul className="library-history__list" aria-label="Snapshots">
            {snapshots.length === 0 ? <li className="library-history__muted">None yet. The first is taken within the hour.</li> : null}
            {snapshots.map((snapshot) => (
              <li key={snapshot.id}>
                <button
                  type="button"
                  className={snapshot.id === selectedId ? "is-selected" : ""}
                  onClick={() => compare(snapshot.id)}
                  disabled={comparing || Boolean(busy)}
                >
                  <span className="library-history__when">{when(snapshot.takenAt)}</span>
                  <span className="library-history__meta">
                    {snapshot.reason === "daily" ? "" : `${snapshot.reason} · `}
                    {snapshot.changed.length === 5 && snapshot === snapshots[snapshots.length - 1]
                      ? "the first"
                      : snapshot.changed.length ? `${snapshot.changed.map((section) => SECTION_LABELS[section].toLowerCase()).join(", ")} changed` : "nothing changed"}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="library-history__detail">
            {comparing ? (
              <DotLoader label="Comparing that day with now" />
            ) : !comparison ? (
              <p className="library-history__muted">
                Choose a day to see what is different now, and put back what should not have changed.
                {history.storage ? ` Everyone's history takes ${megabytes(history.storage.bytes)}.` : ""}
              </p>
            ) : (
              <>
                <p className="library-history__muted">Compared with now, on {when(comparison.snapshot.takenAt)}:</p>
                {Object.keys(SECTION_LABELS).map((section) => {
                  const difference = comparison.differences[section];
                  if (section === "playlists") {
                    const changes = difference || [];
                    return (
                      <fieldset key={section} className="library-history__section">
                        <legend>
                          <label>
                            <input
                              type="checkbox"
                              checked={sections.has("playlists")}
                              disabled={!changes.some((change) => change.change !== "new")}
                              onChange={() => toggle(setSections, "playlists")}
                            />
                            Playlists
                          </label>
                        </legend>
                        {changes.length === 0 ? <p className="library-history__muted">Same as now.</p> : (
                          <ul>
                            {changes.map((change) => (
                              <li key={change.name}>
                                <label className={change.change === "new" ? "is-info" : ""}>
                                  {change.change !== "new" ? (
                                    <input
                                      type="checkbox"
                                      checked={playlists.has(change.name)}
                                      disabled={!sections.has("playlists")}
                                      onChange={() => toggle(setPlaylists, change.name)}
                                    />
                                  ) : <span className="library-history__spacer" />}
                                  <strong>{change.name}</strong>
                                  <span>{describePlaylist(change)}</span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        )}
                      </fieldset>
                    );
                  }
                  const summary = sectionSummary(section, difference);
                  return (
                    <fieldset key={section} className="library-history__section">
                      <legend>
                        <label>
                          <input
                            type="checkbox"
                            checked={sections.has(section)}
                            disabled={!summary}
                            onChange={() => toggle(setSections, section)}
                          />
                          {SECTION_LABELS[section]}
                        </label>
                      </legend>
                      <p className={summary ? "" : "library-history__muted"}>{summary || "Same as now."}</p>
                    </fieldset>
                  );
                })}
                <p className="library-history__muted">
                  Restoring puts back what is ticked, as it was that day. A snapshot of how things are now is taken
                  first, so a restore can be undone from this list.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </ModalShell>
  );
}

export default LibraryHistoryModal;
