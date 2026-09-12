import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  lookupTrackRatings,
  setTrackRating,
  setTrackStarred,
} from "../utils/api/endpoints/navidromeRatings.js";

/**
 * One shared store of Navidrome ratings keyed by canonical track id.
 *
 * Every rendered star widget asks for its own track; the store gathers those
 * asks for a moment and sends them as one lookup, so a list of a hundred rows
 * costs one request rather than a hundred. Writes update the store at once
 * and reconcile with what Navidrome reports back.
 */

const BATCH_DELAY_MS = 120;
const BATCH_LIMIT = 200;

const entries = new Map(); // trackId -> { rating, starred, known, pending }
const listeners = new Set();
const queued = new Map(); // trackId -> albumId
const inFlight = new Set();
let timer = null;
let enabled = false;

const EMPTY = Object.freeze({ rating: 0, starred: false, known: false, loading: false });

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(trackId) {
  return entries.get(String(trackId)) || EMPTY;
}

function setEntry(trackId, patch) {
  const key = String(trackId);
  entries.set(key, { ...(entries.get(key) || EMPTY), ...patch });
}

async function flush() {
  timer = null;
  if (!queued.size) return;
  const batch = [...queued.entries()].slice(0, BATCH_LIMIT);
  for (const [trackId] of batch) {
    queued.delete(trackId);
    inFlight.add(trackId);
    setEntry(trackId, { loading: true });
  }
  emit();
  try {
    const { tracks = {}, connected } = await lookupTrackRatings(
      batch.map(([trackId, albumId]) => ({ trackId, albumId })),
    );
    for (const [trackId] of batch) {
      const found = tracks[trackId];
      setEntry(trackId, {
        loading: false,
        known: Boolean(found?.known),
        rating: Number(found?.rating || 0),
        starred: Boolean(found?.starred),
        unavailable: connected === false,
      });
    }
  } catch {
    for (const [trackId] of batch) setEntry(trackId, { loading: false, known: false, unavailable: true });
  } finally {
    for (const [trackId] of batch) inFlight.delete(trackId);
    emit();
    if (queued.size) timer = setTimeout(flush, BATCH_DELAY_MS);
  }
}

function request(trackId, albumId) {
  const key = String(trackId);
  if (entries.has(key) || inFlight.has(key) || queued.has(key)) return;
  queued.set(key, albumId ?? null);
  if (!timer) timer = setTimeout(flush, BATCH_DELAY_MS);
}

export function setTrackRatingsEnabled(value) {
  enabled = value === true;
}

export function forgetTrackRatings() {
  entries.clear();
  queued.clear();
  emit();
}

/**
 * The rating of one canonical track, fetched lazily and shared.
 * Returns { rating, starred, known, loading, rate(nextRating) }.
 */
export function useTrackRating(trackId, albumId = null) {
  const key = trackId != null && String(trackId).trim() ? String(trackId) : null;
  const entry = useSyncExternalStore(subscribe, () => (key ? read(key) : EMPTY), () => EMPTY);

  useEffect(() => {
    if (enabled && key) request(key, albumId);
  }, [key, albumId]);

  const rate = useCallback(
    async (nextRating) => {
      if (!key) return null;
      const previous = read(key);
      setEntry(key, { rating: nextRating, saving: true });
      emit();
      try {
        const saved = await setTrackRating({ trackId: key, albumId }, nextRating);
        setEntry(key, { rating: Number(saved?.rating ?? nextRating), starred: Boolean(saved?.starred ?? previous.starred), known: true, saving: false });
        emit();
        return saved;
      } catch (error) {
        setEntry(key, { ...previous, saving: false });
        emit();
        throw error;
      }
    },
    [albumId, key],
  );

  const star = useCallback(
    async (nextStarred) => {
      if (!key) return null;
      const previous = read(key);
      setEntry(key, { starred: nextStarred, saving: true });
      emit();
      try {
        const saved = await setTrackStarred({ trackId: key, albumId }, nextStarred);
        setEntry(key, {
          starred: Boolean(saved?.starred ?? nextStarred),
          rating: Number(saved?.rating ?? previous.rating),
          known: true,
          saving: false,
        });
        emit();
        return saved;
      } catch (error) {
        setEntry(key, { ...previous, saving: false });
        emit();
        throw error;
      }
    },
    [albumId, key],
  );

  return { ...entry, rate, star };
}
