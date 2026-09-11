import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  GripVertical,
  ListMusic,
  Sparkles,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Shuffle,
  Trash2,
  X,
} from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { CreatePlaylistModal, ModalShell } from "../components/PlaylistModals";
import SmartPlaylistEditor from "../components/SmartPlaylistEditor";
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
  clearNavidromePlaylistRules,
  createNavidromeSmartPlaylist,
  moveNavidromePlaylistEntry,
  removeNavidromePlaylistEntries,
  removeNavidromePlaylistEntry,
  renameNavidromePlaylist,
  setNavidromePlaylistRules,
} from "../utils/api/endpoints/playlists.js";
import "./navidromePlaylists.css";

/**
 * Hand-made playlists, held in Navidrome and shown here as the signed-in
 * user. Everything on this page is a live read of Navidrome; edits go
 * straight back, so a Navidrome client on the phone sees them at once.
 */

// Long playlists are rendered a window at a time. Dad's largest is twelve
// thousand tracks, and laying that out at once takes seconds.
const TRACK_WINDOW = 300;

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
  const [filter, setFilter] = useState("");
  const [selectedIndexes, setSelectedIndexes] = useState(() => new Set());
  const [visibleLimit, setVisibleLimit] = useState(TRACK_WINDOW);
  const [smartMode, setSmartMode] = useState("");
  const [dragIndex, setDragIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const lastClickedIndex = useRef(null);

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

  const tracks = useMemo(
    () => (Array.isArray(selected?.tracks) ? selected.tracks : []),
    [selected],
  );

  // Searching inside a playlist. Everything is already loaded, so this is a
  // plain filter; each row keeps the position it holds in the real playlist.
  const query = filter.trim().toLowerCase();
  const visibleTracks = useMemo(() => {
    if (!query) return tracks;
    return tracks.filter((track) => [track.title, track.artistName, track.albumTitle]
      .some((value) => String(value || "").toLowerCase().includes(query)));
  }, [tracks, query]);
  const windowedTracks = useMemo(
    () => visibleTracks.slice(0, visibleLimit),
    [visibleTracks, visibleLimit],
  );

  // A smart playlist's contents come from its rules, so its rows are not
  // something to reorder, remove or pick from.
  const isSmart = Boolean(selected?.smart ?? selectedSummary?.smart);
  const canEditTracks = canEdit && !isSmart;

  // Dragging a row onto another only makes sense against the whole playlist:
  // with a filter on, the row above is not the row above.
  const canReorder = canEditTracks && !query;
  const selectedCount = selectedIndexes.size;

  // A different playlist, or a different filter, starts again from the top
  // with nothing selected.
  useEffect(() => {
    setSelectedIndexes(new Set());
    setFilter("");
    setVisibleLimit(TRACK_WINDOW);
    lastClickedIndex.current = null;
  }, [selectedId]);

  useEffect(() => {
    setVisibleLimit(TRACK_WINDOW);
  }, [query]);

  const toggleSelected = useCallback((index, { range = false } = {}) => {
    setSelectedIndexes((current) => {
      const next = new Set(current);
      const anchorIndex = lastClickedIndex.current;
      if (range && anchorIndex !== null) {
        // Shift-click takes everything between, as a list does everywhere.
        const positions = visibleTracks.map((track) => track.index);
        const from = positions.indexOf(anchorIndex);
        const to = positions.indexOf(index);
        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from];
          for (let step = start; step <= end; step += 1) next.add(positions[step]);
          return next;
        }
      }
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
    lastClickedIndex.current = index;
  }, [visibleTracks]);

  const selectAllVisible = useCallback(() => {
    setSelectedIndexes(new Set(visibleTracks.map((track) => track.index)));
  }, [visibleTracks]);

  const clearSelection = useCallback(() => {
    setSelectedIndexes(new Set());
    lastClickedIndex.current = null;
  }, []);

  const handleRemoveSelected = async () => {
    if (!selectedId || !selectedCount) return;
    const byIndex = new Map(tracks.map((track) => [track.index, track]));
    const entries = [...selectedIndexes]
      .sort((a, b) => a - b)
      .map((index) => ({ index, songId: byIndex.get(index)?.navidromeId || null }));
    setBusy("remove-selected");
    try {
      await removeNavidromePlaylistEntries(selectedId, entries);
      await refreshAll();
      clearSelection();
      showSuccess(`Removed ${pluralize(entries.length, "track")}`);
    } catch (error) {
      showError(errorMessage(error, "Could not remove the tracks"));
      if (error?.response?.status === 409) detail.refetch();
    } finally {
      setBusy("");
    }
  };

  const moveTrack = useCallback(
    async (fromIndex, toIndex) => {
      if (fromIndex === toIndex || toIndex < 0 || toIndex >= tracks.length) return;
      const track = tracks.find((entry) => entry.index === fromIndex);
      try {
        await moveNavidromePlaylistEntry(selectedId, fromIndex, toIndex, track?.navidromeId || null);
        await refreshAll();
        clearSelection();
      } catch (error) {
        showError(errorMessage(error, "Could not reorder the playlist"));
        if (error?.response?.status === 409) detail.refetch();
      }
    },
    [clearSelection, detail, refreshAll, selectedId, showError, tracks],
  );

  const handleCreateSmart = async ({ name, rules }) => {
    setBusy("smart");
    try {
      const result = await createNavidromeSmartPlaylist({ name, rules });
      await refreshAll();
      setSmartMode("");
      showSuccess(`Created ${name}`);
      if (result?.playlist?.id) select(result.playlist.id);
    } catch (error) {
      showError(errorMessage(error, "Could not create the smart playlist"));
    } finally {
      setBusy("");
    }
  };

  const handleSaveRules = async ({ rules }) => {
    if (!selectedId) return;
    setBusy("smart");
    try {
      await setNavidromePlaylistRules(selectedId, rules);
      await refreshAll();
      await detail.refetch();
      setSmartMode("");
      showSuccess("Rules saved");
    } catch (error) {
      showError(errorMessage(error, "Could not save the rules"));
    } finally {
      setBusy("");
    }
  };

  const handleClearRules = async () => {
    if (!selectedId) return;
    setBusy("smart");
    try {
      await clearNavidromePlaylistRules(selectedId);
      await refreshAll();
      await detail.refetch();
      showSuccess("This playlist no longer updates itself");
    } catch (error) {
      showError(errorMessage(error, "Could not remove the rules"));
    } finally {
      setBusy("");
    }
  };

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
        {playlist.smart ? (
          <Sparkles className="artist-icon-sm nd-playlists__item-icon" aria-hidden="true" />
        ) : (
          <ListMusic className="artist-icon-sm nd-playlists__item-icon" aria-hidden="true" />
        )}
        <span className="nd-playlists__item-copy">
          <span className="nd-playlists__item-name">{playlist.name || "Untitled"}</span>
          <span className="nd-playlists__item-meta">
            {playlist.smart ? "Smart · " : ""}
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
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setSmartMode("create")}
            disabled={!connected || busy === "smart"}
          >
            <Sparkles className="artist-icon-sm" aria-hidden="true" />
            New smart playlist
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
                    {isSmart ? "Updates itself · " : ""}
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
                  {canEdit && isSmart ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setSmartMode("edit")}
                        disabled={!selected.rules}
                        title={selected.rules
                          ? undefined
                          : "These rules were written elsewhere and cannot be shown here"}
                      >
                        <Sparkles className="artist-icon-sm" aria-hidden="true" />
                        Edit rules
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handleClearRules}
                        disabled={busy === "smart"}
                      >
                        Stop updating
                      </button>
                    </>
                  ) : null}
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

              {tracks.length ? (
                <>
                  <div className="nd-playlists__toolbar">
                    <label className="nd-playlists__search">
                      <Search className="artist-icon-xs" aria-hidden="true" />
                      <input
                        type="search"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        placeholder="Search this playlist"
                        aria-label="Search this playlist"
                      />
                      {filter ? (
                        <button
                          type="button"
                          className="nd-playlists__search-clear"
                          onClick={() => setFilter("")}
                          aria-label="Clear search"
                        >
                          <X className="artist-icon-xs" aria-hidden="true" />
                        </button>
                      ) : null}
                    </label>
                    <span className="nd-playlists__toolbar-count">
                      {query
                        ? `${pluralize(visibleTracks.length, "match")} of ${tracks.length}`
                        : pluralize(tracks.length, "track")}
                    </span>
                  </div>

                  {canEditTracks && selectedCount ? (
                    <div className="nd-playlists__selection" role="status">
                      <span>{pluralize(selectedCount, "track")} selected</span>
                      <button
                        type="button"
                        className="btn btn-ghost-danger btn-xs"
                        onClick={handleRemoveSelected}
                        disabled={busy === "remove-selected"}
                      >
                        {busy === "remove-selected" ? (
                          <DotLoader size="xs" label={null} />
                        ) : (
                          <Trash2 className="artist-icon-xs" aria-hidden="true" />
                        )}
                        Remove
                      </button>
                      <button type="button" className="btn btn-ghost btn-xs" onClick={selectAllVisible}>
                        Select all{query ? " matching" : ""}
                      </button>
                      <button type="button" className="btn btn-ghost btn-xs" onClick={clearSelection}>
                        Clear
                      </button>
                    </div>
                  ) : null}

                  {visibleTracks.length ? (
                    <ol className="nd-playlists__tracks">
                      {windowedTracks.map((track) => {
                        const playable = toPlayable(track, selectedId);
                        const isCurrent = Boolean(
                          playable && currentTrack && String(currentTrack.id) === playable.id,
                        );
                        const isSelected = selectedIndexes.has(track.index);
                        const isDropTarget = dropIndex === track.index && dragIndex !== track.index;
                        return (
                          <li
                            key={`${track.index}-${track.navidromeId || track.trackId}`}
                            className={`nd-playlists__track${isCurrent ? " is-current" : ""}${track.available ? "" : " is-unavailable"}${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${dragIndex === track.index ? " is-dragging" : ""}`}
                            draggable={canReorder}
                            onDragStart={canReorder ? () => setDragIndex(track.index) : undefined}
                            onDragOver={canReorder ? (event) => {
                              event.preventDefault();
                              setDropIndex(track.index);
                            } : undefined}
                            onDrop={canReorder ? (event) => {
                              event.preventDefault();
                              if (dragIndex !== null) moveTrack(dragIndex, track.index);
                              setDragIndex(null);
                              setDropIndex(null);
                            } : undefined}
                            onDragEnd={canReorder ? () => {
                              setDragIndex(null);
                              setDropIndex(null);
                            } : undefined}
                            onKeyDown={canReorder ? (event) => {
                              // Alt with an arrow moves the row, for anyone not
                              // dragging with a mouse.
                              if (!event.altKey) return;
                              if (event.key === "ArrowUp") {
                                event.preventDefault();
                                moveTrack(track.index, track.index - 1);
                              } else if (event.key === "ArrowDown") {
                                event.preventDefault();
                                moveTrack(track.index, track.index + 1);
                              }
                            } : undefined}
                          >
                            {canEditTracks ? (
                              <input
                                type="checkbox"
                                className="nd-playlists__track-select"
                                checked={isSelected}
                                onChange={() => {}}
                                onClick={(event) => toggleSelected(track.index, { range: event.shiftKey })}
                                aria-label={`Select ${track.title || "track"}`}
                              />
                            ) : null}
                            {canReorder ? (
                              <span className="nd-playlists__track-grip" aria-hidden="true">
                                <GripVertical className="artist-icon-xs" />
                              </span>
                            ) : null}
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
                            {canEditTracks ? (
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
                    <p className="nd-playlists__empty">Nothing in this playlist matches “{filter}”.</p>
                  )}

                  {visibleTracks.length > windowedTracks.length ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm nd-playlists__more"
                      onClick={() => setVisibleLimit((current) => current + TRACK_WINDOW)}
                    >
                      Show more ({visibleTracks.length - windowedTracks.length} left)
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="nd-playlists__empty">
                  This playlist is empty. Use Add to playlist on any track to fill it.
                </p>
              )}
            </>
          ) : null}
        </section>
      </div>

      <SmartPlaylistEditor
        open={Boolean(smartMode)}
        mode={smartMode === "edit" ? "edit" : "create"}
        initialName={smartMode === "edit" ? selected?.name || "" : ""}
        initialRules={smartMode === "edit" ? selected?.rules || null : null}
        busy={busy === "smart"}
        onClose={() => setSmartMode("")}
        onSave={smartMode === "edit" ? handleSaveRules : handleCreateSmart}
      />

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
