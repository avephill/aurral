import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Send } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { fetchCanonicalLibraryPage } from "../utils/api/endpoints/library.js";
import { getNavidromePlaylists } from "../utils/api/playlistProviders.js";
import {
  dismissRecommendation,
  getListeningHighlights,
  getSocialOverview,
  markRecommendationsRead,
  sendRecommendation,
  setShareListening,
  sharePlaylistWith,
  stopSharing,
  syncShare,
} from "../utils/api/endpoints/social.js";
import "./social.css";

// Everything people do with each other here: playlists shared with one person,
// albums and songs they point each other at, and what they have been playing.

const errorText = (error, fallback) => error?.response?.data?.error || error?.message || fallback;

const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const when = (value) => {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : "";
};

const KINDS = [
  { id: "album", label: "Album" },
  { id: "track", label: "Song" },
];

function PeoplePicker({ people, chosen, onChange, everyoneLabel = null }) {
  return (
    <div className="social__people">
      {everyoneLabel ? (
        <label className="social__person">
          <input
            type="checkbox"
            checked={chosen.length === 0}
            onChange={() => onChange([])}
          />
          {everyoneLabel}
        </label>
      ) : null}
      {people.map((person) => (
        <label key={person} className="social__person">
          <input
            type="checkbox"
            checked={chosen.includes(person)}
            onChange={(event) => onChange(event.target.checked
              ? [...chosen, person]
              : chosen.filter((name) => name !== person))}
          />
          {person}
        </label>
      ))}
    </div>
  );
}

