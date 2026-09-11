import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { DotLoader } from "./DotLoader";
import { ModalShell } from "./PlaylistModals";
import { getNavidromePlaylistRuleFields } from "../utils/api/endpoints/playlists.js";
import "./smartPlaylistEditor.css";

/**
 * The iTunes smart playlist, rebuilt: a playlist described by rules, which
 * Navidrome keeps up to date on its own.
 *
 * The fields and operators come from the server rather than being listed
 * here, because Navidrome answers a rule about a field it does not know with
 * an empty playlist and no complaint, and an editor that can only offer real
 * fields cannot produce one.
 */

const emptyCondition = (fields) => ({
  field: fields[0]?.name || "title",
  operator: fields[0]?.operators?.[0]?.name || "contains",
  value: "",
});

const blankRules = (fields) => ({
  match: "all",
  conditions: [emptyCondition(fields)],
  sort: "",
  order: "asc",
  limit: "",
});

function ValueInput({ field, operator, value, onChange }) {
  const type = field?.type || "text";
  if (type === "boolean") {
    return (
      <select
        className="smart-rules__value"
        value={String(value === true || value === "true" || value === "yes")}
        onChange={(event) => onChange(event.target.value === "true")}
      >
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    );
  }
  if (operator === "inTheRange") {
    const [from = "", to = ""] = String(value ?? "").split(",");
    const push = (next) => onChange(next.join(","));
    return (
      <span className="smart-rules__range">
        <input
          className="smart-rules__value"
          type={type === "date" ? "date" : "number"}
          value={from}
          onChange={(event) => push([event.target.value, to])}
          aria-label="From"
        />
        <span className="smart-rules__range-and">and</span>
        <input
          className="smart-rules__value"
          type={type === "date" ? "date" : "number"}
          value={to}
          onChange={(event) => push([from, event.target.value])}
          aria-label="To"
        />
      </span>
    );
  }
  // Days for "in the last", a calendar date for everything else on a date.
  const inputType = type === "number" || ["inTheLast", "notInTheLast"].includes(operator)
    ? "number"
    : type === "date" ? "date" : "text";
  return (
    <input
      className="smart-rules__value"
      type={inputType}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
      placeholder={inputType === "text" ? "value" : ""}
      aria-label="Value"
    />
  );
}

