import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  addArtistToLibrary,
  requestAlbumFromSearch,
} from "../utils/api/endpoints/library.js";
import {
  addSharedPlaylistTracks,
  createSharedPlaylist,
} from "../utils/api/endpoints/playlists.js";
import { getTagSuggestions } from "../utils/api/endpoints/discovery.js";
import { getMyTags } from "../utils/api/endpoints/tags.js";
import { searchPathFor, searchScopeFor } from "../utils/searchScope";
import { useLibraryScope } from "../hooks/useLibraryScope";
import { searchUnified } from "../utils/api/endpoints/search.js";
import { getArtistRecordId } from "../utils/artistTaste";
import {
  buildUnifiedSuggestionSections,
  flattenSuggestionSections,
  navigateFromSearchResult,
} from "../utils/searchNavigation";
import {
  addRecentSearch,
  clearRecentSearches,
  readRecentSearches,
} from "../utils/recentSearches";

import {
  AUTOCOMPLETE_DEBOUNCE_MS,
  LIBRARY_SUGGEST_DEBOUNCE_MS,
  SUGGEST_LIMIT,
  TAG_SUGGESTIONS_LIMIT,
  ALBUM_PENDING_STATUSES,
  isEditableTarget,
  getSuggestionTitle,
  getSuggestionMeta,
  getSuggestionItemId,
  getTrackSavingKey,
  isSuggestionInLibrary,
  buildTrackPlaylistPayload,
} from "../utils/globalSearchUtils";
import { getAlbumAddButtonLabel, shouldTriggerAlbumSearch } from "../utils/albumAddAction";
import { useDebouncedTask } from "../hooks/useDebouncedTask";
import { useSharedPlaylists } from "../hooks/useSharedPlaylists";
import { useNavigate, useLocation } from "react-router-dom";
import { Clock, Compass, Globe, Search } from "lucide-react";
import { DotLoader } from "./DotLoader";
import AddActionButton from "./AddActionButton";
import SearchLibraryCheck from "./SearchLibraryCheck";
import { TrackPlaylistMenu } from "../pages/ArtistDetails/components/TrackPlaylistMenu";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { searchSettingsItems } from "../pages/Settings/settingsTabsConfig";
function GlobalSearch({ settingsMode = false }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [lastfmConfigured, setLastfmConfigured] = useState(true);
  const [localSearchConfigured, setLocalSearchConfigured] = useState(true);
  const [suggestionRows, setSuggestionRows] = useState([]);
  const [suggestionMode, setSuggestionMode] = useState(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [inputFocused, setInputFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState(() => readRecentSearches());
  const searchContainerRef = useRef(null);
  const inputRef = useRef(null);
  const { schedule: scheduleSuggest, cancel: cancelSuggest } = useDebouncedTask();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission, bootstrap, user } = useAuth();
  // Library pages search the library; Discover searches everything.
  const scope = settingsMode ? "settings" : searchScopeFor(location.pathname);
  const inLibrary = scope === "library";
  const [libraryScope, chooseLibraryScope] = useLibraryScope(user?.id);
  const { showSuccess, showError } = useToast();
  const {
    sharedPlaylists,
    setSharedPlaylists,
    playlistsLoading: playlistModalLoading,
    playlistsError: playlistModalError,
    setPlaylistsError: setPlaylistModalError,
    loadSharedPlaylists,
  } = useSharedPlaylists();
  const canAddArtist = hasPermission("addArtist");
  const canAddAlbum = hasPermission("addAlbum");
  const [pendingArtistIds, setPendingArtistIds] = useState({});
  const [pendingAlbumIds, setPendingAlbumIds] = useState({});
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");

  const selectableRows = useMemo(() => {
    if (suggestionMode === "tag") return suggestionRows;
    return suggestionRows.filter((row) =>
      ["item", "search-all", "show-server", "own-tag"].includes(row.kind));
  }, [suggestionRows, suggestionMode]);

  const settingsSearchResults = useMemo(() => {
    if (!settingsMode) return [];
    return searchSettingsItems(searchQuery);
  }, [searchQuery, settingsMode]);

  const showRecentSearches = useMemo(
    () =>
      inputFocused &&
      !settingsMode &&
      searchQuery.trim().length < 2 &&
      recentSearches.length > 0 &&
      !loadingSuggestions &&
      suggestionRows.length === 0,
    [
      inputFocused,
      loadingSuggestions,
      recentSearches.length,
      searchQuery,
      settingsMode,
      suggestionRows.length,
    ],
  );

  const recentSelectableRows = useMemo(
    () =>
      showRecentSearches
        ? recentSearches.map((query, index) => ({
            kind: "recent",
            key: `recent:${query}:${index}`,
            query,
          }))
        : [],
    [recentSearches, showRecentSearches],
  );

  const keyboardRows = settingsMode
    ? settingsSearchResults
    : showRecentSearches
      ? recentSelectableRows
      : selectableRows;

  const rememberSearch = useCallback((rawQuery) => {
    const next = addRecentSearch(rawQuery);
    setRecentSearches(next);
  }, []);

  const closeAutocomplete = useCallback(() => {
    setSuggestionRows([]);
    setSuggestionMode(null);
    setSuggestionIndex(-1);
  }, []);

  useEffect(() => {
    if (bootstrap) {
      setLastfmConfigured(!!bootstrap.lastfmConfigured);
    }
  }, [bootstrap]);

  useEffect(() => {
    setSearchQuery("");
    closeAutocomplete();
  }, [location.pathname, location.search, closeAutocomplete]);

  useEffect(() => {
    const handleGlobalKeyDown = (event) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (settingsMode) {
      cancelSuggest();
      setLoadingSuggestions(false);
      closeAutocomplete();
      return cancelSuggest;
    }
    // In the library, #word is one of their own tags, and leads to the songs
    // carrying it. In Discover it is a genre to explore, from Last.fm.
    if (inLibrary && trimmed.startsWith("#")) {
      const wanted = trimmed.slice(1).trim().toLowerCase();
      scheduleSuggest(async (isCurrent, signal) => {
        setLoadingSuggestions(true);
        try {
          const data = await getMyTags({ signal });
          if (!isCurrent()) return;
          const tags = (data?.tags || [])
            .filter((entry) => !wanted || entry.tag.includes(wanted))
            .sort((a, b) => Number(b.tag.startsWith(wanted)) - Number(a.tag.startsWith(wanted)) || b.songs - a.songs)
            .slice(0, TAG_SUGGESTIONS_LIMIT);
          setSuggestionRows(tags.map((entry) => ({
            kind: "own-tag",
            key: `own-tag:${entry.tag}`,
            tagName: entry.tag,
            songs: entry.songs,
          })));
          setSuggestionMode("own-tag");
          setSuggestionIndex(-1);
        } catch {
          if (isCurrent()) closeAutocomplete();
        } finally {
          if (isCurrent()) setLoadingSuggestions(false);
        }
      }, AUTOCOMPLETE_DEBOUNCE_MS);
      return cancelSuggest;
    }

    const isTagShortcut = lastfmConfigured && trimmed.startsWith("#");
    const tagPart = isTagShortcut ? trimmed.slice(1).trim() : trimmed;

    if (isTagShortcut) {
      if (tagPart.length < 2) {
        cancelSuggest();
        setLoadingSuggestions(false);
        closeAutocomplete();
        return;
      }

      scheduleSuggest(async (isCurrent) => {
        setLoadingSuggestions(true);
        try {
          const data = await getTagSuggestions(tagPart, TAG_SUGGESTIONS_LIMIT);
          if (!isCurrent()) return;
          const raw = data.tags || [];
          const seen = new Set();
          const tags = raw.filter((tag) => {
            const key = String(tag || "")
              .trim()
              .toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          setSuggestionRows(
            tags.map((tagName) => ({
              kind: "tag",
              key: `tag:${tagName}`,
              tagName,
            })),
          );
          setSuggestionMode("tag");
          setSuggestionIndex(-1);
        } catch {
          if (isCurrent()) {
            closeAutocomplete();
          }
        } finally {
          if (isCurrent()) {
            setLoadingSuggestions(false);
          }
        }
      }, AUTOCOMPLETE_DEBOUNCE_MS);

      return cancelSuggest;
    }

    if (trimmed.length < 2) {
      cancelSuggest();
      setLoadingSuggestions(false);
      closeAutocomplete();
      return;
    }

    // Suggestions come from the library alone: instant, and only things the
    // person already has. The wider catalog is one Enter away.
    scheduleSuggest(async (isCurrent, signal) => {
      setLoadingSuggestions(true);
      try {
        const data = await searchUnified(trimmed, {
          mode: "library",
          limit: SUGGEST_LIMIT,
          signal,
        });
        if (!isCurrent()) return;
        setLocalSearchConfigured(!!data?.localSearchConfigured);
        // Looking at their own library, matches elsewhere on the server are
        // counted rather than listed, with a way to show them.
        let shown = data;
        let onServer = 0;
        if (inLibrary && libraryScope === "mine") {
          const theirs = (items) => (items || []).filter((item) => item.inUserLibrary !== false);
          const library = data?.library || {};
          onServer = ["artists", "albums", "tracks"]
            .reduce((sum, key) => sum + (library[key] || []).filter((item) => item.inUserLibrary === false).length, 0);
          shown = {
            ...data,
            library: { artists: theirs(library.artists), albums: theirs(library.albums), tracks: theirs(library.tracks) },
          };
        }
        const sections = buildUnifiedSuggestionSections(shown);
        const rows = flattenSuggestionSections(sections);
        if (onServer) {
          rows.push({ kind: "show-server", key: "show-server", query: trimmed, count: onServer });
        }
        rows.push({
          kind: "search-all",
          key: "search-all",
          query: trimmed,
          hasLibraryRows: rows.some((row) => row.kind === "item"),
        });
        setSuggestionRows(rows);
        setSuggestionMode("unified");
        setSuggestionIndex(-1);
      } catch {
        if (isCurrent()) {
          closeAutocomplete();
        }
      } finally {
        if (isCurrent()) {
          setLoadingSuggestions(false);
        }
      }
    }, LIBRARY_SUGGEST_DEBOUNCE_MS);

    return cancelSuggest;
  }, [
    searchQuery,
    closeAutocomplete,
    lastfmConfigured,
    scheduleSuggest,
    cancelSuggest,
    settingsMode,
    inLibrary,
    libraryScope,
  ]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target)) {
        closeAutocomplete();
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [closeAutocomplete]);

  const navigateToSearch = useCallback(
    (rawQuery) => {
      const trimmed = String(rawQuery || "").trim();
      if (!trimmed || settingsMode) return;
      rememberSearch(trimmed);
      if (trimmed.startsWith("#") && inLibrary) {
        navigate(`/library/tracks?tags=${encodeURIComponent(trimmed.slice(1).trim().toLowerCase())}`);
      } else if (trimmed.startsWith("#")) {
        navigate(`/search?q=${encodeURIComponent(trimmed.slice(1))}&type=tag`);
      } else {
        navigate(searchPathFor(scope, trimmed));
      }
      setSearchQuery("");
      closeAutocomplete();
      setInputFocused(false);
    },
    [navigate, closeAutocomplete, rememberSearch, settingsMode, inLibrary, scope],
  );

  const navigateToSettings = useCallback(
    (tab) => {
      if (!tab) return;
      navigate(`/settings/${tab.id}`);
      setSearchQuery("");
      closeAutocomplete();
      setInputFocused(false);
    },
    [navigate, closeAutocomplete],
  );

  const handleSubmit = (event) => {
    event.preventDefault();
    if (settingsMode) {
      navigateToSettings(settingsSearchResults[0]);
      return;
    }
    navigateToSearch(searchQuery);
  };

  const handleSuggestionSelect = useCallback(
    (selection) => {
      if (!selection) return;

      if (selection.kind === "recent") {
        navigateToSearch(selection.query);
        return;
      }

      // The way out of the library: the same words, searched in Discover.
      if (selection.kind === "search-all") {
        rememberSearch(selection.query);
        navigate(searchPathFor("discover", selection.query));
        setSearchQuery("");
        closeAutocomplete();
        setInputFocused(false);
        return;
      }

      // Show what the rest of the server has too; the list redraws itself.
      if (selection.kind === "show-server") {
        chooseLibraryScope("server");
        return;
      }

      if (selection.kind === "own-tag") {
        rememberSearch(`#${selection.tagName}`);
        navigate(`/library/tracks?tags=${encodeURIComponent(selection.tagName)}`);
        setSearchQuery("");
        closeAutocomplete();
        setInputFocused(false);
        return;
      }

      if (selection.kind === "tag") {
        rememberSearch(`#${selection.tagName}`);
        navigate(`/search?q=${encodeURIComponent(selection.tagName)}&type=tag`);
        setSearchQuery("");
        closeAutocomplete();
        setInputFocused(false);
        return;
      }

      if (selection.kind === "item") {
        const query = searchQuery.trim();
        if (query) rememberSearch(query);
        navigateFromSearchResult(navigate, selection.item, { query, scope });
        setSearchQuery("");
        closeAutocomplete();
        setInputFocused(false);
      }
    },
    [navigate, navigateToSearch, rememberSearch, searchQuery, closeAutocomplete, chooseLibraryScope, scope],
  );

  const handleClearRecentSearches = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setRecentSearches(clearRecentSearches());
    setSuggestionIndex(-1);
  }, []);

  const updateSuggestionItem = useCallback((targetItem, updates) => {
    if (!targetItem) return;
    const targetType = targetItem.type;
    const targetId = getSuggestionItemId(targetItem);
    setSuggestionRows((rows) =>
      rows.map((row) => {
        if (row.kind !== "item" || row.item?.type !== targetType) return row;
        const currentId = getSuggestionItemId(row.item);
        if (!targetId || currentId !== targetId) return row;
        const patch = typeof updates === "function" ? updates(row.item) : updates || {};
        return {
          ...row,
          item: {
            ...row.item,
            ...patch,
          },
        };
      }),
    );
  }, []);

  const handleArtistAction = useCallback(
    async (artist) => {
      const artistId = getArtistRecordId(artist);
      if (!artist?.name || !artistId) return false;
      setPendingArtistIds((prev) => ({ ...prev, [artistId]: true }));
      try {
        await addArtistToLibrary({
          foreignArtistId: artistId,
          artistName: artist.name,
        });
        updateSuggestionItem(artist, { inLibrary: true });
        showSuccess(`Adding ${artist.name}...`);
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message ||
            err.response?.data?.error ||
            err.message ||
            "Failed to add artist to library",
        );
        return false;
      } finally {
        setPendingArtistIds(({ [artistId]: _, ...prev }) => prev);
      }
    },
    [showError, showSuccess, updateSuggestionItem],
  );

  const handleAlbumAction = useCallback(
    async (album) => {
      if (!album?.id) return;
      const shouldTriggerSearch = shouldTriggerAlbumSearch({
        status: album.status,
        inLibrary: album.inLibrary,
        monitored: album.monitored,
      });
      setPendingAlbumIds((prev) => ({ ...prev, [album.id]: true }));
      try {
        const result = await requestAlbumFromSearch({
          albumMbid: album.id,
          albumName: album.title,
          artistMbid: album.artistMbid,
          artistName: album.artistName,
          triggerSearch: shouldTriggerSearch,
        });
        const nextAlbum = result?.queued
          ? { inLibrary: true, status: "processing" }
          : {
              inLibrary: true,
              libraryAlbumId: result.album?.id,
              libraryArtistId: result.artist?.id,
              status: result.status,
            };
        updateSuggestionItem(album, nextAlbum);
        showSuccess(
          result?.queued
            ? `Adding ${album.title}...`
            : result.triggeredSearch
              ? `Search triggered for ${album.title}`
              : `${album.title} added to library`,
        );
      } catch (err) {
        showError(
          err.response?.data?.error ||
            err.response?.data?.message ||
            err.message ||
            "Failed to request album",
        );
      } finally {
        setPendingAlbumIds(({ [album.id]: _, ...prev }) => prev);
      }
    },
    [showError, showSuccess, updateSuggestionItem],
  );

  const handleSearchTrackAdd = useCallback(
    async (track, target) => {
      const payload = buildTrackPlaylistPayload(track);
      if (!payload) {
        showError("Track details are incomplete");
        return;
      }

      const savingKey = getTrackSavingKey(track);
      setPlaylistModalError("");
      setPlaylistMenuSavingKey(savingKey);
      try {
        if (target?.mode === "new") {
          const name = String(target?.name || "").trim() || "Playlist";
          const response = await createSharedPlaylist({
            name,
            tracks: [payload],
          });
          showSuccess(`Track saved to ${response?.playlist?.name || name}`);
        } else {
          const targetPlaylist = sharedPlaylists.find(
            (playlist) => playlist.id === target?.playlistId,
          );
          await addSharedPlaylistTracks(target.playlistId, {
            tracks: [payload],
          });
          showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
        }

        const nextPlaylists = await loadSharedPlaylists();
        if (nextPlaylists) {
          setSharedPlaylists(nextPlaylists);
        }
      } catch (err) {
        const message =
          err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to save track to playlist";
        setPlaylistModalError(message);
        showError(message);
      } finally {
        setPlaylistMenuSavingKey("");
      }
    },
    [loadSharedPlaylists, setPlaylistModalError, setSharedPlaylists, sharedPlaylists, showError, showSuccess],
  );

  const addToMyLibrary = useCallback(async (item, mbid) => {
    setPendingArtistIds((current) => ({ ...current, [mbid]: true }));
    try {
      const { addArtistToMyLibrary } = await import("../utils/api/endpoints/userLibrary.js");
      await addArtistToMyLibrary(mbid);
      updateSuggestionItem(item, { inUserLibrary: true });
      showSuccess(`Added ${item.artistName || item.name || "that artist"} to your library`);
    } catch (error) {
      showError(error?.response?.data?.error || error?.message || "Could not add that to your library");
    } finally {
      setPendingArtistIds((current) => {
        const next = { ...current };
        delete next[mbid];
        return next;
      });
    }
  }, [showError, showSuccess, updateSuggestionItem]);

  const renderSuggestionAction = useCallback(
    (item) => {
      if (!item) return null;
      if (isSuggestionInLibrary(item) && item.inUserLibrary !== false && item.type !== "track") {
        return <SearchLibraryCheck />;
      }

      // On the server, but not in their own library. Personal libraries hold
      // whole artists, so that is what the button adds - for an album it is
      // the artist behind it.
      if (item.inUserLibrary === false && bootstrap?.userLibrariesEnabled === true) {
        const mbid = item.type === "artist"
          ? (item.mbid || getArtistRecordId(item))
          : (item.artistMbid || item.artist?.mbid);
        if (mbid) {
          return (
            <AddActionButton
              disabled={!!pendingArtistIds[mbid]}
              isLoading={!!pendingArtistIds[mbid]}
              label="Add to my library"
              onClick={(event) => {
                event.stopPropagation();
                addToMyLibrary(item, mbid);
              }}
            />
          );
        }
        return null;
      }

      if (item.type === "artist") {
        const artistId = getArtistRecordId(item);
        if (!canAddArtist || !artistId) return null;
        return (
          <AddActionButton
            disabled={!!pendingArtistIds[artistId]}
            isLoading={!!pendingArtistIds[artistId]}
            label="Add to Lidarr"
            onClick={(event) => {
              event.stopPropagation();
              handleArtistAction(item);
            }}
          />
        );
      }

      if (item.type === "album") {
        if (!canAddAlbum || !item.id) return null;
        const pending = !!pendingAlbumIds[item.id];
        return (
          <AddActionButton
            onClick={(event) => {
              event.stopPropagation();
              handleAlbumAction(item);
            }}
            isLoading={pending}
            disabled={pending || ALBUM_PENDING_STATUSES.has(item.status)}
            label={getAlbumAddButtonLabel({
              status: item.status,
              inLibrary: item.inLibrary,
              monitored: item.monitored,
            })}
          />
        );
      }

      if (item.type === "track") {
        const savingKey = getTrackSavingKey(item);
        return (
          <TrackPlaylistMenu
            track={item}
            triggerLabel="Add to playlist"
            playlists={sharedPlaylists}
            loading={playlistModalLoading}
            saving={playlistMenuSavingKey === savingKey}
            error={playlistModalError}
            defaultNewPlaylistName={`${item.artistName || "Artist"} Picks`}
            menuVariant="search-suggestion"
            onLoadPlaylists={loadSharedPlaylists}
            onSelect={(target) => handleSearchTrackAdd(item, target)}
          />
        );
      }

      return null;
    },
    [
      addToMyLibrary,
      bootstrap?.userLibrariesEnabled,
      canAddAlbum,
      canAddArtist,
      handleAlbumAction,
      handleArtistAction,
      handleSearchTrackAdd,
      loadSharedPlaylists,
      pendingAlbumIds,
      pendingArtistIds,
      playlistMenuSavingKey,
      playlistModalError,
      playlistModalLoading,
      sharedPlaylists,
    ],
  );

  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      closeAutocomplete();
      return;
    }
    if (keyboardRows.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSuggestionIndex((current) => (current < keyboardRows.length - 1 ? current + 1 : current));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestionIndex((current) => (current > 0 ? current - 1 : -1));
    } else if (event.key === "Enter" && suggestionIndex >= 0) {
      event.preventDefault();
      if (settingsMode) {
        navigateToSettings(keyboardRows[suggestionIndex]);
      } else {
        handleSuggestionSelect(keyboardRows[suggestionIndex]);
      }
    }
  };

  let selectableCursor = -1;
  const emptySearchPlaceholder = settingsMode ? (
    <>
      <span className="global-search__scope-label--short">Search settings</span>
      <span className="global-search__scope-label--full">Type</span>
      <span className="global-search__key">/</span>
      <span className="global-search__scope-label--full">to search</span>
    </>
  ) : inputFocused ? (
    <span className="global-search__scope-label--full">
      {inLibrary ? "Search your library, or #tag" : "Search everything: music, artists, or #rock"}
    </span>
  ) : (
    <>
      <span className="global-search__scope-label--short">{inLibrary ? "Search library" : "Search everything"}</span>
      <span className="global-search__scope-label--full">Type</span>
      <span className="global-search__key">/</span>
      <span className="global-search__scope-label--full">
        {inLibrary ? "to search your library" : "to search everything"}
      </span>
    </>
  );

  return (
    <form ref={searchContainerRef} onSubmit={handleSubmit} className="global-search">
      <div className="global-search__box global-search__box--unified" data-tour="search">
        <div className="global-search__input-wrap global-search__input-wrap--unified">
          <Search className="global-search__icon" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onFocus={() => {
              setInputFocused(true);
              setSuggestionIndex(-1);
            }}
            onBlur={() => {
              window.setTimeout(() => setInputFocused(false), 120);
            }}
            onKeyDown={handleKeyDown}
            placeholder=""
            aria-label={
              settingsMode ? "Search settings" : inLibrary ? "Search your library" : "Search everything"
            }
            className="global-search__input"
            autoComplete="off"
          />
          {!searchQuery && (
            <div className="global-search__placeholder">{emptySearchPlaceholder}</div>
          )}
          {loadingSuggestions && (
            <div className="global-search__loader">
              <DotLoader size="md" label={null} />
            </div>
          )}
        </div>
      </div>

      {!loadingSuggestions && settingsMode && settingsSearchResults.length > 0 && (
        <div className="global-search__suggestions global-search__suggestions--grouped">
          {settingsSearchResults.map((item, index) => (
            <button
              key={item.key}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => navigateToSettings(item)}
              className={`global-search__suggestion${
                index === suggestionIndex ? " is-highlighted" : ""
              }`}
            >
              <span className="global-search__settings-result-label">{item.label}</span>
              <span className="global-search__settings-result-meta">
                {item.kind === "page" ? "Settings" : `${item.kind} · ${item.tabLabel}`}
              </span>
            </button>
          ))}
        </div>
      )}

      {!loadingSuggestions &&
        !settingsMode &&
        suggestionMode === "unified" &&
        !localSearchConfigured &&
        searchQuery.trim().length >= 2 && (
          <div className="global-search__suggestions global-search__suggestions--grouped">
            <div className="global-search__suggestion-group">Search not configured</div>
            <div className="global-search__suggestion global-search__suggestion--message">
              Configure the search server in Settings to search artists, releases, and tracks.
            </div>
          </div>
        )}

      {!settingsMode && showRecentSearches && (
        <div className="global-search__suggestions global-search__suggestions--grouped global-search__suggestions--recent">
          <div className="global-search__recent-header">
            <span className="global-search__recent-label">Recent searches</span>
            <button
              type="button"
              className="global-search__recent-clear"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleClearRecentSearches}
            >
              Clear
            </button>
          </div>
          {recentSelectableRows.map((row, index) => (
            <button
              key={row.key}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => handleSuggestionSelect(row)}
              className={`global-search__suggestion global-search__suggestion--recent${
                index === suggestionIndex ? " is-highlighted" : ""
              }`}
            >
              <Clock className="global-search__recent-icon" aria-hidden="true" />
              <span className="global-search__recent-query">{row.query}</span>
            </button>
          ))}
        </div>
      )}

      {!loadingSuggestions && !settingsMode && suggestionRows.length > 0 && (
        <div className="global-search__suggestions global-search__suggestions--grouped">
          {suggestionMode === "own-tag"
            ? [
                <div key="own-tag-header" className="global-search__suggestion-group">Your tags</div>,
                ...suggestionRows.map((row, index) => (
                  <button
                    key={row.key}
                    type="button"
                    onClick={() => handleSuggestionSelect(row)}
                    className={`global-search__suggestion global-search__suggestion--own-tag${
                      index === suggestionIndex ? " is-highlighted" : ""
                    }`}
                  >
                    <span>#{row.tagName}</span>
                    <small>{row.songs} song{row.songs === 1 ? "" : "s"}</small>
                  </button>
                )),
              ]
            : suggestionMode === "tag"
            ? suggestionRows.map((row, index) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => handleSuggestionSelect(row)}
                  className={`global-search__suggestion${
                    index === suggestionIndex ? " is-highlighted" : ""
                  }`}
                >
                  #{row.tagName}
                </button>
              ))
            : suggestionRows.map((row) => {
                if (row.kind === "header") {
                  return (
                    <div key={row.key} className="global-search__suggestion-group">
                      {row.label}
                    </div>
                  );
                }
                if (row.kind === "show-server") {
                  selectableCursor += 1;
                  const highlighted = selectableCursor === suggestionIndex;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleSuggestionSelect(row)}
                      className={`global-search__suggestion global-search__suggestion--search-all${
                        highlighted ? " is-highlighted" : ""
                      }`}
                    >
                      <Globe className="artist-icon-sm" aria-hidden="true" />
                      <span>
                        {row.count} more on the server
                        <small>Music others have added. Show the whole server&apos;s library</small>
                      </span>
                    </button>
                  );
                }
                if (row.kind === "search-all") {
                  selectableCursor += 1;
                  const highlighted = selectableCursor === suggestionIndex;
                  return (
                    <div key={row.key} className="global-search__suggestion-footer">
                      {!row.hasLibraryRows ? (
                        <div className="global-search__suggestion-group">
                          {inLibrary ? "Nothing in your library matches" : "Nothing on the server matches yet"}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => handleSuggestionSelect(row)}
                        className={`global-search__suggestion global-search__suggestion--search-all${
                          highlighted ? " is-highlighted" : ""
                        }`}
                      >
                        <Compass className="artist-icon-sm" aria-hidden="true" />
                        <span>
                          {inLibrary ? `Search Discover for “${row.query}”` : `Search everywhere for “${row.query}”`}
                          <small>Artists and albums not on the server yet, to ask for</small>
                        </span>
                      </button>
                    </div>
                  );
                }
                selectableCursor += 1;
                const highlighted = selectableCursor === suggestionIndex;
                const item = row.item;
                const label = getSuggestionTitle(item);
                const meta = getSuggestionMeta(item);
                const action = renderSuggestionAction(item);

                return (
                  <div
                    key={row.key}
                    className={`global-search__suggestion global-search__suggestion--rich${
                      highlighted ? " is-highlighted" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSuggestionSelect(row)}
                      className="global-search__suggestion-main"
                    >
                      <span className="global-search__suggestion-copy">
                        <span className="global-search__suggestion-title">{label}</span>
                        {meta && <span className="global-search__suggestion-meta">{meta}</span>}
                      </span>
                    </button>
                    {action && (
                      <span
                        className="global-search__suggestion-actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {action}
                      </span>
                    )}
                  </div>
                );
              })}
        </div>
      )}
    </form>
  );
}

export default GlobalSearch;
