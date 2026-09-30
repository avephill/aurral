import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Plus, Search, X } from "lucide-react";
import { getMyTags } from "../utils/api/endpoints/tags.js";

// Narrowing the song list to the ones carrying some tags. The chosen tags sit
// in the filter row as chips; more are picked from a list of this person's
// tags, searchable and showing how many songs carry each. With two or more, a
// song can be asked to carry all of them or any one.

export default function TagFilter({ selected = [], match = "all", onChange }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: ({ signal }) => getMyTags({ signal }),
    staleTime: 60_000,
  });
  const choices = useMemo(() => {
    const wanted = search.trim().toLowerCase();
    return (tags.data?.tags || [])
      .filter((entry) => !wanted || entry.tag.includes(wanted))
      .sort((a, b) => b.songs - a.songs || a.tag.localeCompare(b.tag));
  }, [tags.data, search]);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => setCursor(0), [search]);

  const toggle = (tag) => {
    const next = selected.includes(tag) ? selected.filter((entry) => entry !== tag) : [...selected, tag];
    onChange(next, match);
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => Math.min(value + 1, Math.max(choices.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => Math.max(value - 1, 0));
    } else if (event.key === "Enter" && choices[cursor]) {
      event.preventDefault();
      toggle(choices[cursor].tag);
    }
  };

  return (
    <div className="tag-filter" ref={rootRef}>
      <span className="tag-filter__label">Tags</span>
      {selected.map((tag, index) => (
        <span key={tag} className="tag-filter__group">
          {index > 0 ? <span className="tag-filter__joiner">{match === "any" ? "or" : "and"}</span> : null}
          <span className="tag-filter__chip">
            {tag}
            <button type="button" onClick={() => toggle(tag)} aria-label={`Stop filtering by ${tag}`}>
              <X aria-hidden="true" />
            </button>
          </span>
        </span>
      ))}
      <button
        type="button"
        className={`tag-filter__add${open ? " is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={listId}
      >
        <Plus aria-hidden="true" />
        {selected.length ? "Tag" : "Filter by tag"}
      </button>
      {selected.length > 1 ? (
        <div className="tag-filter__match" role="group" aria-label="Songs must carry">
          {[
            ["all", "All"],
            ["any", "Any"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={match === value ? "is-active" : ""}
              aria-pressed={match === value}
              onClick={() => onChange(selected, value)}
              title={value === "all" ? "Songs with every one of these tags" : "Songs with at least one of these tags"}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="tag-filter__popover" id={listId}>
          <label className="tag-filter__search">
            <Search aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              placeholder="Find a tag"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={onKeyDown}
              aria-label="Find a tag"
              autoComplete="off"
            />
          </label>
          <ul className="tag-filter__list" role="listbox" aria-multiselectable="true" aria-label="Tags">
            {tags.isLoading ? <li className="tag-filter__empty">Loading tags…</li> : null}
            {!tags.isLoading && !choices.length ? (
              <li className="tag-filter__empty">
                {search ? "No tag matches that." : "You have not tagged any songs yet."}
              </li>
            ) : null}
            {choices.map((entry, index) => {
              const chosen = selected.includes(entry.tag);
              return (
                <li
                  key={entry.tag}
                  role="option"
                  aria-selected={chosen}
                  className={`tag-filter__option${index === cursor ? " is-cursor" : ""}${chosen ? " is-chosen" : ""}`}
                  onPointerEnter={() => setCursor(index)}
                  onClick={() => toggle(entry.tag)}
                >
                  <span className="tag-filter__check" aria-hidden="true">{chosen ? <Check /> : null}</span>
                  <span className="tag-filter__name">{entry.tag}</span>
                  <span className="tag-filter__count">{entry.songs}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