function RecommendForm({ people, onSent }) {
  const { showError, showSuccess } = useToast();
  const [kind, setKind] = useState("album");
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState("");
  const [recipients, setRecipients] = useState([]);

  const results = useQuery({
    queryKey: ["social", "search", kind, term],
    queryFn: ({ signal }) => fetchCanonicalLibraryPage(
      { kind: kind === "album" ? "albums" : "tracks", query: term, page: 1, pageSize: 8, availableOnly: true },
      { signal },
    ),
    enabled: term.trim().length > 1,
    staleTime: 30_000,
  });

  const send = useMutation({
    mutationFn: () => sendRecommendation({ kind, targetId: picked.id, note, recipients }),
    onSuccess: (result) => {
      showSuccess(result.toEveryone ? "Sent to everyone" : `Sent to ${result.sent} ${result.sent === 1 ? "person" : "people"}`);
      setPicked(null);
      setTerm("");
      setNote("");
      onSent();
    },
    onError: (error) => showError(errorText(error, "Could not send that")),
  });

  const items = results.data?.items || [];
  return (
    <div className="social__form">
      <div className="social__row">
        <div className="social__tabs" role="tablist" aria-label="What to recommend">
          {KINDS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={kind === option.id}
              className={`social__tab${kind === option.id ? " is-active" : ""}`}
              onClick={() => { setKind(option.id); setPicked(null); }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="input input-sm social__search"
          placeholder={`Find ${kind === "album" ? "an album" : "a song"} on the server`}
          value={picked ? `${picked.title} — ${picked.artist}` : term}
          onChange={(event) => { setPicked(null); setTerm(event.target.value); }}
        />
      </div>

      {!picked && term.trim().length > 1 ? (
        <ul className="social__results">
          {results.isFetching ? <li className="social__muted">Searching…</li> : null}
          {!results.isFetching && !items.length ? <li className="social__muted">Nothing on the server matches.</li> : null}
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="social__result"
                onClick={() => setPicked({
                  id: item.id,
                  title: item.title || item.name,
                  artist: item.artistName || item.albumArtist || "",
                })}
              >
                <span className="social__result-title">{item.title || item.name}</span>
                <span className="social__muted">{item.artistName || item.albumArtist || ""}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {picked ? (
        <>
          <input
            type="text"
            className="input input-sm"
            placeholder="Say something about it (optional)"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
          <PeoplePicker people={people} chosen={recipients} onChange={setRecipients} everyoneLabel="Everyone" />
          <button type="button" className="btn btn-primary btn-sm" disabled={send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? <DotLoader size="sm" label={null} /> : <Send className="social__icon" aria-hidden="true" />}
            {recipients.length ? `Send to ${recipients.join(", ")}` : "Send to everyone"}
          </button>
        </>
      ) : null}
    </div>
  );
}

function SharePlaylistForm({ people, onShared }) {
  const { showError, showSuccess } = useToast();
  const [playlistId, setPlaylistId] = useState("");
  const [recipients, setRecipients] = useState([]);
  const mine = useQuery({
    queryKey: ["social", "my-playlists"],
    queryFn: ({ signal }) => getNavidromePlaylists({ signal }),
  });
  const playlists = (mine.data?.playlists || []).filter((playlist) => playlist.owned);

  const share = useMutation({
    mutationFn: () => sharePlaylistWith(playlistId, recipients),
    onSuccess: (result) => {
      const missing = result.shared.reduce((sum, entry) => sum + (entry.missing || 0), 0);
      showSuccess(missing
        ? `Shared. ${missing} song(s) left out because they are not in their library.`
        : "Shared.");
      setRecipients([]);
      onShared();
    },
    onError: (error) => showError(errorText(error, "Could not share that playlist")),
  });

  return (
    <div className="social__form">
      <div className="social__row">
        <select className="input input-sm" value={playlistId} onChange={(event) => setPlaylistId(event.target.value)}>
          <option value="">Choose one of your playlists…</option>
          {playlists.map((playlist) => (
            <option key={playlist.id} value={playlist.id}>{playlist.name} ({playlist.trackCount || 0})</option>
          ))}
        </select>
      </div>
      <PeoplePicker people={people} chosen={recipients} onChange={setRecipients} />
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={!playlistId || !recipients.length || share.isPending}
        onClick={() => share.mutate()}
        title="They get their own copy, private to them, kept in step with yours."
      >
        {share.isPending ? <DotLoader size="sm" label={null} /> : null}
        Share playlist
      </button>
    </div>
  );
}

export default function SocialPage() {
  useDocumentTitle("Social");
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { showError } = useToast();
  const [showHighlights, setShowHighlights] = useState(false);

  const overview = useQuery({
    queryKey: ["social", "overview"],
    queryFn: ({ signal }) => getSocialOverview({ signal }),
    enabled: Boolean(user),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["social"] });

  const highlights = useQuery({
    queryKey: ["social", "highlights"],
    queryFn: ({ signal }) => getListeningHighlights({ signal }),
    enabled: showHighlights,
    staleTime: 5 * 60_000,
  });

  // Anything waiting stops being new once they have looked at the page.
  const unread = overview.data?.recommendations?.unread || 0;
  useEffect(() => {
    if (unread > 0) markRecommendationsRead().then(refresh).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);

  const dismiss = useMutation({
    mutationFn: (id) => dismissRecommendation(id),
    onSuccess: refresh,
    onError: (error) => showError(errorText(error, "Could not hide that")),
  });
  const resync = useMutation({
    mutationFn: (id) => syncShare(id),
    onSuccess: refresh,
    onError: (error) => showError(errorText(error, "Could not refresh that playlist")),
  });
  const unshare = useMutation({
    mutationFn: (id) => stopSharing(id),
    onSuccess: refresh,
    onError: (error) => showError(errorText(error, "Could not stop sharing")),
  });
  const listening = useMutation({
    mutationFn: (value) => setShareListening(value),
    onSuccess: refresh,
    onError: (error) => showError(errorText(error, "Could not save that")),
  });

  const data = overview.data;
  const people = useMemo(() => data?.people || [], [data]);
  const inbox = data?.recommendations?.inbox || [];
  const received = data?.shares?.received || [];
  const sent = data?.shares?.sent || [];

  if (overview.isLoading) {
    return <div className="social"><div className="social__state"><DotLoader size="sm" label="Loading" /></div></div>;
  }

  return (
    <div className="social">
      <header className="social__header">
        <div>
          <h1 className="page-title">Social</h1>
          <p className="page-subtitle">
            Playlists shared with you, music people think you should hear, and what everyone has been playing.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={refresh} disabled={overview.isFetching}>
          {overview.isFetching ? <DotLoader size="sm" label={null} /> : <RefreshCw className="social__icon" aria-hidden="true" />}
          Refresh
        </button>
      </header>

      <section className="social__panel">
        <h2>Shared with you</h2>
        {received.length === 0 ? (
          <p className="social__muted">Nothing yet. A playlist someone shares with you appears here, and in your own playlists.</p>
        ) : (
          <ul className="social__list">
            {received.map((share) => (
              <li key={share.id} className="social__card">
                <div>
                  <div className="social__title">
                    {share.playlistId ? (
                      <Link to={`/library/playlists?id=${encodeURIComponent(share.playlistId)}`}>{share.name}</Link>
                    ) : share.name}
                  </div>
                  <div className="social__muted">
                    from {share.owner} · {share.songCount} songs
                    {share.missing ? ` · ${share.missing} not in your library` : ""}
                    {share.syncedAt ? ` · updated ${when(share.syncedAt)}` : ""}
                  </div>
                  {share.error ? <div className="social__warning">{share.error}</div> : null}
                </div>
                <div className="social__actions">
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => resync.mutate(share.id)}>Refresh</button>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => unshare.mutate(share.id)}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="social__panel">
        <h2>Recommendations</h2>
        {inbox.length === 0 ? (
          <p className="social__muted">Nothing waiting for you.</p>
        ) : (
          <ul className="social__list">
            {inbox.map((entry) => (
              <li key={entry.id} className="social__card">
                <div>
                  <div className="social__title">
                    {entry.title || `${entry.kind} ${entry.targetId}`}
                    {entry.subtitle ? <span className="social__muted"> — {entry.subtitle}</span> : null}
                  </div>
                  <div className="social__muted">
                    {entry.sender} {entry.toEveryone ? "told everyone" : "sent this to you"} · {when(entry.createdAt)}
                  </div>
                  {entry.note ? <p className="social__note">“{entry.note}”</p> : null}
                </div>
                <div className="social__actions">
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => dismiss.mutate(entry.id)}>Hide</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <h3>Recommend something</h3>
        <RecommendForm people={people} onSent={refresh} />
      </section>

      <section className="social__panel">
        <h2>Share a playlist</h2>
        <p className="social__muted">
          They get their own private copy, kept in step with yours. Songs their library does not hold are left out.
        </p>
        <SharePlaylistForm people={people} onShared={refresh} />
        {sent.length ? (
          <ul className="social__list">
            {sent.map((share) => (
              <li key={share.id} className="social__card">
                <div>
                  <div className="social__title">{share.name}</div>
                  <div className="social__muted">
                    shared with {share.recipient}
                    {share.missing ? ` · ${share.missing} left out` : ""}
                    {share.syncedAt ? ` · updated ${when(share.syncedAt)}` : ""}
                  </div>
                  {share.error ? <div className="social__warning">{share.error}</div> : null}
                </div>
                <div className="social__actions">
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => resync.mutate(share.id)}>Refresh</button>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => unshare.mutate(share.id)}>Stop sharing</button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="social__panel">
        <h2>What everyone&apos;s playing</h2>
        <label className="social__person">
          <input
            type="checkbox"
            checked={data?.settings?.shareListening !== false}
            onChange={(event) => listening.mutate(event.target.checked)}
          />
          Let others see what I play
        </label>
        {!showHighlights ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowHighlights(true)}>
            Show what people have been playing
          </button>
        ) : highlights.isLoading ? (
          <div className="social__state"><DotLoader size="sm" label="Asking Navidrome" /></div>
        ) : highlights.isError ? (
          <p className="social__muted">{errorText(highlights.error, "Could not read listening")}</p>
        ) : (
          <div className="social__grid">
            {(highlights.data?.people || []).map((person) => (
              <div key={person.username} className="social__card social__card--stack">
                <div className="social__title">{person.username}</div>
                {person.recent.length ? (
                  <>
                    <div className="social__muted">Lately</div>
                    <ul className="social__plain">
                      {person.recent.slice(0, 4).map((album) => (
                        <li key={`r-${album.id}`}>{album.name} <span className="social__muted">— {album.artist}</span></li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {person.frequent.length ? (
                  <>
                    <div className="social__muted">Most played</div>
                    <ul className="social__plain">
                      {person.frequent.slice(0, 4).map((album) => (
                        <li key={`f-${album.id}`}>{album.name} <span className="social__muted">— {album.artist}</span></li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            ))}
            {!(highlights.data?.people || []).length ? (
              <p className="social__muted">Nobody is sharing their listening yet.</p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
