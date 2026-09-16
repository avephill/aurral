import fs from "node:fs";
import path from "node:path";
import { db } from "../config/db-sqlite.js";
import { resolveAurralDataDir } from "../config/data-dir.js";
import { getUserTrackRatings } from "./navidromeUserRatings.js";
import { setTrackRating } from "./navidromeAnnotations.js";
import { logger } from "./logger.js";

/**
 * Put back ratings a person gave songs in iTunes that never reached Navidrome.
 *
 * The migration carried most of them, but a song it could not match then has
 * its rating only in its Psalter record. Now that records link to tracks, the
 * rating can be written where it belongs.
 *
 * Blanks only. A rating the person has set in Navidrome is theirs and is never
 * overwritten, even when iTunes disagrees; those disagreements are reported so
 * an admin can look, not resolved here.
 */

const CONCURRENCY = 4;
const MAX_APPLY = 2000;

/**
 * Run a restore asked for by a file in the data folder's imports directory,
 * named `restore-ratings-<username>`, then rename it so it runs once. The same
 * one-off route the iTunes bundle takes, for an admin working on the server
 * rather than through the page. Writing "includeUnsure" in the file also
 * restores ratings whose match is still unchecked.
 */
export async function runPendingRatingRestores({ dir = path.join(resolveAurralDataDir(), "imports") } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^restore-ratings-[^.]+$/.test(name));
  } catch {
    return [];
  }
  const results = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    const owner = name.slice("restore-ratings-".length);
    try {
      const body = fs.readFileSync(file, "utf8");
      const result = await applyRatingRestore({ owner, includeUnsure: /includeUnsure/i.test(body) });
      fs.renameSync(file, `${file}.done-${new Date().toISOString().slice(0, 10)}`);
      logger.info("library", `[SongRecords] Rating restore for ${owner}: ${JSON.stringify(result)}`);
      results.push(result);
    } catch (error) {
      logger.warn("library", `[SongRecords] Rating restore for ${owner} failed: ${error.message}`);
      results.push({ owner, error: error.message });
    }
  }
  return results;
}

/** Records with a rating and a link, beside the track they point at. */
function ratedLinkedRecords(owner) {
  return db.prepare(`
    SELECT record.id AS recordId, record.title AS title, record.artist AS artist,
           record.album AS album, record.rating AS itunesRating,
           link.track_id AS trackId, link.status AS linkStatus,
           track.title AS trackTitle, track.artist_name AS trackArtist
    FROM song_records AS record
    JOIN song_record_links AS link ON link.record_id = record.id AND link.status != 'rejected'
    JOIN library_tracks AS track ON track.id = link.track_id
    WHERE record.owner = ? AND record.rating > 0
      AND EXISTS (SELECT 1 FROM library_media_files AS media
                  WHERE media.track_id = link.track_id AND media.available = 1)
    ORDER BY record.rating DESC, record.artist, record.album, record.track_number
  `).all(owner);
}

/**
 * What would be written. `missing` are songs with no rating in Navidrome;
 * `different` are songs rated differently there, which are left alone.
 * One track can carry several records; the highest iTunes rating wins.
 */
export async function planRatingRestore({ owner, ratings = null } = {}) {
  const live = ratings || (await getUserTrackRatings({ username: owner })).ratings;
  const byTrack = new Map();
  for (const row of ratedLinkedRecords(owner)) {
    const current = byTrack.get(row.trackId);
    if (!current || row.itunesRating > current.itunesRating) byTrack.set(row.trackId, row);
  }
  const missing = [];
  const different = [];
  for (const [trackId, row] of byTrack) {
    const navidromeRating = Number(live.get(trackId)) || 0;
    const entry = {
      trackId,
      recordId: row.recordId,
      title: row.trackTitle || row.title,
      artist: row.trackArtist || row.artist,
      album: row.album,
      itunesRating: row.itunesRating,
      navidromeRating,
      unsure: row.linkStatus === "review",
    };
    if (!navidromeRating) missing.push(entry);
    else if (navidromeRating !== row.itunesRating) different.push(entry);
  }
  return {
    owner,
    considered: byTrack.size,
    missing,
    different,
    // A guessed link is a guess about which song this is; a rating written
    // through one lands on the wrong song if the guess was wrong.
    unsureCount: missing.filter((entry) => entry.unsure).length,
  };
}

/**
 * Write the missing ratings as that person. `includeUnsure` also writes the
 * ones whose link is still waiting to be checked; off by default.
 */
export async function applyRatingRestore({
  owner,
  limit = MAX_APPLY,
  includeUnsure = false,
  write = setTrackRating,
  ratings = null,
} = {}) {
  const plan = await planRatingRestore({ owner, ratings });
  const wanted = plan.missing
    .filter((entry) => includeUnsure || !entry.unsure)
    .slice(0, Math.max(0, Math.min(MAX_APPLY, Number(limit) || MAX_APPLY)));
  const user = { username: owner };
  const failures = [];
  let written = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= wanted.length) return;
      const entry = wanted[index];
      try {
        await write(user, { trackId: entry.trackId }, entry.itunesRating);
        written += 1;
      } catch (error) {
        failures.push({ trackId: entry.trackId, title: entry.title, error: error.message });
      }
    }
  }));
  logger.info(
    "library",
    `[SongRecords] Restored ${written} iTunes rating(s) for ${owner}${failures.length ? `, ${failures.length} failed` : ""}`,
  );
  return {
    owner,
    written,
    skippedUnsure: includeUnsure ? 0 : plan.missing.filter((entry) => entry.unsure).length,
    remaining: Math.max(0, plan.missing.length - wanted.length),
    different: plan.different.length,
    failures: failures.slice(0, 20),
  };
}
