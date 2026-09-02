import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Copy, FileUp, HelpCircle, X } from "lucide-react";
import { DotLoader } from "./DotLoader";
import { useModalDialog } from "../hooks/useModalDialog.js";
import { matchArtistList } from "../utils/artistListImport.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_FILES = ".txt,.csv,.tsv,.list,.md,text/plain";

const PLACEHOLDER = `Paste one artist per line, e.g.

Fleetwood Mac
The Beatles
Sigur Ros`;

const pluralize = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const STATUS_META = {
  exact: { label: "Matched", icon: Check, tone: "ok" },
  close: { label: "Check this", icon: HelpCircle, tone: "warn" },
  ambiguous: { label: "Several matches", icon: HelpCircle, tone: "warn" },
  none: { label: "Not on the server", icon: AlertTriangle, tone: "miss" },
};

// "needsLook" deliberately overlaps the buckets: a fuzzy match that was
// auto-selected still counts as an add, but it is the one people want to
// re-read before committing.
const REVIEW_FILTERS = [
  { id: "all", label: "in the list", tone: "" },
  { id: "add", label: "to add", tone: "ok" },
  { id: "needsLook", label: "to check", tone: "warn" },
  { id: "have", label: "already yours", tone: "" },
  { id: "skipped", label: "skipped", tone: "" },
  { id: "missing", label: "not on the server", tone: "miss" },
];

