import { useEffect, useState } from "react";
import { Check, Users } from "lucide-react";
import { DotLoader } from "./DotLoader";
import {
  getCongregations,
  joinCongregation,
  leaveCongregation,
} from "../utils/api/endpoints/congregations.js";
import "./congregations.css";

// Which groups of people someone shares with. Only the open ones can be
// joined here; the ones an admin assigns are shown as a statement of fact,
// because being in Family is not something to opt into.

export default function CongregationPicker({ compact = false, onChanged }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");

  const read = () =>
    getCongregations()
      .then((data) => setRows(data?.visible || []))
      .catch(() => setRows([]));

  useEffect(() => {
    read();
  }, []);

  const toggle = async (entry) => {
    setBusy(entry.id);
    setError("");
    try {
      if (entry.joined) await leaveCongregation(entry.id);
      else await joinCongregation(entry.id);
      await read();
      onChanged?.();
    } catch (problem) {
      setError(problem?.response?.data?.error || problem?.message || "Could not change that");
    } finally {
      setBusy(null);
    }
  };

  if (rows === null) return <DotLoader size="sm" label="Reading your congregations" />;
  if (!rows.length) {
    return (
      <p className="congregations__empty">
        Nobody has set any up yet, so nothing you make goes anywhere. An admin can add one.
      </p>
    );
  }

  return (
    <div className={`congregations${compact ? " congregations--compact" : ""}`}>
      <ul className="congregations__list">
        {rows.map((entry) => {
          const canChoose = entry.enrollment === "open";
          return (
            <li key={entry.id} className={entry.joined ? "is-in" : ""}>
              <div className="congregations__copy">
                <span className="congregations__name">
                  <Users aria-hidden="true" />
                  {entry.name}
                  {entry.joined ? <Check className="congregations__tick" aria-hidden="true" /> : null}
                </span>
                <span className="congregations__meta">
                  {entry.memberCount === 1 ? "just you so far" : `${entry.memberCount} people`}
                  {entry.description ? ` · ${entry.description}` : ""}
                </span>
              </div>
              {canChoose ? (
                <button
                  type="button"
                  className={`btn btn-${entry.joined ? "secondary" : "primary"} btn-xs`}
                  onClick={() => toggle(entry)}
                  disabled={busy === entry.id}
                >
                  {entry.joined ? "Leave" : "Join"}
                </button>
              ) : (
                <span className="congregations__assigned">
                  {entry.joined ? "you were put in this one" : ""}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {error ? <p className="congregations__error">{error}</p> : null}
    </div>
  );
}
