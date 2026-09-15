import { Fragment, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  decideSongLink,
  dismissSongRecords,
  getMissingSongs,
  getSongLinkReview,
  getSongRecordOwners,
  getTagPlaylistReport,
  importSongRecordBundle,
  relinkSongRecords,
  setTagPlaylistEnabled,
  undoTagPlaylist,
} from "../utils/api/endpoints/songRecords.js";
import "./itunesLibrary.css";

// An admin's view of someone's old iTunes library: the songs that still need
// finding, the matches worth a second look, and the smart playlists rebuilt
// from the tags they gave their songs.

const TABS = [
  { id: "missing", label: "Missing music" },
  { id: "review", label: "Check matches" },
  { id: "smart", label: "Smart playlists" },
  { id: "import", label: "Import" },
];

const errorText = (error, fallback) => error?.response?.data?.error || error?.message || fallback;

const stars = (rating) => (rating > 0 ? "★".repeat(rating) + "☆".repeat(5 - rating) : "");

const length = (ms) => {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (!total) return "";
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const percent = (value) => (value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`);

function MissingTab({ owner }) {
  const queryClient = useQueryClient();
  const { showError, showSuccess } = useToast();
  const [ratedOnly, setRatedOnly] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(() => new Set());
  const queryKey = ["song-records", "missing", owner, showHidden];
  const report = useQuery({
    queryKey,
    queryFn: ({ signal }) => getMissingSongs({ owner, dismissed: showHidden, signal }),
    enabled: Boolean(owner),
  });

  const relink = useMutation({
    mutationFn: () => relinkSongRecords(owner),
    onSuccess: (result) => {
      showSuccess(result.linked || result.review
        ? `Found ${result.linked} song(s) on the server${result.review ? `, ${result.review} to check` : ""}`
        : "No new songs found on the server");
      queryClient.invalidateQueries({ queryKey: ["song-records"] });
    },
    onError: (error) => showError(errorText(error, "Could not look for songs")),
  });

  const hide = useMutation({
    mutationFn: ({ ids, dismissed }) => dismissSongRecords(ids, dismissed),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["song-records", "missing", owner] }),
    onError: (error) => showError(errorText(error, "Could not hide")),
  });

  const albums = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (report.data?.items || []).filter((album) =>
      (!ratedOnly || album.ratedCount > 0)
      && (!needle || `${album.artist} ${album.album}`.toLowerCase().includes(needle)
        || album.songs.some((song) => String(song.title).toLowerCase().includes(needle))));
  }, [filter, ratedOnly, report.data]);

  const toggle = (key) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const totals = report.data?.totals;
  return (
    <section className="itunes-library__panel">
      <p className="itunes-library__lede">
        Songs from {owner}&apos;s iTunes library with no file on the server, gathered by album. Albums with
        the most rated songs come first. When an album arrives through Lidarr its songs are matched
        automatically and drop off this list, tags and all.
      </p>
      {totals ? (
        <p className="itunes-library__totals">
          {totals.albums} albums · {totals.songs} songs · {totals.rated} rated · {totals.loved} loved ·{" "}
          {totals.inPlaylists} in his playlists
        </p>
      ) : null}
      <div className="itunes-library__controls">
        <input
          type="search"
          className="input input-sm itunes-library__search"
          placeholder="Filter by artist, album or song"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <label className="itunes-library__toggle">
          <input type="checkbox" checked={ratedOnly} onChange={(event) => setRatedOnly(event.target.checked)} />
          Only albums with rated songs
        </label>
        <label className="itunes-library__toggle">
          <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
          Show hidden
        </label>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => relink.mutate()}
          disabled={relink.isPending}
          title="Look through the library again for these songs"
        >
          {relink.isPending ? <DotLoader size="sm" label={null} /> : <RefreshCw className="itunes-library__icon" aria-hidden="true" />}
          Match again
        </button>
      </div>

      {report.isLoading ? (
        <div className="itunes-library__state"><DotLoader size="sm" label="Loading" /></div>
      ) : report.isError ? (
        <p className="itunes-library__state">{errorText(report.error, "Could not load the list")}</p>
      ) : albums.length === 0 ? (
        <p className="itunes-library__state">Nothing missing here.</p>
      ) : (
        <div className="itunes-library__table-wrap">
          <table className="itunes-library__table">
            <thead>
              <tr>
                <th scope="col">Album</th>
                <th scope="col" className="is-number">Songs</th>
                <th scope="col" className="is-number">Rated</th>
                <th scope="col">Best</th>
                <th scope="col" className="is-number">Loved</th>
                <th scope="col" className="is-number">In playlists</th>
                <th scope="col" className="is-number">Plays</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {albums.map((album) => {
                const expanded = open.has(album.key);
                const ids = album.songs.map((song) => song.id);
                const hidden = album.songs.every((song) => song.dismissed);
                return (
                  <Fragment key={album.key}>
                    <tr className={`itunes-library__album-row${hidden ? " is-hidden" : ""}`}>
                      <td>
                        <button type="button" className="itunes-library__expand" onClick={() => toggle(album.key)} aria-expanded={expanded}>
                          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                          <span>
                            <span className="itunes-library__album">{album.album}</span>
                            <span className="itunes-library__artist">
                              {album.artist}
                              {album.cloudOnly ? <span className="itunes-library__tag">Apple Music only</span> : null}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="is-number">{album.songCount}</td>
                      <td className="is-number">{album.ratedCount || "—"}</td>
                      <td className="itunes-library__stars">{stars(album.topRating)}</td>
                      <td className="is-number">{album.lovedCount || "—"}</td>
                      <td className="is-number">{album.inPlaylists || "—"}</td>
                      <td className="is-number">{album.playCount || "—"}</td>
                      <td className="itunes-library__actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => hide.mutate({ ids, dismissed: !hidden })}
                          title={hidden ? "Put this album back on the list" : "Not worth finding: take it off the list"}
                        >
                          {hidden ? "Unhide" : "Hide"}
                        </button>
                      </td>
                    </tr>
                    {expanded ? album.songs.map((song) => (
                      <tr key={song.id} className={`itunes-library__song-row${song.dismissed ? " is-hidden" : ""}`}>
                        <td>
                          <span className="itunes-library__track-number">{song.trackNumber || ""}</span>
                          {song.title}
                          {song.artist && song.artist !== album.artist ? (
                            <span className="itunes-library__artist"> — {song.artist}</span>
                          ) : null}
                          {song.playlists.length ? (
                            <span className="itunes-library__playlists" title={song.playlists.join(", ")}>
                              {song.playlists.length === 1 ? song.playlists[0] : `${song.playlists.length} playlists`}
                            </span>
                          ) : null}
                        </td>
                        <td className="is-number">{length(song.durationMs)}</td>
                        <td />
                        <td className="itunes-library__stars">{stars(song.rating)}</td>
                        <td className="is-number">{song.loved ? "♥" : ""}</td>
                        <td />
                        <td className="is-number">{song.playCount || ""}</td>
                        <td className="itunes-library__actions">
                          <button type="button" className="btn btn-ghost btn-xs" onClick={() => hide.mutate({ ids: [song.id], dismissed: !song.dismissed })}>
                            {song.dismissed ? "Unhide" : "Hide"}
                          </button>
                        </td>
                      </tr>
                    )) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ReviewTab({ owner }) {
  const queryClient = useQueryClient();
  const { showError } = useToast();
  const queryKey = ["song-records", "review", owner];
  const review = useQuery({
    queryKey,
    queryFn: ({ signal }) => getSongLinkReview({ owner, signal }),
    enabled: Boolean(owner),
  });
  const decide = useMutation({
    mutationFn: ({ recordId, decision }) => decideSongLink(recordId, decision),
    onMutate: ({ recordId }) => {
      queryClient.setQueryData(queryKey, (current) =>
        current ? { ...current, items: current.items.filter((item) => item.record.id !== recordId) } : current);
    },
    onError: (error) => {
      showError(errorText(error, "Could not save"));
      queryClient.invalidateQueries({ queryKey });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["song-records", "owners"] }),
  });

  const items = review.data?.items || [];
  return (
    <section className="itunes-library__panel">
      <p className="itunes-library__lede">
        Matches the matcher was not sure of. Each pairs a song from the iTunes library with the file it
        guessed. Confirm the right ones. &ldquo;Not this&rdquo; frees the song to be matched again, and
        it shows as missing until then.
      </p>
      {review.isLoading ? (
        <div className="itunes-library__state"><DotLoader size="sm" label="Loading" /></div>
      ) : review.isError ? (
        <p className="itunes-library__state">{errorText(review.error, "Could not load matches")}</p>
      ) : items.length === 0 ? (
        <p className="itunes-library__state">Nothing to check.</p>
      ) : (
        <div className="itunes-library__table-wrap">
          <table className="itunes-library__table">
            <thead>
              <tr>
                <th scope="col">In iTunes</th>
                <th scope="col">On the server</th>
                <th scope="col">How</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ record, track, method }) => (
                <tr key={record.id}>
                  <td>
                    <div className="itunes-library__album">{record.title} <span className="itunes-library__muted">{length(record.durationMs)}</span></div>
                    <div className="itunes-library__artist">{record.artist} · {record.album}</div>
                    {record.rating ? <div className="itunes-library__stars">{stars(record.rating)}</div> : null}
                  </td>
                  <td>
                    <div className="itunes-library__album">{track.title} <span className="itunes-library__muted">{length(track.durationMs)}</span></div>
                    <div className="itunes-library__artist">{track.artist} · {track.album}</div>
                  </td>
                  <td className="itunes-library__muted">{method}</td>
                  <td className="itunes-library__actions">
                    <button type="button" className="btn btn-secondary btn-xs" onClick={() => decide.mutate({ recordId: record.id, decision: "confirm" })}>
                      Confirm
                    </button>
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => decide.mutate({ recordId: record.id, decision: "reject" })}>
                      Not this
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const describeCondition = (condition) => {
  if (Array.isArray(condition?.conditions)) {
    return `(${condition.match === "any" ? "any of" : "all of"}: ${condition.conditions.map(describeCondition).join("; ")})`;
  }
  return `${condition.field} ${condition.operator} ${Array.isArray(condition.value) ? condition.value.join("–") : condition.value}`;
};

function SmartTab({ owner }) {
  const queryClient = useQueryClient();
  const { showError, showSuccess } = useToast();
  const [open, setOpen] = useState(null);
  const queryKey = ["song-records", "smart", owner];
  const report = useQuery({
    queryKey,
    queryFn: ({ signal }) => getTagPlaylistReport({ owner, signal }),
    enabled: Boolean(owner),
    staleTime: 5 * 60_000,
  });
  const refresh = async () => {
    try {
      queryClient.setQueryData(queryKey, await getTagPlaylistReport({ owner, fresh: true }));
    } catch (error) {
      showError(errorText(error, "Could not evaluate"));
    }
  };

  const toggle = useMutation({
    mutationFn: ({ id, enabled }) => setTagPlaylistEnabled(id, enabled),
    onSuccess: (result, { enabled }) => {
      if (result.status === "failed") showError(result.error || "Could not write the playlist");
      else if (enabled) showSuccess(`Playlist written: ${result.count} songs`);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => showError(errorText(error, "Could not change the playlist")),
  });
  const undo = useMutation({
    mutationFn: (id) => undoTagPlaylist(id),
    onSuccess: (result) => {
      showSuccess(`Put back the ${result.count} songs it held before`);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => showError(errorText(error, "Could not undo")),
  });

  const switchOn = (item) => {
    const now = item.current ? `“${item.name}” (${item.current.count} songs now)` : `a new playlist “${item.name}”`;
    const message = `Replace ${owner}'s ${now} with the ${item.count} songs these rules pick, and keep it up to date from now on?\n\nWhat it holds today is saved so it can be put back.`;
    if (window.confirm(message)) toggle.mutate({ id: item.id, enabled: true });
  };

  const data = report.data;
  return (
    <section className="itunes-library__panel">
      <p className="itunes-library__lede">
        The smart playlists from his iTunes library, run against the tags he gave his songs in
        iTunes and the ratings he has now, over the songs in his own library. <strong>Now</strong>{" "}
        compares each result with the playlist of that name he has today. <strong>iTunes</strong>{" "}
        compares it with what the playlist held in his last iTunes export. Nothing changes in Navidrome
        until a playlist is switched on.
      </p>
      <div className="itunes-library__controls">
        {data ? (
          <span className="itunes-library__totals">
            {data.songsInLibrary} songs in his library, {data.taggedSongs} carrying iTunes tags
          </span>
        ) : <span />}
        <button type="button" className="btn btn-secondary btn-sm" onClick={refresh} disabled={report.isFetching}>
          {report.isFetching ? <DotLoader size="sm" label={null} /> : <RefreshCw className="itunes-library__icon" aria-hidden="true" />}
          Evaluate again
        </button>
      </div>
      {report.isLoading ? (
        <div className="itunes-library__state"><DotLoader size="sm" label="Reading his library from Navidrome" /></div>
      ) : report.isError ? (
        <p className="itunes-library__state">{errorText(report.error, "Could not evaluate")}</p>
      ) : (
        <div className="itunes-library__table-wrap">
          <table className="itunes-library__table">
            <thead>
              <tr>
                <th scope="col">Playlist</th>
                <th scope="col" className="is-number">Rules pick</th>
                <th scope="col" className="is-number">Has now</th>
                <th scope="col" className="is-number">Adds</th>
                <th scope="col" className="is-number">Drops</th>
                <th scope="col" className="is-number">Same as now</th>
                <th scope="col" className="is-number">Same as iTunes</th>
                <th scope="col">Kept in step</th>
              </tr>
            </thead>
            <tbody>
              {(data?.items || []).map((item) => {
                const expanded = open === item.id;
                const notes = [...item.unsupported, ...item.notEvaluated.map((note) => `not evaluated: ${note}`)];
                return (
                  <Fragment key={item.id}>
                    <tr>
                      <td>
                        <button type="button" className="itunes-library__expand" onClick={() => setOpen(expanded ? null : item.id)} aria-expanded={expanded}>
                          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                          <span>
                            <span className="itunes-library__album">{item.name}</span>
                            {notes.length ? <span className="itunes-library__warning">{notes.length} rule(s) not carried over</span> : null}
                            {item.lastError ? <span className="itunes-library__warning">{item.lastError}</span> : null}
                          </span>
                        </button>
                      </td>
                      <td className="is-number">{item.count}</td>
                      <td className="is-number">{item.current ? item.current.count : "—"}</td>
                      <td className="is-number">{item.current ? item.current.adds : "—"}</td>
                      <td className="is-number">{item.current ? item.current.drops : "—"}</td>
                      <td className="is-number">{percent(item.current?.overlap)}</td>
                      <td className="is-number">{percent(item.itunes?.overlap)}</td>
                      <td className="itunes-library__actions">
                        <label className="itunes-library__toggle">
                          <input
                            type="checkbox"
                            checked={item.enabled}
                            disabled={toggle.isPending}
                            onChange={(event) => (event.target.checked ? switchOn(item) : toggle.mutate({ id: item.id, enabled: false }))}
                          />
                          {item.enabled ? "On" : "Off"}
                        </label>
                        {item.hasSnapshot ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            disabled={undo.isPending}
                            onClick={() => window.confirm(`Put back what “${item.name}” held before Psalter wrote it, and switch it off?`) && undo.mutate(item.id)}
                          >
                            Undo
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="itunes-library__detail-row">
                        <td colSpan={8}>
                          <div className="itunes-library__detail">
                            <div>
                              <h4>Rules ({item.rules.match === "any" ? "any" : "all"})</h4>
                              <ul>{(item.rules.conditions || []).map((condition, index) => <li key={index}>{describeCondition(condition)}</li>)}</ul>
                              {item.rules.limit ? <p>Limited to {item.rules.limit} songs by {item.rules.sort || "list order"}</p> : null}
                              {notes.length ? <ul className="itunes-library__warning-list">{notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
                            </div>
                            {item.current ? (
                              <>
                                <div>
                                  <h4>Would add ({item.current.adds})</h4>
                                  <ul>{item.current.addSample.map((line) => <li key={line}>{line}</li>)}</ul>
                                </div>
                                <div>
                                  <h4>Would drop ({item.current.drops})</h4>
                                  <ul>{item.current.dropSample.map((line) => <li key={line}>{line}</li>)}</ul>
                                </div>
                              </>
                            ) : <p className="itunes-library__muted">He has no playlist of this name now. Switching it on creates one.</p>}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ImportTab({ onImported }) {
  const { showError, showSuccess } = useToast();
  const [file, setFile] = useState(null);
  const upload = useMutation({
    mutationFn: () => importSongRecordBundle(file),
    onSuccess: (result) => {
      showSuccess(`Imported ${result.records} songs for ${result.owner}: ${result.linked} on the server`);
      onImported(result.owner);
    },
    onError: (error) => showError(errorText(error, "Import failed")),
  });
  return (
    <section className="itunes-library__panel">
      <p className="itunes-library__lede">
        Build the bundle from an iTunes library export with <code>scripts/itunes-migrate/export_psalter_library.py</code>,
        then upload it here. Importing again updates the songs in place and keeps every decision made on this page.
      </p>
      <div className="itunes-library__controls">
        <input type="file" accept=".gz,.json,application/gzip,application/json" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        <button type="button" className="btn btn-primary btn-sm" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
          {upload.isPending ? <DotLoader size="sm" label={null} /> : null}
          Import
        </button>
      </div>
    </section>
  );
}

export default function ItunesLibraryPage() {
  useDocumentTitle("iTunes Library");
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("missing");
  const [owner, setOwner] = useState("");
  const owners = useQuery({
    queryKey: ["song-records", "owners"],
    queryFn: ({ signal }) => getSongRecordOwners({ signal }),
    enabled: user?.role === "admin",
  });
  const list = useMemo(() => owners.data?.owners || [], [owners.data]);
  useEffect(() => {
    if (!owner && list.length) setOwner(list[0].owner);
  }, [list, owner]);

  if (user && user.role !== "admin") return <Navigate to="/library" replace />;
  const current = list.find((entry) => entry.owner === owner);
  const counts = { missing: current?.unlinked, review: current?.review };
  const showTab = list.length ? tab : "import";

  return (
    <div className="itunes-library">
      <header className="itunes-library__header">
        <div>
          <h1 className="page-title">iTunes Library</h1>
          <p className="page-subtitle">
            A person&apos;s old iTunes library, kept song by song with the ratings, comments and playlists they
            gave it, whether or not the music is on the server yet.
          </p>
        </div>
        {list.length > 1 ? (
          <select className="input input-sm" value={owner} onChange={(event) => setOwner(event.target.value)}>
            {list.map((entry) => <option key={entry.owner} value={entry.owner}>{entry.owner}</option>)}
          </select>
        ) : null}
      </header>
      {current ? (
        <p className="itunes-library__totals">
          {owner}: {current.records} songs · {current.linked} on the server · {current.review} to check ·{" "}
          {current.unlinked} not found · {current.rated} rated
        </p>
      ) : null}
      <div className="itunes-library__tabs" role="tablist" aria-label="iTunes library">
        {TABS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={showTab === option.id}
            className={`itunes-library__tab${showTab === option.id ? " is-active" : ""}`}
            onClick={() => setTab(option.id)}
            disabled={!list.length && option.id !== "import"}
          >
            {option.label}
            {counts[option.id] ? <span className="itunes-library__count">{counts[option.id]}</span> : null}
          </button>
        ))}
      </div>
      {owners.isLoading ? (
        <div className="itunes-library__state"><DotLoader size="sm" label="Loading" /></div>
      ) : showTab === "missing" ? (
        <MissingTab owner={owner} />
      ) : showTab === "review" ? (
        <ReviewTab owner={owner} />
      ) : showTab === "smart" ? (
        <SmartTab owner={owner} />
      ) : (
        <ImportTab
          onImported={(name) => {
            setOwner(name);
            setTab("missing");
            queryClient.invalidateQueries({ queryKey: ["song-records"] });
          }}
        />
      )}
    </div>
  );
}
