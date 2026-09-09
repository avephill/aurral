import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ListMusic, Pause, Pencil, Play, Plus, Shuffle, Trash2, X } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { CreatePlaylistModal, ModalShell } from "../components/PlaylistModals";
import TooltipButton from "../components/TooltipButton";
import { TrackRating } from "../components/StarRating";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { queryClient, queryKeys } from "../queryClient.js";
import { buildAuthenticatedApiUrl } from "../utils/api/core.js";
import {
  createNavidromePlaylist,
  deleteNavidromePlaylist,
  getNavidromePlaylist,
  getNavidromePlaylistStatus,
  getNavidromePlaylists,
  invalidateNavidromePlaylists,
  removeNavidromePlaylistEntry,
  renameNavidromePlaylist,
} from "../utils/api/endpoints/playlists.js";
import "./navidromePlaylists.css";

/**
 * Hand-made playlists, held in Navidrome and shown here as the signed-in
 * user. Everything on this page is a live read of Navidrome; edits go
 * straight back, so a Navidrome client on the phone sees them at once.
 */

const pluralize = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const formatDuration = (totalSeconds) => {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours} hr ${minutes} min`;
  return `${minutes} min`;
};

const formatTrackDuration = (durationMs) => {
  const seconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const errorMessage = (error, fallback) =>
  error?.response?.data?.message || error?.response?.data?.error || error?.message || fallback;

function toPlayable(track, playlistId) {
  if (!track?.available || !track.streamPath) return null;
  return {
    id: `${playlistId}:${track.index}:${track.trackId}`,
    title: track.title,
    artist: track.artistName || "Unknown Artist",
    album: track.albumTitle || "Unknown Album",
    src: buildAuthenticatedApiUrl(track.streamPath),
    streamFormat: track.streamFormat || null,
    quality: track.quality || null,
    artistMbid: track.artistMbid || null,
    albumMbid: track.albumMbid || null,
    trackMbid: track.trackMbid || null,
    durationMs: track.durationMs || null,
    recordHistory: true,
    artwork: track.album?.coverUrl || "",
    canonicalTrackId: track.trackId,
    canonicalAlbumId: track.albumId,
  };
}

export default function NavidromePlaylistsPage() {
  useDocumentTitle("Playlists");
  const { user } = useAuth();
  const { showError, showSuccess } = useToast();
  const { playQueue, currentTrack, isPlaying, togglePlayPause, matchesSource } = useAudioQueue();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("id") || "";
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [removingIndex, setRemovingIndex] = useState(null);

  const status = useQuery({
    queryKey: queryKeys.navidromePlaylistStatus,
    queryFn: ({ signal }) => getNavidromePlaylistStatus({ signal }),
    staleTime: 30_000,
  });
  const list = useQuery({
    queryKey: queryKeys.navidromePlaylists,
    queryFn: ({ signal }) => getNavidromePlaylists({ signal }),
    staleTime: 4_000,
  });
  const detail = useQuery({
    queryKey: queryKeys.navidromePlaylist(selectedId),
    queryFn: ({ signal }) => getNavidromePlaylist(selectedId, { signal }),
    enabled: Boolean(selectedId),
    staleTime: 4_000,
  });

  const playlists = useMemo(
    () => (Array.isArray(list.data?.playlists) ? list.data.playlists : []),
    [list.data],
  );
  const owned = playlists.filter((playlist) => playlist.owned);
  const others = playlists.filter((playlist) => !playlist.owned);
  const selected = detail.data && String(detail.data.id) === selectedId ? detail.data : null;
  const selectedSummary = playlists.find((playlist) => String(playlist.id) === selectedId) || null;
  const canEdit = Boolean(selected?.owned ?? selectedSummary?.owned);
  const source = useMemo(() => ({ type: "navidrome-playlist", id: selectedId }), [selectedId]);
  const isThisPlaylistPlaying = isPlaying && matchesSource(source);

  const select = useCallback(
    (playlistId) => {
      const next = new URLSearchParams(searchParams);
      if (playlistId) next.set("id", String(playlistId));
      else next.delete("id");
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  const refreshAll = useCallback(async () => {
    await invalidateNavidromePlaylists();
    await queryClient.invalidateQueries({ queryKey: queryKeys.playlistStatus });
  }, []);

  const playFrom = useCallback(
    (startTrack = null, shuffle = false) => {
      const tracks = Array.isArray(selected?.tracks) ? selected.tracks : [];
      const playable = tracks.map((track) => toPlayable(track, selectedId)).filter(Boolean);
      if (!playable.length) {
        showError("None of these tracks have a playable file on the server.");
        return;
      }
      const startIndex = startTrack
        ? Math.max(0, playable.findIndex((track) => track.id === toPlayable(startTrack, selectedId)?.id))
        : 0;
      playQueue(playable, { startIndex, shuffle, source, updateShufflePreference: false });
    },
    [playQueue, selected, selectedId, showError, source],
  );

  const handleCreate = async (name) => {
    setBusy("create");
    try {
      const result = await createNavidromePlaylist({ name, tracks: [] });
      await refreshAll();
      setCreateOpen(false);
      showSuccess(`Created ${name}`);
      if (result?.playlist?.id) select(result.playlist.id);
    } catch (error) {
      showError(errorMessage(error, "Could not create the playlist"));
    } finally {
      setBusy("");
    }
  };

  const handleRename = async () => {
    const name = renameValue.trim();
    if (!name || !selectedId) return;
    setBusy("rename");
    try {
      await renameNavidromePlaylist(selectedId, name);
      await refreshAll();
      setRenameOpen(false);
      showSuccess(`Renamed to ${name}`);
    } catch (error) {
      showError(errorMessage(error, "Could not rename the playlist"));
    } finally {
      setBusy("");
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    setBusy("delete");
    try {
      await deleteNavidromePlaylist(selectedId);
      await refreshAll();
      setDeleteOpen(false);
      showSuccess("Playlist deleted");
      select(null);
    } catch (error) {
      showError(errorMessage(error, "Could not delete the playlist"));
    } finally {
      setBusy("");
    }
  };

  const handleRemove = async (track) => {
    if (!selectedId || track?.index == null) return;
    setRemovingIndex(track.index);
    try {
      await removeNavidromePlaylistEntry(selectedId, track.index, track.navidromeId);
      await refreshAll();
      showSuccess(`Removed ${track.title || "track"}`);
    } catch (error) {
      showError(errorMessage(error, "Could not remove the track"));
      if (error?.response?.status === 409) detail.refetch();
    } finally {
      setRemovingIndex(null);
    }
  };

  const connected = status.data?.connected !== false;
  const statusError = status.data?.enabled === false
    ? "Navidrome playlists are not enabled on this server."
    : status.data?.connected === false
      ? status.data?.error || "Navidrome is not reachable as your user."
      : "";

  const renderPlaylistButton = (playlist) => {
    const active = String(playlist.id) === selectedId;
    return (
      <button
        key={playlist.id}
        type="button"
        className={`nd-playlists__item${active ? " is-active" : ""}`}
        aria-current={active ? "true" : undefined}
        onClick={() => select(playlist.id)}
      >
        <ListMusic className="artist-icon-sm nd-playlists__item-icon" aria-hidden="true" />
        <span className="nd-playlists__item-copy">
          <span className="nd-playlists__item-name">{playlist.name || "Untitled"}</span>
          <span className="nd-playlists__item-meta">
            {pluralize(playlist.trackCount, "track")}
            {!playlist.owned && playlist.ownerUsername ? ` · ${playlist.ownerUsername}` : ""}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="nd-playlists">
      <header className="nd-playlists__header">
        <div>
          <h1 className="page-title">Playlists</h1>
          <p className="page-subtitle">
            Your Navidrome playlists{status.data?.username ? ` as ${status.data.username}` : ""}. Changes
            here show up in every Navidrome app straight away.
          </p>
        </div>
        <div className="nd-playlists__header-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setCreateOpen(true)}
            disabled={!connected || busy === "create"}
          >
            <Plus className="artist-icon-sm" aria-hidden="true" />
            New playlist
          </button>
        </div>
      </header>

      {statusError ? (
        <div className="nd-playlists__notice" role="status">
          <strong>Not connected.</strong> {statusError}
          {user?.role === "admin" ? (
            <span>
              {" "}
              Navidrome must trust Aurral&apos;s address for the username header, and Navidrome
              must be connected under Settings → Playback.
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="nd-playlists__body">
        <aside className="nd-playlists__list" aria-label="Playlists">
          {list.isLoading ? (
            <div className="nd-playlists__state">
              <DotLoader size="sm" label="Loading playlists" />
            </div>
          ) : list.error ? (
            <div className="nd-playlists__state">
              <p className="nd-playlists__empty">{errorMessage(list.error, "Could not load playlists.")}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => list.refetch()}>
                Try again
              </button>
            </div>
          ) : !playlists.length ? (
            <p className="nd-playlists__empty">
              No playlists yet. Make one with New playlist, or add a track from anywhere with
              Add to playlist.
            </p>
          ) : (
            <>
              <div className="nd-playlists__group-label">My playlists</div>
              {owned.length ? owned.map(renderPlaylistButton) : (
                <p className="nd-playlists__empty nd-playlists__empty--compact">None yet.</p>
              )}
              {others.length ? (
                <>
                  <div className="nd-playlists__group-label">Shared with me</div>
                  {others.map(renderPlaylistButton)}
                </>
              ) : null}
            </>
          )}
        </aside>

        <section className="nd-playlists__detail" aria-live="polite">
          {!selectedId ? (
            <div className="nd-playlists__placeholder">
              <ListMusic className="nd-playlists__placeholder-icon" aria-hidden="true" />
              <p>Pick a playlist to see its tracks.</p>
            </div>
          ) : detail.isLoading && !selected ? (
            <div className="nd-playlists__state">
              <DotLoader size="sm" label="Loading playlist" />
            </div>
          ) : detail.error ? (
            <div className="nd-playlists__state">
              <p className="nd-playlists__empty">{errorMessage(detail.error, "Could not load the playlist.")}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => detail.refetch()}>
                Try again
              </button>
            </div>
          ) : selected ? (
            <>
              <div className="nd-playlists__hero">
                <div className="nd-playlists__hero-copy">
                  <span className="nd-playlists__eyebrow">
                    {canEdit ? "Playlist" : `${selected.ownerUsername || "Shared"} · Playlist`}
                  </span>
                  <h2 className="nd-playlists__title">{selected.name || "Untitled"}</h2>
                  <p className="nd-playlists__meta">
                    {pluralize(selected.trackCount, "track")}
                    {selected.durationSeconds ? ` · ${formatDuration(selected.durationSeconds)}` : ""}
                    {selected.unavailableCount
                      ? ` · ${pluralize(selected.unavailableCount, "track")} not on this server`
                      : ""}
                  </p>
                </div>
                <div className="nd-playlists__hero-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => (isThisPlaylistPlaying ? togglePlayPause() : playFrom(null, false))}
                    disabled={!selected.tracks?.length}
                  >
                    {isThisPlaylistPlaying ? (
                      <Pause className="artist-icon-sm" aria-hidden="true" />
                    ) : (
                      <Play className="artist-icon-sm" aria-hidden="true" />
                    )}
                    {isThisPlaylistPlaying ? "Pause" : "Play"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => playFrom(null, true)}
                    disabled={!selected.tracks?.length}
                  >
                    <Shuffle className="artist-icon-sm" aria-hidden="true" />
                    Shuffle
                  </button>
                  {canEdit ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setRenameValue(selected.name || "");
                          setRenameOpen(true);
                        }}
                      >
                        <Pencil className="artist-icon-sm" aria-hidden="true" />
                        Rename
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost-danger btn-sm"
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2 className="artist-icon-sm" aria-hidden="true" />
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              {selected.tracks?.length ? (
                <ol className="nd-playlists__tracks">
                  {selected.tracks.map((track) => {
                    const playable = toPlayable(track, selectedId);
                    const isCurrent = Boolean(
                      playable && currentTrack && String(currentTrack.id) === playable.id,
                    );
                    return (
                      <li
                        key={`${track.index}-${track.navidromeId || track.trackId}`}
                        className={`nd-playlists__track${isCurrent ? " is-current" : ""}${track.available ? "" : " is-unavailable"}`}
                      >
                        <span className="nd-playlists__track-number">
                          {isCurrent && isPlaying ? (
                            <span className="nd-playlists__playing" aria-label="Playing" />
                          ) : (
                            track.index + 1
                          )}
                        </span>
                        <button
                          type="button"
                          className="nd-playlists__track-play"
                          onClick={() => (isCurrent ? togglePlayPause() : playFrom(track, false))}
                          disabled={!track.available}
                          aria-label={isCurrent && isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                        >
                          {isCurrent && isPlaying ? (
                            <Pause className="artist-icon-xs" aria-hidden="true" />
                          ) : (
                            <Play className="artist-icon-xs" aria-hidden="true" />
                          )}
                        </button>
                        <span className="nd-playlists__track-copy">
                          <span className="nd-playlists__track-title">{track.title || "Untitled"}</span>
                          <span className="nd-playlists__track-detail">
                            {[track.artistName, track.albumTitle].filter(Boolean).join(" · ")}
                            {track.available ? "" : " · not on this server"}
                          </span>
                        </span>
                        <span className="nd-playlists__track-rating">
                          {track.available ? (
                            <TrackRating trackId={track.trackId} albumId={track.albumId} title={track.title} size="sm" />
                          ) : null}
                        </span>
                        <span className="nd-playlists__track-duration">
                          {track.durationMs ? formatTrackDuration(track.durationMs) : ""}
                        </span>
                        {canEdit ? (
                          <TooltipButton
                            type="button"
                            className="btn btn-icon btn-xs btn-ghost nd-playlists__track-remove"
                            label="Remove from playlist"
                            onClick={() => handleRemove(track)}
                            disabled={removingIndex === track.index}
                          >
                            {removingIndex === track.index ? (
                              <DotLoader size="xs" label={null} />
                            ) : (
                              <X className="artist-icon-xs" aria-hidden="true" />
                            )}
                          </TooltipButton>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="nd-playlists__empty">
                  This playlist is empty. Use Add to playlist on any track to fill it.
                </p>
              )}
            </>
          ) : null}
        </section>
      </div>

      <CreatePlaylistModal
        open={createOpen}
        defaultName=""
        saving={busy === "create"}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreate}
      />

      <ModalShell
        open={renameOpen}
        title="Rename playlist"
        onClose={() => setRenameOpen(false)}
        disableClose={busy === "rename"}
        footer={
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRenameOpen(false)} disabled={busy === "rename"}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleRename} disabled={busy === "rename" || !renameValue.trim()}>
              {busy === "rename" ? <DotLoader size="xs" label={null} /> : null}
              Save
            </button>
          </>
        }
      >
        <label className="nd-playlists__field">
          <span>Name</span>
          <input
            type="text"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleRename();
            }}
            autoFocus
          />
        </label>
      </ModalShell>

      <ModalShell
        open={deleteOpen}
        title="Delete playlist"
        description="This removes the playlist from Navidrome for good. The tracks stay in the library."
        onClose={() => setDeleteOpen(false)}
        disableClose={busy === "delete"}
        footer={
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDeleteOpen(false)} disabled={busy === "delete"}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={handleDelete} disabled={busy === "delete"}>
              {busy === "delete" ? <DotLoader size="xs" label={null} /> : null}
              Delete
            </button>
          </>
        }
      >
        <p className="nd-playlists__confirm">Delete “{selected?.name || selectedSummary?.name || "this playlist"}”?</p>
      </ModalShell>
    </div>
  );
}
