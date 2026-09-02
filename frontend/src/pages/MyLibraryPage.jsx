import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Library, Search, X } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useUserLibraryCatalog } from "../hooks/useUserLibrary";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "mine", label: "In my library" },
  { id: "available", label: "Not in my library" },
];
const PAGE_STEP = 300;

const pluralize = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const formatLibraries = (libraries = []) => {
  if (!libraries.length) return "";
  if (libraries.length === 1) return `In ${libraries[0]}'s library`;
  if (libraries.length === 2) return `In ${libraries[0]}'s and ${libraries[1]}'s libraries`;
  return `In ${libraries[0]}'s and ${libraries.length - 1} other libraries`;
};

const matchesQuery = (artist, query) => {
  if (!query) return true;
  const haystack = `${artist.artistName} ${artist.sortName}`.toLowerCase();
  return query.split(/\s+/).every((term) => haystack.includes(term));
};

export default function MyLibraryPage() {
  useDocumentTitle("My Library");
  const { user, bootstrap } = useAuth();
  const catalog = useUserLibraryCatalog({ enabled: !!user });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(() => new Set());
  const [visibleLimit, setVisibleLimit] = useState(PAGE_STEP);

  const enabled = catalog.enabled || bootstrap?.userLibrariesEnabled === true;
  const artists = catalog.artists;
  const inLibraryCount = useMemo(() => artists.filter((artist) => artist.inLibrary).length, [artists]);

  const filtered = useMemo(
    () =>
      artists.filter((artist) => {
        if (filter === "mine" && !artist.inLibrary) return false;
        if (filter === "available" && artist.inLibrary) return false;
        return matchesQuery(artist, deferredQuery);
      }),
    [artists, filter, deferredQuery],
  );
  const visible = filtered.length > visibleLimit ? filtered.slice(0, visibleLimit) : filtered;

  useEffect(() => {
    setVisibleLimit(PAGE_STEP);
  }, [filter, deferredQuery]);

  // Drop selections that no longer exist (e.g. the artist left Lidarr).
  useEffect(() => {
    if (!selected.size || !artists.length) return;
    const known = new Set(artists.map((artist) => artist.mbid));
    if ([...selected].every((mbid) => known.has(mbid))) return;
    setSelected(new Set([...selected].filter((mbid) => known.has(mbid))));
  }, [artists, selected]);

  const selectedArtists = useMemo(
    () => artists.filter((artist) => selected.has(artist.mbid)),
    [artists, selected],
  );
  const toAdd = selectedArtists.filter((artist) => !artist.inLibrary);
  const toRemove = selectedArtists.filter((artist) => artist.inLibrary);
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((artist) => selected.has(artist.mbid));
  const someFilteredSelected = filtered.some((artist) => selected.has(artist.mbid));

  const toggle = useCallback((mbid) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(mbid)) next.delete(mbid);
      else next.add(mbid);
      return next;
    });
  }, []);

  const toggleAllFiltered = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        filtered.forEach((artist) => next.delete(artist.mbid));
      } else {
        filtered.forEach((artist) => next.add(artist.mbid));
      }
      return next;
    });
  };

  const applyBulk = async (action) => {
    const targets = action === "remove" ? toRemove : toAdd;
    if (!targets.length) return;
    const mbids = targets.map((artist) => artist.mbid);
    const result =
      action === "remove" ? await catalog.removeArtists(mbids) : await catalog.addArtists(mbids);
    if (!result) return;
    setSelected((current) => {
      const next = new Set(current);
      mbids.forEach((mbid) => next.delete(mbid));
      return next;
    });
  };

  if (!catalog.loading && !enabled) {
    return (
      <div className="my-library-page">
        <header className="my-library-page__header">
          <div>
            <h1 className="page-title">My Library</h1>
            <p className="page-subtitle">
              Personal libraries are not enabled on this server. An admin can turn them on under
              Settings → Users.
            </p>
          </div>
        </header>
      </div>
    );
  }

  return (
    <div className="my-library-page">
      <header className="my-library-page__header">
        <div>
          <h1 className="page-title">My Library</h1>
          <p className="page-subtitle">
            Choose which artists from the main library appear in your personal library.
            {artists.length
              ? ` ${pluralize(inLibraryCount, "artist")} in your library, ${artists.length} on the server.`
              : ""}
          </p>
        </div>
        <Link to="/library/artists" className="btn btn-secondary btn-sm">
          <Library className="artist-icon-sm" aria-hidden="true" />
          Browse the library
        </Link>
      </header>

      <div className="my-library-page__toolbar">
        <div className="my-library-page__search">
          <Search className="artist-icon-sm" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter artists"
            aria-label="Filter artists"
          />
          {query ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setQuery("")}
              aria-label="Clear filter"
            >
              <X className="artist-icon-xs" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="artist-segmented" role="group" aria-label="Show">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`artist-segmented-button${filter === option.id ? " is-active" : ""}`}
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {catalog.loading ? (
        <div className="my-library-page__state">
          <DotLoader size="sm" label="Loading artists" />
        </div>
      ) : catalog.error ? (
        <div className="my-library-page__state">
          <p className="my-library-page__empty">
            {catalog.error?.response?.data?.error || catalog.error?.message || "Could not load the library."}
          </p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => catalog.refetch()}>
            Try again
          </button>
        </div>
      ) : !artists.length ? (
        <p className="my-library-page__empty">The main library has no artists yet.</p>
      ) : (
        <div className="my-library-page__list" role="group" aria-label="Artists">
          <div className="my-library-page__row my-library-page__row--head">
            <input
              type="checkbox"
              className="my-library-page__checkbox"
              checked={allFilteredSelected}
              ref={(node) => {
                if (node) node.indeterminate = !allFilteredSelected && someFilteredSelected;
              }}
              onChange={toggleAllFiltered}
              disabled={!filtered.length}
              aria-label={allFilteredSelected ? "Deselect all shown artists" : "Select all shown artists"}
            />
            <span className="my-library-page__row-name">
              {filtered.length === artists.length
                ? pluralize(artists.length, "artist")
                : `${filtered.length} of ${pluralize(artists.length, "artist")}`}
            </span>
            <span className="my-library-page__row-status" aria-hidden="true" />
          </div>
          {visible.length ? (
            visible.map((artist) => (
              <ArtistRow
                key={artist.mbid}
                artist={artist}
                checked={selected.has(artist.mbid)}
                onToggle={toggle}
              />
            ))
          ) : (
            <p className="my-library-page__empty">No artists match.</p>
          )}
          {filtered.length > visible.length ? (
            <div className="my-library-page__more">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setVisibleLimit((limit) => limit + PAGE_STEP)}
              >
                Show more ({filtered.length - visible.length} remaining)
              </button>
            </div>
          ) : null}
        </div>
      )}

      {selected.size > 0 ? (
        <div className="my-library-page__actions" role="region" aria-label="Selection actions">
          <span className="my-library-page__actions-count">{pluralize(selected.size, "artist")} selected</span>
          <div className="my-library-page__actions-buttons">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSelected(new Set())}
              disabled={catalog.pending}
            >
              Clear
            </button>
            <button
              type="button"
              className="btn btn-ghost-danger btn-sm"
              onClick={() => applyBulk("remove")}
              disabled={!toRemove.length || catalog.pending}
            >
              {catalog.pendingAction === "remove" ? <DotLoader size="xs" label={null} /> : null}
              Remove {toRemove.length || ""}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => applyBulk("add")}
              disabled={!toAdd.length || catalog.pending}
            >
              {catalog.pendingAction === "add" ? <DotLoader size="xs" label={null} /> : null}
              Add {toAdd.length || ""} to my library
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ArtistRow({ artist, checked, onToggle }) {
  const librariesText = formatLibraries(artist.libraries);
  const meta = [pluralize(artist.albumCount, "album"), librariesText].filter(Boolean).join(" · ");
  return (
    <label
      className={`my-library-page__row${checked ? " is-selected" : ""}${artist.inLibrary ? " is-member" : ""}`}
    >
      <input
        type="checkbox"
        className="my-library-page__checkbox"
        checked={checked}
        onChange={() => onToggle(artist.mbid)}
        aria-label={`Select ${artist.artistName}`}
      />
      <span className="my-library-page__row-name">
        <span className="my-library-page__row-title">{artist.artistName}</span>
        <span className="my-library-page__row-detail">{meta}</span>
      </span>
      <span className="my-library-page__row-status">
        {artist.inLibrary ? (
          <span className="my-library-page__badge" title="In your library">
            <Check className="artist-icon-xs" aria-hidden="true" />
            <span>In my library</span>
          </span>
        ) : null}
      </span>
    </label>
  );
}
