import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useAudioPlayerContext } from "react-use-audio-player";
import { getFormatLoadAttempts, getHowlerFormat, normalizeQueueTrack, shouldRecordListen } from "../utils/audioQueue";
import { AudioQueueContext } from "./audioQueueContext";
import { recordPlayEvent } from "../utils/api/endpoints/auth";

const SHARED_VOLUME_KEY = "aurral.preview.volume";
const SHARED_VOLUME_EVENT = "aurral:shared-volume-change";
const DEFAULT_VOLUME = 0.7;

function normalizeVolume(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(1, parsed));
}

function readStoredVolume() {
  if (typeof window === "undefined") return DEFAULT_VOLUME;
  const stored = window.localStorage.getItem(SHARED_VOLUME_KEY);
  return stored == null ? DEFAULT_VOLUME : normalizeVolume(stored);
}

function writeStoredVolume(value) {
  if (typeof window === "undefined") return;
  const nextVolume = normalizeVolume(value);
  window.localStorage.setItem(SHARED_VOLUME_KEY, String(nextVolume));
  window.dispatchEvent(new CustomEvent(SHARED_VOLUME_EVENT, { detail: nextVolume }));
}

function useSharedVolume() {
  const [volume, setVolumeState] = useState(readStoredVolume);

  useEffect(() => {
    const handleVolumeChange = (event) => {
      if (event.type === "storage" && event.key !== SHARED_VOLUME_KEY) return;
      setVolumeState(
        event.type === SHARED_VOLUME_EVENT ? normalizeVolume(event.detail) : readStoredVolume(),
      );
    };

    window.addEventListener(SHARED_VOLUME_EVENT, handleVolumeChange);
    window.addEventListener("storage", handleVolumeChange);

    return () => {
      window.removeEventListener(SHARED_VOLUME_EVENT, handleVolumeChange);
      window.removeEventListener("storage", handleVolumeChange);
    };
  }, []);

  const setVolume = useCallback((nextVolume) => {
    const normalized =
      typeof nextVolume === "function"
        ? normalizeVolume(nextVolume(readStoredVolume()))
        : normalizeVolume(nextVolume);
    setVolumeState(normalized);
    writeStoredVolume(normalized);
  }, []);

  return [volume, setVolume];
}