export default function ArtistListImportModal({ artists, pending = false, onAdd, onClose }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [results, setResults] = useState(null);
  const [selections, setSelections] = useState(() => new Map());
  const [reviewFilter, setReviewFilter] = useState("all");
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef(null);
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: true,
    onClose,
    closeDisabled: pending,
  });

  const artistsByMbid = useMemo(() => {
    const map = new Map();
    for (const artist of artists || []) {
      if (artist?.mbid) map.set(artist.mbid, artist);
    }
    return map;
  }, [artists]);

  const readFile = async (file) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError("That file is bigger than 2 MB. Trim it down or paste the names instead.");
      return;
    }
    try {
      const content = await file.text();
      setText(content);
      setFileName(file.name);
      setError("");
    } catch {
      setError("Could not read that file.");
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void readFile(file);
  };

  const handleMatch = () => {
    const matched = matchArtistList(text, artists);
    if (!matched.length) {
      setError("No artist names found in that text.");
      return;
    }
    setError("");
    setResults(matched);
    setSelections(new Map(matched.map((row) => [row.id, row.selected])));
    setReviewFilter("all");
  };

  const handleBack = () => {
    setResults(null);
    setSelections(new Map());
    setReviewFilter("all");
    setCopied(false);
  };

  const select = (rowId, mbid) => {
    setSelections((current) => {
      const next = new Map(current);
      next.set(rowId, mbid);
      return next;
    });
  };

  const resolved = useMemo(() => {
    const counts = { all: 0, add: 0, needsLook: 0, have: 0, skipped: 0, missing: 0 };
    if (!results) return { rows: [], counts, toAdd: [], missingNames: [] };
    const toAdd = new Set();
    const missingNames = [];
    const rows = results.map((row) => {
      const mbid = selections.get(row.id) || "";
      let bucket;
      if (row.status === "none") {
        bucket = "missing";
        missingNames.push(row.input);
      } else if (!mbid) {
        bucket = "skipped";
      } else if (artistsByMbid.get(mbid)?.inLibrary) {
        bucket = "have";
      } else {
        bucket = "add";
        toAdd.add(mbid);
      }
      const needsLook = row.status === "close" || row.status === "ambiguous";
      counts.all += 1;
      counts[bucket] += 1;
      if (needsLook) counts.needsLook += 1;
      return { ...row, bucket, needsLook };
    });
    return { rows, counts, toAdd: [...toAdd], missingNames };
  }, [results, selections, artistsByMbid]);

  const visibleRows = useMemo(() => {
    if (reviewFilter === "all") return resolved.rows;
    if (reviewFilter === "needsLook") return resolved.rows.filter((row) => row.needsLook);
    return resolved.rows.filter((row) => row.bucket === reviewFilter);
  }, [resolved.rows, reviewFilter]);

  const copyMissing = async () => {
    try {
      await navigator.clipboard.writeText(resolved.missingNames.join("\n"));
      setCopied(true);
    } catch {
      setError("Could not copy to the clipboard.");
    }
  };

  const handleAdd = () => {
    if (!resolved.toAdd.length) return;
    onAdd?.(resolved.toAdd);
  };

  return createPortal(
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="list-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="list-import-title"
        tabIndex={-1}
      >
        <div className="list-import__header">
          <div>
            <h3 id="list-import-title" className="list-import__title">
              Import an artist list
            </h3>
            <p className="list-import__subtitle">
              {results
                ? "Check the matches, then add them to your library."
                : "Paste a list or drop in a text file. One artist per line."}
            </p>
          </div>
          <button
            type="button"
            className="list-import__close"
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
          >
            <X className="artist-icon-xs" aria-hidden="true" />
          </button>
        </div>

        {results ? (
          <ReviewStep
            rows={visibleRows}
            counts={resolved.counts}
            filter={reviewFilter}
            onFilter={setReviewFilter}
            selections={selections}
            onSelect={select}
          />
        ) : (
          <div
            className={`list-import__drop${dragging ? " is-dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <textarea
              className="list-import__textarea"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setFileName("");
              }}
              placeholder={PLACEHOLDER}
              spellCheck={false}
              aria-label="Artist names"
            />
            <div className="list-import__drop-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className="artist-icon-sm" aria-hidden="true" />
                Choose a file
              </button>
              <span className="list-import__hint">
                {fileName || "…or drop one here. Numbering, bullets and extra columns are ignored."}
              </span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILES}
              className="list-import__file"
              onChange={(event) => {
                void readFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        )}

        {error ? <p className="list-import__error">{error}</p> : null}

        <div className="list-import__actions">
          {results && resolved.missingNames.length ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={copyMissing}>
              <Copy className="artist-icon-xs" aria-hidden="true" />
              {copied ? "Copied" : `Copy ${pluralize(resolved.missingNames.length, "name")} not found`}
            </button>
          ) : null}
          <span className="list-import__actions-spacer" />
          {results ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleBack}
              disabled={pending}
            >
              Back
            </button>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              Cancel
            </button>
          )}
          {results ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleAdd}
              disabled={!resolved.toAdd.length || pending}
            >
              {pending ? <DotLoader size="xs" label={null} /> : null}
              Add {resolved.toAdd.length || ""} to my library
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleMatch}
              disabled={!text.trim()}
            >
              Match artists
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ReviewStep({ rows, counts, filter, onFilter, selections, onSelect }) {
  return (
    <>
      <div className="list-import__summary" role="group" aria-label="Show">
        {REVIEW_FILTERS.map((option) => {
          const count = counts[option.id];
          if (!count && option.id !== "all") return null;
          const active = filter === option.id;
          return (
            <button
              key={option.id}
              type="button"
              className={`list-import__stat${option.tone ? ` list-import__stat--${option.tone}` : ""}${active ? " is-active" : ""}`}
              aria-pressed={active}
              onClick={() => onFilter(option.id)}
            >
              {count} {option.label}
            </button>
          );
        })}
      </div>
      <div className="list-import__rows" role="list">
        {rows.length ? (
          rows.map((row) => (
            <ReviewRow
              key={row.id}
              row={row}
              value={selections.get(row.id) || ""}
              onSelect={onSelect}
            />
          ))
        ) : (
          <p className="list-import__row-empty list-import__rows-empty">
            Nothing in this group any more.{" "}
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => onFilter("all")}>
              Show all
            </button>
          </p>
        )}
      </div>
    </>
  );
}

function ReviewRow({ row, value, onSelect }) {
  const selectedCandidate = row.candidates.find((candidate) => candidate.mbid === value);
  const status = selectedCandidate?.inLibrary
    ? { label: "Already in your library", icon: Check, tone: "have" }
    : !value && row.status !== "none"
      ? { label: "Skipped", icon: X, tone: "miss" }
      : STATUS_META[row.status] || STATUS_META.none;
  const StatusIcon = status.icon;

  return (
    <div className="list-import__row" role="listitem">
      <span className="list-import__row-input" title={row.input}>
        {row.input}
        {row.occurrences > 1 ? (
          <span className="list-import__row-dupes"> ×{row.occurrences}</span>
        ) : null}
      </span>
      {row.candidates.length ? (
        <select
          className="list-import__select"
          value={value}
          onChange={(event) => onSelect(row.id, event.target.value)}
          aria-label={`Match for ${row.input}`}
        >
          {row.candidates.map((candidate) => (
            <option key={candidate.mbid} value={candidate.mbid}>
              {candidate.artistName}
              {candidate.score < 1 ? ` (${Math.round(candidate.score * 100)}%)` : ""}
              {candidate.inLibrary ? " — already yours" : ""}
            </option>
          ))}
          <option value="">Skip this one</option>
        </select>
      ) : (
        <span className="list-import__row-empty">Nothing close in the main library</span>
      )}
      <span className={`list-import__chip list-import__chip--${status.tone}`}>
        <StatusIcon className="artist-icon-xs" aria-hidden="true" />
        <span>{status.label}</span>
      </span>
    </div>
  );
}
