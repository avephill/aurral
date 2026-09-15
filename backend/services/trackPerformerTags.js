import fs from "node:fs/promises";
import { parseFile } from "music-metadata";

/**
 * Each song's own artist, read from its file's tags.
 *
 * The library index gives every track its album's artist: Lidarr's track API
 * has no per-song artist, and the Lidarr indexer never opens the files. On a
 * compilation that makes every row read "Various Artists". The file's artist
 * tag is the authority for who performs the song, so it is read here, a few
 * files at a time, and remembered until the file changes.
 */

const CACHE_LIMIT = 20_000;
const CONCURRENCY = 4;

const cache = new Map();

async function readArtistTag(filePath, reader) {
  const { mtimeMs } = await fs.stat(filePath);
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.artist;
  const metadata = await reader(filePath, { skipCovers: true, duration: false });
  const common = metadata?.common || {};
  const artist =
    String(common.artist || (Array.isArray(common.artists) ? common.artists.join(", ") : "") || "").trim() ||
    null;
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(filePath, { mtimeMs, artist });
  return artist;
}

/**
 * Sets `performerName` on each track that has an available file with an artist
 * tag. Files that cannot be read are skipped; the track keeps its album artist.
 */
export async function addTrackPerformers(tracks = [], { reader = parseFile } = {}) {
  const queue = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const file = (Array.isArray(track?.files) ? track.files : []).find(
      (entry) => entry?.available && entry?.path,
    );
    if (file) queue.push({ track, path: file.path });
  }
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        const artist = await readArtistTag(item.path, reader);
        if (artist) item.track.performerName = artist;
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return tracks;
}

export function resetTrackPerformerCache() {
  cache.clear();
}
