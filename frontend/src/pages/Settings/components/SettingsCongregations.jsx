import { useEffect, useState } from "react";
import { Plus, Trash2, Users } from "lucide-react";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { SettingsInput, SettingsSelect } from "./SettingsField";
import { DotLoader } from "../../../components/DotLoader";
import PillToggle from "../../../components/PillToggle";
import {
  createCongregation,
  getCongregations,
  removeCongregation,
  setCongregationMembers,
  updateCongregation,
} from "../../../utils/api/endpoints/congregations.js";

// Who reaches whom. A congregation is a group of people who share with each
// other; what someone sends goes to everyone in every congregation they are
// in, and nowhere else. The library is not scoped by any of this.
//
// The two kinds differ only in who may join, which is the part that decides
// whether one protects anybody: an open one anyone can put themselves in, an
// assigned one is invisible outside itself and filled from here.

const BLANK = { name: "", description: "", enrollment: "assigned", members: [] };

const errorText = (error, fallback) =>
  error?.response?.data?.error || error?.message || fallback;

export function SettingsCongregations({ usersList = [] }) {
  const [rows, setRows] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const usernames = usersList.map((user) => user.username).filter(Boolean);

  const read = () =>
    getCongregations()
      .then((data) => setRows(data?.visible || []))
      .catch((problem) => {
        setError(errorText(problem, "Could not read the congregations"));
        setRows([]);
      });

  useEffect(() => {
    read();
  }, []);

  const edit = (row) =>
    setDraft(row
      ? { id: row.id, name: row.name, description: row.description, enrollment: row.enrollment, members: row.members }
      : { ...BLANK });

  const toggleMember = (username) =>
    setDraft((current) => ({
      ...current,
      members: current.members.includes(username)
        ? current.members.filter((entry) => entry !== username)
        : [...current.members, username],
    }));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (draft.id) {
        await updateCongregation(draft.id, {
          name: draft.name,
          description: draft.description,
          enrollment: draft.enrollment,
        });
        await setCongregationMembers(draft.id, draft.members);
      } else {
        await createCongregation(draft);
      }
      setDraft(null);
      await read();
    } catch (problem) {
      setError(errorText(problem, "Could not save that"));
    } finally {
      setBusy(false);
    }
  };

  const drop = async (row) => {
    setBusy(true);
    setError("");
    try {
      await removeCongregation(row.id);
      await read();
    } catch (problem) {
      setError(errorText(problem, "Could not remove that one"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsArrFieldSet
      legend="Congregations"
      actions={
        <button type="button" className="arr-btn arr-btn--primary" onClick={() => edit(null)} disabled={busy}>
          <Plus className="artist-icon-xs" aria-hidden />
          New congregation
        </button>
      }
    >
      <p className="arr-form-help">
        A group of people who share with each other. Recommendations, shared playlists and what
        someone has been playing reach everyone in every congregation that person is in, and nobody
        else. The music on the server stays the same for everybody.
      </p>

      {rows === null ? (
        <DotLoader size="sm" label="Reading congregations" />
      ) : (
        <div className="arr-table-wrap">
          <table className="arr-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Who can join</th>
                <th scope="col">People</th>
                <th scope="col" className="arr-table__actions-head">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!rows.length ? (
                <tr className="arr-table__empty-row">
                  <td colSpan={4}>
                    None yet. Without one, nothing anybody shares reaches anybody.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Users className="artist-icon-xs" aria-hidden /> {row.name}
                      {row.description ? (
                        <span className="arr-table__path"> {row.description}</span>
                      ) : null}
                    </td>
                    <td>{row.enrollment === "open" ? "Anyone" : "Only who you put in"}</td>
                    <td>{row.members.join(", ") || "nobody"}</td>
                    <td className="arr-table__actions">
                      <div className="arr-table__actions-inner">
                        <button type="button" className="arr-btn arr-btn--ghost" onClick={() => edit(row)} disabled={busy}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="arr-btn arr-btn--ghost arr-btn--icon"
                          aria-label={`Remove ${row.name}`}
                          onClick={() => drop(row)}
                          disabled={busy}
                        >
                          <Trash2 className="artist-icon-sm" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {draft ? (
        <div className="arr-form">
          <SettingsArrFormGroup label="Name" labelFor="congregation-name">
            <SettingsInput
              id="congregation-name"
              value={draft.name}
              autoFocus
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </SettingsArrFormGroup>

          <SettingsArrFormGroup label="Description" labelFor="congregation-description">
            <SettingsInput
              id="congregation-description"
              value={draft.description}
              placeholder="Optional"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </SettingsArrFormGroup>

          <SettingsArrFormGroup
            label="Who can join"
            labelFor="congregation-enrollment"
            help="An assigned one is invisible to anyone outside it, which is what keeps a household separate from a family."
          >
            <SettingsSelect
              id="congregation-enrollment"
              value={draft.enrollment}
              onChange={(event) => setDraft({ ...draft, enrollment: event.target.value })}
            >
              <option value="assigned">Only who you put in</option>
              <option value="open">Anyone, when they sign in</option>
            </SettingsSelect>
          </SettingsArrFormGroup>

          <SettingsArrFormGroup
            label="People"
            help="Anyone can also take themselves out of one, whoever put them there."
            size="large"
          >
            <div className="arr-permissions">
              {usernames.map((username) => (
                <div key={username} className="settings-toggle-row">
                  <span>{username}</span>
                  <PillToggle
                    className="settings-toggle"
                    checked={draft.members.includes(username)}
                    onChange={() => toggleMember(username)}
                    aria-label={username}
                  />
                </div>
              ))}
            </div>
          </SettingsArrFormGroup>

          <div className="arr-form-actions">
            <button
              type="button"
              className="arr-btn arr-btn--primary"
              onClick={save}
              disabled={busy || !draft.name.trim()}
            >
              {busy ? <DotLoader size="sm" label={null} /> : null}
              {draft.id ? "Save" : "Create"}
            </button>
            <button type="button" className="arr-btn arr-btn--ghost" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="arr-form-help arr-form-help--warning">{error}</p> : null}
    </SettingsArrFieldSet>
  );
}

export default SettingsCongregations;