export default function SmartPlaylistEditor({
  open,
  mode = "create",
  initialName = "",
  initialRules = null,
  busy = false,
  onClose,
  onSave,
}) {
  const catalogue = useQuery({
    queryKey: ["navidrome-playlists", "rule-fields"],
    queryFn: ({ signal }) => getNavidromePlaylistRuleFields({ signal }),
    staleTime: 10 * 60_000,
    enabled: open,
  });
  const fields = useMemo(
    () => (Array.isArray(catalogue.data?.fields) ? catalogue.data.fields : []),
    [catalogue.data],
  );
  const fieldByName = useMemo(
    () => new Map(fields.map((field) => [field.name, field])),
    [fields],
  );

  const [name, setName] = useState(initialName);
  const [rules, setRules] = useState(null);

  useEffect(() => {
    if (!open || !fields.length) return;
    setName(initialName);
    setRules(initialRules
      ? {
        match: initialRules.match || "all",
        conditions: initialRules.conditions?.length
          ? initialRules.conditions.map((condition) => ({ ...condition }))
          : [emptyCondition(fields)],
        sort: initialRules.sort || "",
        order: initialRules.order || "asc",
        limit: initialRules.limit ?? "",
      }
      : blankRules(fields));
  }, [open, fields, initialName, initialRules]);

  if (!open) return null;

  const update = (patch) => setRules((current) => ({ ...current, ...patch }));
  const updateCondition = (index, patch) => setRules((current) => ({
    ...current,
    conditions: current.conditions.map((condition, position) =>
      (position === index ? { ...condition, ...patch } : condition)),
  }));

  const changeField = (index, fieldName) => {
    const field = fieldByName.get(fieldName);
    const operators = field?.operators || [];
    updateCondition(index, {
      field: fieldName,
      // The old operator rarely applies to a field of another kind.
      operator: operators[0]?.name || "is",
      value: "",
    });
  };

  const addCondition = () => setRules((current) => ({
    ...current,
    conditions: [...current.conditions, emptyCondition(fields)],
  }));

  const removeCondition = (index) => setRules((current) => ({
    ...current,
    conditions: current.conditions.length > 1
      ? current.conditions.filter((_, position) => position !== index)
      : current.conditions,
  }));

  const ready = Boolean(rules && fields.length && (mode !== "create" || name.trim()));

  return (
    <ModalShell
      open={open}
      title={mode === "create" ? "New smart playlist" : "Edit rules"}
      description="Navidrome keeps this playlist up to date from the rules below."
      onClose={onClose}
      disableClose={busy}
      className="smart-rules__modal"
      footer={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onSave({ name: name.trim(), rules })}
            disabled={!ready || busy}
          >
            {busy ? <DotLoader size="xs" label={null} /> : null}
            {mode === "create" ? "Create" : "Save rules"}
          </button>
        </>
      )}
    >
      {catalogue.isLoading || !rules ? (
        <DotLoader label="Loading rules" />
      ) : (
        <div className="smart-rules">
          {mode === "create" ? (
            <label className="smart-rules__name">
              <span>Name</span>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Recently added favourites"
                autoFocus
              />
            </label>
          ) : null}

          <div className="smart-rules__match">
            <span>Match</span>
            <select value={rules.match} onChange={(event) => update({ match: event.target.value })}>
              <option value="all">all</option>
              <option value="any">any</option>
            </select>
            <span>of the following rules</span>
          </div>

          <ul className="smart-rules__list">
            {rules.conditions.map((condition, index) => {
              const field = fieldByName.get(condition.field);
              return (
                <li key={index} className="smart-rules__row">
                  <select
                    className="smart-rules__field"
                    value={condition.field}
                    onChange={(event) => changeField(index, event.target.value)}
                    aria-label="Field"
                  >
                    {fields.map((option) => (
                      <option key={option.name} value={option.name}>{option.label}</option>
                    ))}
                  </select>
                  <select
                    className="smart-rules__operator"
                    value={condition.operator}
                    onChange={(event) => updateCondition(index, { operator: event.target.value, value: "" })}
                    aria-label="Condition"
                  >
                    {(field?.operators || []).map((option) => (
                      <option key={option.name} value={option.name}>{option.label}</option>
                    ))}
                  </select>
                  <ValueInput
                    field={field}
                    operator={condition.operator}
                    value={condition.value}
                    onChange={(value) => updateCondition(index, { value })}
                  />
                  <button
                    type="button"
                    className="btn btn-icon btn-xs btn-ghost"
                    onClick={() => removeCondition(index)}
                    disabled={rules.conditions.length === 1}
                    aria-label="Remove rule"
                  >
                    <X className="artist-icon-xs" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>

          <button type="button" className="btn btn-secondary btn-xs smart-rules__add" onClick={addCondition}>
            <Plus className="artist-icon-xs" aria-hidden="true" />
            Add rule
          </button>

          <div className="smart-rules__limits">
            <label>
              <span>Limit to</span>
              <input
                type="number"
                min="1"
                value={rules.limit ?? ""}
                onChange={(event) => update({ limit: event.target.value })}
                placeholder="all"
              />
              <span>tracks</span>
            </label>
            <label>
              <span>selected by</span>
              <select value={rules.sort} onChange={(event) => update({ sort: event.target.value })}>
                <option value="">playlist order</option>
                {(catalogue.data?.sortFields || []).map((sortField) => (
                  <option key={sortField} value={sortField}>
                    {sortField === "random" ? "random" : fieldByName.get(sortField)?.label || sortField}
                  </option>
                ))}
              </select>
            </label>
            {rules.sort && rules.sort !== "random" ? (
              <label>
                <span>order</span>
                <select value={rules.order} onChange={(event) => update({ order: event.target.value })}>
                  <option value="asc">ascending</option>
                  <option value="desc">descending</option>
                </select>
              </label>
            ) : null}
          </div>
        </div>
      )}
    </ModalShell>
  );
}
