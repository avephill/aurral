import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

// Choosing who to tell. A row of checkboxes is fine for three people and
// hopeless for twenty, so this takes a name at a time: type, pick, repeat.
// Empty still means everyone, which the caller says out loud.
//
// Do not wrap this in a <label>. A label sends every click inside it to the
// control it labels - here the text box - and the names are buttons, so they
// stop being clickable. Pass `labelId` instead and caption it with a span.

export default function PeoplePicker({
  people = [],
  value = [],
  onChange,
  disabled = false,
  placeholder = "Type a name",
  emptyHint = "",
  labelId = "",
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return people
      .filter((person) => !value.includes(person))
      .filter((person) => !needle || person.toLowerCase().includes(needle));
  }, [people, query, value]);

  const add = (person) => {
    if (!person || value.includes(person)) return;
    onChange?.([...value, person]);
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  };

  const remove = (person) => onChange?.(value.filter((entry) => entry !== person));

  const onKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, matches.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter" && matches[active]) {
      event.preventDefault();
      add(matches[active]);
      return;
    }
    // Backspace on an empty box takes back the last name, as a mail client does.
    if (event.key === "Backspace" && !query && value.length) {
      remove(value[value.length - 1]);
    }
  };

  return (
    <div className="people-picker">
      <div
        className="people-picker__field"
        onClick={() => inputRef.current?.focus()}
        role="presentation"
      >
        {value.map((person) => (
          <span className="people-picker__chip" key={person}>
            {person}
            <button
              type="button"
              aria-label={`Remove ${person}`}
              onClick={(event) => {
                event.stopPropagation();
                remove(person);
              }}
              disabled={disabled}
            >
              <X aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={value.length ? "" : placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          aria-label={labelId ? undefined : "Who to send this to"}
          aria-labelledby={labelId || undefined}
          autoComplete="off"
        />
      </div>
      {open && matches.length ? (
        <ul className="people-picker__options" role="listbox">
          {matches.map((person, index) => (
            <li key={person}>
              <button
                type="button"
                className={`people-picker__option${index === active ? " is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => add(person)}
                onMouseEnter={() => setActive(index)}
              >
                {person}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {emptyHint && !value.length ? <p className="people-picker__hint">{emptyHint}</p> : null}
    </div>
  );
}