function shuffleIds(ids) {
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function buildPlaybackOrder(tracks, shuffle) {
  const indices = tracks.map((_, index) => index);
  return shuffle ? shuffleIds(indices) : indices;
}

function queueReducer(state, action) {
  switch (action.type) {
    case "PLAY_QUEUE": {
      const { tracks, startIndex, shuffle, updateShufflePreference, source } = action;
      const normalized = (Array.isArray(tracks) ? tracks : [])
        .map((track) => normalizeQueueTrack(track))
        .filter((track) => track.src);
      if (normalized.length === 0) return state;
      const order = buildPlaybackOrder(normalized, shuffle);
      const boundedStart = Math.max(0, Math.min(startIndex, order.length - 1));
      return {
        ...state,
        queue: normalized,
        playbackOrder: order,
        source: source ?? null,
        currentIndex: boundedStart,
        error: null,
        queueRevision: state.queueRevision + 1,
        isShuffleEnabled: updateShufflePreference ? shuffle : state.isShuffleEnabled,
      };
    }
    case "SET_CURRENT_INDEX":
      return { ...state, currentIndex: action.index, error: null };
    case "SET_QUEUE_REVISION":
      return { ...state, error: null, queueRevision: state.queueRevision + 1 };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "CLEAR_ERROR":
      return { ...state, error: null };
    case "SET_SHUFFLE": {
      if (state.queue.length === 0 || state.currentIndex < 0) {
        return { ...state, isShuffleEnabled: action.enabled };
      }
      const currentQueueIndex = state.playbackOrder[state.currentIndex];
      const order = buildPlaybackOrder(state.queue, action.enabled);
      const nextPlaybackIndex = currentQueueIndex != null
        ? order.findIndex((idx) => idx === currentQueueIndex)
        : -1;
      return {
        ...state,
        isShuffleEnabled: action.enabled,
        playbackOrder: order,
        currentIndex: nextPlaybackIndex >= 0 ? nextPlaybackIndex : state.currentIndex,
      };
    }
    case "TOGGLE_REPEAT": {
      const modes = ["off", "all", "one"];
      const nextMode = modes[(modes.indexOf(state.repeatMode) + 1) % modes.length];
      return { ...state, repeatMode: nextMode };
    }
    case "CLEAR_QUEUE":
      return {
        queue: [],
        currentIndex: -1,
        source: null,
        error: null,
        isShuffleEnabled: false,
        playbackOrder: [],
        repeatMode: "off",
        queueRevision: 0,
      };
    default:
      return state;
  }
}

const initialQueueState = {
  queue: [],
  currentIndex: -1,
  source: null,
  error: null,
  isShuffleEnabled: false,
  playbackOrder: [],
  repeatMode: "off",
  queueRevision: 0,
};

const PLAY_CHECK_INTERVAL_MS = 5000;

export function AudioQueueProvider({ children }) {
  const player = useAudioPlayerContext();
  const playerRef = useRef(player);
  playerRef.current = player;

  const [sharedVolume, setSharedVolume] = useSharedVolume();
  const sharedVolumeRef = useRef(sharedVolume);
  sharedVolumeRef.current = sharedVolume;

  const [state, dispatch] = useReducer(queueReducer, initialQueueState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadedSignatureRef = useRef(null);

  // A listen is recorded once per load: the threshold effect below fires
  // part-way through, and a track that ends without reaching it still counts.
  const playbackTokenRef = useRef(0);
  const recordedTokenRef = useRef(null);
  const recordPlayOnce = useCallback((track) => {
    if (!track?.recordHistory) return;
    if (recordedTokenRef.current === playbackTokenRef.current) return;
    recordedTokenRef.current = playbackTokenRef.current;
    recordPlayEvent({
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      artistMbid: track.artistMbid,
      albumMbid: track.albumMbid,
      trackMbid: track.trackMbid,
      durationMs: track.durationMs,
      playedAt: Date.now(),
      source: "native-player",
    }).catch(() => {});
  }, []);

  const loadTrackAtIndexRef = useRef(() => {});

  const getTrackAt = useCallback((playbackIndex) => {
    const s = stateRef.current;
    const queueIndex = s.playbackOrder[playbackIndex];
    if (queueIndex == null) return null;
    return s.queue[queueIndex] ?? null;
  }, []);

  const loadTrackAtIndex = useCallback((playbackIndex, formatAttemptIndex = 0) => {
    const s = stateRef.current;
    const queueIndex = s.playbackOrder[playbackIndex];
    const track = queueIndex == null ? null : s.queue[queueIndex] ?? null;
    if (!track?.src) return;    const formatAttempts = getFormatLoadAttempts(track);
    const formatKey = formatAttempts[formatAttemptIndex];
    if (!formatKey) return;
    const signature = `${s.queueRevision}:${queueIndex}:${track.src}:${formatKey}`;
    if (loadedSignatureRef.current === signature) return;
    loadedSignatureRef.current = signature;
    playbackTokenRef.current += 1;

    playerRef.current.stop();
    playerRef.current.load(track.src, {
      autoplay: true,
      initialVolume: sharedVolumeRef.current,
      html5: true,
      format: getHowlerFormat(formatKey),
      onloaderror: () => {
        loadedSignatureRef.current = null;
        if (formatAttemptIndex + 1 >= formatAttempts.length) {
          dispatch({
            type: "SET_ERROR",
            error: "This track is unavailable. Restore the file or refresh the library.",
          });
          playerRef.current.stop();
          return;
        }
        loadTrackAtIndexRef.current(playbackIndex, formatAttemptIndex + 1);
      },
      onend: () => {
        const cur = stateRef.current;
        if (cur.currentIndex < 0) return;
        recordPlayOnce(track);

        if (cur.repeatMode === "one") {
          loadedSignatureRef.current = null;
          loadTrackAtIndexRef.current(cur.currentIndex);
          return;
        }

        const nextIndex = cur.currentIndex + 1;
        if (nextIndex < cur.playbackOrder.length) {
          dispatch({ type: "SET_CURRENT_INDEX", index: nextIndex });
          return;
        }

        if (cur.repeatMode === "all" && cur.playbackOrder.length > 0) {
          loadedSignatureRef.current = null;
          dispatch({ type: "SET_CURRENT_INDEX", index: 0 });
          dispatch({ type: "SET_QUEUE_REVISION" });
          return;
        }

        loadedSignatureRef.current = null;
        dispatch({ type: "CLEAR_QUEUE" });
        playerRef.current.stop();
      },
    });
  }, [recordPlayOnce]);

  loadTrackAtIndexRef.current = loadTrackAtIndex;
  useEffect(() => {
    if (state.currentIndex < 0) {
      loadedSignatureRef.current = null;
      return;
    }
    loadTrackAtIndex(state.currentIndex);
  }, [state.currentIndex, state.queueRevision, loadTrackAtIndex]);

  useEffect(() => {
    const activePlayer = playerRef.current;
    activePlayer.setVolume(sharedVolume);
    if (sharedVolume <= 0) {
      activePlayer.mute();
      return;
    }
    activePlayer.unmute();
  }, [sharedVolume]);

  const setShuffleEnabled = useCallback((enabled) => {
    dispatch({ type: "SET_SHUFFLE", enabled });
  }, []);

  const toggleShuffle = useCallback(() => {
    dispatch({ type: "SET_SHUFFLE", enabled: !stateRef.current.isShuffleEnabled });
  }, []);

  const toggleRepeat = useCallback(() => {
    dispatch({ type: "TOGGLE_REPEAT" });
  }, []);

  const playQueue = useCallback((
    tracks,
    { startIndex = 0, startTrackId = null, source: nextSource = null, shuffle = false, updateShufflePreference = true } = {},
  ) => {
    const normalized = (Array.isArray(tracks) ? tracks : [])
      .map((track) => normalizeQueueTrack(track))
      .filter((track) => track.src);
    if (normalized.length === 0) return false;
    const order = buildPlaybackOrder(normalized, shuffle);
    let boundedStart = Math.max(0, Math.min(startIndex, order.length - 1));
    if (startTrackId != null) {
      const queueIndex = normalized.findIndex(
        (track) => String(track.id) === String(startTrackId),
      );
      if (queueIndex >= 0) {
        const playbackIndex = order.findIndex((index) => index === queueIndex);
        if (playbackIndex >= 0) boundedStart = playbackIndex;
      }
    }
    dispatch({
      type: "PLAY_QUEUE",
      tracks: normalized,
      startIndex: boundedStart,
      shuffle,
      updateShufflePreference,
      source: nextSource,
    });
    return true;
  }, []);

  const playTrack = useCallback((track, options = {}) => {
    const normalized = normalizeQueueTrack(track);
    if (!normalized.src) return false;
    const contextTracks = (
      Array.isArray(options.queue) && options.queue.length > 0
        ? options.queue
        : [track]
    )
      .map((entry) => normalizeQueueTrack(entry))
      .filter((entry) => entry.src);
    if (contextTracks.length === 0) return false;
    return playQueue(contextTracks, {
      startTrackId: normalized.id,
      source: options.source ?? null,
      shuffle: options.shuffle ?? stateRef.current.isShuffleEnabled,
      updateShufflePreference: options.updateShufflePreference ?? false,
    });
  }, [playQueue]);
  const togglePlayPause = useCallback(() => {
    if (stateRef.current.queue.length === 0) return;
    const activePlayer = playerRef.current;
    if (stateRef.current.error) {
      dispatch({ type: "CLEAR_ERROR" });
      loadedSignatureRef.current = null;
      loadTrackAtIndex(stateRef.current.currentIndex);
      return;
    }
    if (activePlayer.isPlaying) {
      activePlayer.pause();
      return;
    }
    if (activePlayer.isReady || activePlayer.src) {
      activePlayer.play();
      return;
    }
    if (stateRef.current.currentIndex >= 0) {
      loadedSignatureRef.current = null;
      loadTrackAtIndex(stateRef.current.currentIndex);
    }
  }, [loadTrackAtIndex]);

  const playNext = useCallback(() => {
    const s = stateRef.current;
    if (s.queue.length === 0) return;
    if (s.currentIndex < 0) {
      dispatch({
        type: "PLAY_QUEUE",
        tracks: s.queue,
        startIndex: 0,
        shuffle: s.isShuffleEnabled,
        updateShufflePreference: false,
        source: s.source,
      });      return;
    }
    const nextIndex = s.currentIndex + 1;
    if (nextIndex < s.playbackOrder.length) {
      dispatch({ type: "SET_CURRENT_INDEX", index: nextIndex });
      return;
    }
    if (s.repeatMode === "all" && s.playbackOrder.length > 0) {
      loadedSignatureRef.current = null;
      dispatch({ type: "SET_CURRENT_INDEX", index: 0 });
      dispatch({ type: "SET_QUEUE_REVISION" });
      return;
    }
    loadedSignatureRef.current = null;
    dispatch({ type: "CLEAR_QUEUE" });
    playerRef.current.stop();
  }, []);

  const playPrevious = useCallback(() => {
    const s = stateRef.current;
    if (s.queue.length === 0) return;
    if (s.currentIndex < 0) {
      dispatch({
        type: "PLAY_QUEUE",
        tracks: s.queue,
        startIndex: 0,
        shuffle: s.isShuffleEnabled,
        updateShufflePreference: false,
        source: s.source,
      });      return;
    }
    const prevIndex = s.currentIndex - 1;
    if (prevIndex >= 0) {
      loadedSignatureRef.current = null;
      dispatch({ type: "SET_CURRENT_INDEX", index: prevIndex });
      return;
    }
    const position = playerRef.current.getPosition();
    if (position > 3) {
      playerRef.current.seek(0);
    }
  }, []);

  const clearQueue = useCallback(() => {
    loadedSignatureRef.current = null;
    dispatch({ type: "CLEAR_QUEUE" });
    playerRef.current.stop();
    playerRef.current.cleanup();
  }, []);

  const currentTrack = state.currentIndex >= 0 ? getTrackAt(state.currentIndex) : null;
  const isActive = state.queue.length > 0 && state.currentIndex >= 0;

  const matchesSource = useCallback(
    (candidate) => {
      if (!candidate || !state.source) return false;
      if (candidate.type && candidate.type !== state.source.type) return false;
      if (candidate.id != null && String(candidate.id) !== String(state.source.id)) return false;
      return true;
    },
    [state.source],
  );

  // The Mac's play and skip keys, headphone buttons and the Now Playing panel
  // reach a web page through the Media Session API. Without handlers they did
  // nothing, and the panel showed no song.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return undefined;
    const session = navigator.mediaSession;
    const handlers = {
      play: () => {
        if (!playerRef.current.isPlaying) togglePlayPause();
      },
      pause: () => {
        if (playerRef.current.isPlaying) togglePlayPause();
      },
      nexttrack: () => playNext(),
      previoustrack: () => playPrevious(),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action, handler);
      } catch {}
    }
    return () => {
      for (const action of Object.keys(handlers)) {
        try {
          session.setActionHandler(action, null);
        } catch {}
      }
    };
  }, [playNext, playPrevious, togglePlayPause]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    const session = navigator.mediaSession;
    if (!currentTrack) {
      session.metadata = null;
      return;
    }
    if (typeof window.MediaMetadata === "function") {
      session.metadata = new window.MediaMetadata({
        title: currentTrack.title || "",
        artist: currentTrack.artist || "",
        album: currentTrack.album || "",
        artwork: currentTrack.artwork ? [{ src: currentTrack.artwork }] : [],
      });
    }
  }, [currentTrack]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    navigator.mediaSession.playbackState = !currentTrack ? "none" : player.isPlaying ? "playing" : "paused";
  }, [currentTrack, player.isPlaying]);

  // iTunes keys: Space plays and pauses, Command (or Ctrl) with the left and
  // right arrows skips. Left alone while typing.
  //
  // Space takes precedence over a focused button. After clicking a song's play
  // button that button keeps focus, and letting Space "click" it again
  // restarted the song instead of pausing it. Enter still presses buttons;
  // sliders, dialogs and menus keep Space for themselves.
  useEffect(() => {
    const isTyping = (target) =>
      Boolean(target) &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    const onKeyDown = (event) => {
      if (event.defaultPrevented || isTyping(event.target)) return;
      if (stateRef.current.queue.length === 0) return;
      if (event.key === " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.target?.closest?.("[role='slider'], [role='dialog'], dialog, [role='menu'], [role='listbox']")) {
          return;
        }
        event.preventDefault();
        togglePlayPause();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          playNext();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          playPrevious();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [playNext, playPrevious, togglePlayPause]);

  // Half the track, or four minutes of a long one: the convention Navidrome and
  // Last.fm use. A song skipped near its end still counts; one sampled for a
  // few seconds does not.
  useEffect(() => {
    if (!player.isPlaying || !currentTrack?.recordHistory) return undefined;
    const check = () => {
      const heardSeconds = Number(playerRef.current.getPosition?.() ?? 0);
      const totalSeconds = Number(playerRef.current.duration) || (Number(currentTrack.durationMs) || 0) / 1000;
      if (shouldRecordListen({ heardSeconds, totalSeconds })) recordPlayOnce(currentTrack);
    };
    check();
    const timer = setInterval(check, PLAY_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [currentTrack, player.isPlaying, recordPlayOnce]);

  const value = useMemo(
    () => ({
      queue: state.queue,
      currentTrack,
      currentIndex: state.currentIndex,
      source: state.source,
      playbackError: state.error,
      isActive,
      isPlaying: player.isPlaying,
      isLoading: player.isLoading,
      isPaused: player.isPaused,
      duration: player.duration,
      getPosition: player.getPosition,
      seek: player.seek,
      volume: sharedVolume,
      setVolume: setSharedVolume,
      isShuffleEnabled: state.isShuffleEnabled,
      setShuffleEnabled,
      repeatMode: state.repeatMode,
      toggleRepeat,
      playQueue,
      playTrack,
      togglePlayPause,
      playNext,
      playPrevious,
      clearQueue,
      toggleShuffle,
      matchesSource,
    }),
    [
      clearQueue,
      currentTrack,
      isActive,
      matchesSource,
      playNext,
      playPrevious,
      playQueue,
      playTrack,
      player.duration,
      player.getPosition,
      player.isLoading,
      player.isPaused,
      player.isPlaying,
      player.seek,
      setSharedVolume,
      setShuffleEnabled,
      sharedVolume,
      state.queue,
      state.currentIndex,
      state.error,
      state.source,
      state.isShuffleEnabled,
      state.repeatMode,
      togglePlayPause,
      toggleRepeat,
      toggleShuffle,
    ],
  );

  return <AudioQueueContext.Provider value={value}>{children}</AudioQueueContext.Provider>;
}
