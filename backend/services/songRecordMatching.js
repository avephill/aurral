/**
 * Which file on the server an iTunes song is.
 *
 * A port of the tiers in scripts/itunes-migrate/itunes_match.py, which made
 * the first links. That script ran once against the whole library; this runs
 * whenever music arrives, for the songs still waiting, so it keeps the tiers
 * that decide by name and length and leaves out the ones only a full
 * migration needed.
 *
 * Titles do not survive MusicBrainz intact - "Ocean" comes back as "The
 * Ocean", "Tom Traubert's Blues" gains a subtitle, iTunes' "Track 07" becomes
 * "Country Honk" - so the tiers loosen step by step: exact names, then titles
 * stripped of decoration, then a similar title on the same album at the same
 * length, then a free slot on an album most of whose songs already matched.
 * Every link records the tier that made it, and a guess between two equally
 * good candidates is marked for review rather than trusted.
 */

const JUNK_PAREN = /\s*[([](?:[^)\]]*?)(?:remaster|remastered|album version|single version|radio edit|bonus track|deluxe|explicit|mono|stereo|edit|version|mix|live|acoustic|demo|feat\.?|ft\.?|featuring|instrumental|\d{4})(?:[^)\]]*?)[)\]]/gi;
const FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;
const ALBUM_JUNK = /\s*[([\-–]\s*(?:deluxe|expanded|remaster|remastered|bonus|anniversary|edition|version|single|ep|disc \d|cd ?\d)[^)\]]*[)\]]?\s*$/i;
const ANY_BRACKET = /\s*[([][^)\]]*[)\]]/g;
const CREDIT_SPLIT = /\s+(?:and|&|with|feat\.?|ft\.?|featuring|y)\s+|\s*[/,;+]\s*/i;
const TRACK_NO = /^track\s*(\d+)$/;

const DURATION_TOLERANCE = 3;

export function norm(value) {
  if (!value) return "";
  return String(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Title without version and featuring decorations. */
export function normLoose(value) {
  if (!value) return "";
  const text = String(value)
    .replace(JUNK_PAREN, "")
    .replace(FEAT, "")
    .replace(/\s*[-–]\s*(?:live|remaster(?:ed)?(?: \d{4})?|single version|radio edit)\s*$/i, "");
  return norm(text);
}

/** Title with every bracketed group and dash suffix removed. */
export function normBare(value) {
  if (!value) return "";
  const text = String(value).replace(ANY_BRACKET, "").replace(FEAT, "").replace(/\s+[-–]\s+.*$/, "");
  return norm(text);
}

/** Artist names compare as one run, so "J.J. Cale" is "JJ Cale". */
export function normArtist(value) {
  return norm(value)
    .replace(/^the /, "")
    .replace(/\s+(?:feat|ft|featuring)\s+.*$/, "")
    .replace(/ /g, "");
}

// MusicBrainz credits the group, iTunes credits the person: "Nat King Cole"
// against "The Nat King Cole Trio", "Bill Evans" against "The Bill Evans Trio".
// Dropping the ensemble word leaves the name both sides agree on. The remainder
// has to be a real name, so "The Band" and a group actually called "Trio" keep
// theirs.
// "and his" and "and her" come along with the ensemble word: normArtist has
// already turned "&" into "and" and closed up the spaces.
const ENSEMBLE_TAIL = /(?:and)?(?:his|her|their)?(?:trio|quartet|quintet|sextet|septet|octet|orchestra|ensemble|band|group|combo|allstars)$/;
const MIN_CORE_ARTIST = 5;

export function artistCore(value) {
  const name = normArtist(value);
  const core = name.replace(ENSEMBLE_TAIL, "");
  return core.length >= MIN_CORE_ARTIST && core !== name ? core : name;
}

/** The forms of a credit worth filing a song under, longest first. */
export function artistKeys(...names) {
  const keys = [];
  for (const name of names) {
    for (const key of [normArtist(name), artistCore(name)]) {
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

export function normAlbum(value) {
  return norm(String(value || "").replace(ALBUM_JUNK, ""));
}

/** "Neko Case and her Boyfriends" may be filed under "Neko Case". */
export function artistVariants(value) {
  const full = normArtist(value);
  const out = [];
  for (const part of String(value || "").split(CREDIT_SPLIT)) {
    const alt = normArtist(part);
    if (alt && alt !== full && !out.includes(alt)) out.push(alt);
  }
  return out;
}

/**
 * Python's difflib SequenceMatcher ratio (Ratcliff/Obershelp): twice the
 * matched characters over the combined length. Kept identical so a threshold
 * tuned in the migration means the same thing here.
 */
export function similarity(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left.length && !right.length) return 1;
  const matched = (aLo, aHi, bLo, bHi) => {
    let best = 0;
    let bestA = aLo;
    let bestB = bLo;
    let lengths = new Map();
    for (let i = aLo; i < aHi; i += 1) {
      const next = new Map();
      for (let j = bLo; j < bHi; j += 1) {
        if (left[i] !== right[j]) continue;
        const length = (lengths.get(j - 1) || 0) + 1;
        next.set(j, length);
        if (length > best) {
          best = length;
          bestA = i - length + 1;
          bestB = j - length + 1;
        }
      }
      lengths = next;
    }
    if (!best) return 0;
    return best
      + matched(aLo, bestA, bLo, bestB)
      + matched(bestA + best, aHi, bestB + best, bHi);
  };
  return (2 * matched(0, left.length, 0, right.length)) / (left.length + right.length);
}

const seconds = (ms) => (Number(ms) || 0) / 1000;

function push(map, key, value) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Candidate files as the tiers read them. `tracks` are
 * { trackId, title, artistName, albumArtist, albumTitle, albumId, durationMs }.
 */
export function buildCandidateIndex(tracks = []) {
  const rows = tracks.map((track) => ({
    ...track,
    duration: seconds(track.durationMs),
    nTitle: norm(track.title),
    lTitle: normLoose(track.title),
    bTitle: normBare(track.title),
    nArtist: normArtist(track.artistName),
    nAlbumArtist: normArtist(track.albumArtist),
    nAlbum: normAlbum(track.albumTitle),
  }));
  const index = {
    rows,
    byArtistTitle: new Map(),
    byArtistLoose: new Map(),
    byArtistBare: new Map(),
    byArtistAlbum: new Map(),
    byArtist: new Map(),
    byAlbum: new Map(),
    byTitle: new Map(),
    byBareTitle: new Map(),
    byAlbumId: new Map(),
    byTrackId: new Map(),
  };
  for (const row of rows) {
    index.byTrackId.set(row.trackId, row);
    push(index.byTitle, row.nTitle, row);
    if (row.bTitle !== row.nTitle) push(index.byBareTitle, row.bTitle, row);
    if (row.albumId != null) push(index.byAlbumId, row.albumId, row);
    for (const artist of new Set(artistKeys(row.artistName, row.albumArtist))) {
      push(index.byArtistTitle, `${artist}\n${row.nTitle}`, row);
      push(index.byArtistLoose, `${artist}\n${row.lTitle}`, row);
      push(index.byArtistBare, `${artist}\n${row.bTitle}`, row);
      push(index.byArtistAlbum, `${artist}\n${row.nAlbum}`, row);
      push(index.byArtist, artist, row);
    }
    push(index.byAlbum, row.nAlbum, row);
  }
  return index;
}

function recordKey(record) {
  return {
    duration: seconds(record.durationMs),
    nTitle: norm(record.title),
    lTitle: normLoose(record.title),
    bTitle: normBare(record.title),
    nArtist: normArtist(record.artist),
    coreArtist: artistCore(record.artist),
    variants: artistVariants(record.artist),
    nAlbumArtist: normArtist(record.albumArtist),
    nAlbum: normAlbum(record.album),
  };
}

/** Best candidate within the tolerance: same album first, then closest length. */
function pick(candidates, key, tolerance, claimed) {
  const within = candidates.filter((row) => !claimed.has(row.trackId) && Math.abs(row.duration - key.duration) <= tolerance);
  if (!within.length) return null;
  const score = (row) => [row.nAlbum === key.nAlbum ? 1 : 0, -Math.abs(row.duration - key.duration)];
  within.sort((a, b) => score(b)[0] - score(a)[0] || score(b)[1] - score(a)[1]);
  const [best, second] = within;
  // Two copies of one song on two albums are a real choice only when neither
  // is on the album he had.
  const ambiguous = Boolean(second && second.trackId !== best.trackId && score(second)[0] === score(best)[0]
    && Math.abs(second.duration - best.duration) < 0.5);
  return { row: best, ambiguous };
}

function lookup(map, ...parts) {
  return parts.every(Boolean) ? map.get(parts.join("\n")) || [] : [];
}

function matchOne(key, index, claimed) {
  const tiers = [
    ["artist+album+title", lookup(index.byArtistTitle, key.nArtist, key.nTitle).filter((row) => row.nAlbum === key.nAlbum), DURATION_TOLERANCE],
    ["artist+title", lookup(index.byArtistTitle, key.nArtist, key.nTitle), DURATION_TOLERANCE],
    ["album artist+title", lookup(index.byArtistTitle, key.nAlbumArtist, key.nTitle), DURATION_TOLERANCE],
    ["artist variant+title", key.variants.flatMap((alt) => lookup(index.byArtistTitle, alt, key.nTitle)), DURATION_TOLERANCE],
    ["artist variant+bare title", key.variants.flatMap((alt) => lookup(index.byArtistBare, alt, key.bTitle)), DURATION_TOLERANCE],
    ["artist+loose title", lookup(index.byArtistLoose, key.nArtist, key.lTitle), DURATION_TOLERANCE],
    ["artist+bare title", lookup(index.byArtistBare, key.nArtist, key.bTitle), DURATION_TOLERANCE],
    ["album artist+bare title", lookup(index.byArtistBare, key.nAlbumArtist, key.bTitle), DURATION_TOLERANCE],
    ["group name+title", key.coreArtist === key.nArtist ? [] : lookup(index.byArtistTitle, key.coreArtist, key.nTitle), DURATION_TOLERANCE],
    ["group name+bare title", key.coreArtist === key.nArtist ? [] : lookup(index.byArtistBare, key.coreArtist, key.bTitle), DURATION_TOLERANCE],
    ["artist+title, other length", lookup(index.byArtistTitle, key.nArtist, key.nTitle), 15],
  ];
  for (const [method, candidates, tolerance] of tiers) {
    if (!candidates.length) continue;
    const found = pick(candidates, key, tolerance, claimed);
    if (found) return { method, trackId: found.row.trackId, ambiguous: found.ambiguous };
  }

  if (key.nArtist && key.lTitle) {
    const scored = [...new Set([...lookup(index.byArtist, key.nArtist), ...lookup(index.byArtist, key.coreArtist)])]
      .filter((row) => !claimed.has(row.trackId) && Math.abs(row.duration - key.duration) <= DURATION_TOLERANCE)
      .map((row) => [similarity(key.lTitle, row.lTitle), row])
      .filter(([score]) => score >= 0.82)
      .sort((a, b) => b[0] - a[0]);
    if (scored.length) {
      return {
        method: "fuzzy title",
        trackId: scored[0][1].trackId,
        ambiguous: scored.length > 1 && scored[1][0] === scored[0][0],
      };
    }
  }

  if (key.nAlbum) {
    // Same artist and album, the same length to the second, and a title that
    // at least resembles: "Ocean" against "The Ocean".
    const pool = [...new Set([
      ...lookup(index.byArtistAlbum, key.nArtist, key.nAlbum),
      ...lookup(index.byArtistAlbum, key.coreArtist, key.nAlbum),
    ])].filter((row) => !claimed.has(row.trackId));
    const sameLength = pool
      .filter((row) => Math.abs(row.duration - key.duration) <= 1)
      .map((row) => [similarity(key.bTitle, row.bTitle), row])
      .filter(([score, row]) => score >= 0.5 || (key.bTitle && (row.bTitle.includes(key.bTitle) || key.bTitle.includes(row.bTitle))))
      .sort((a, b) => b[0] - a[0]);
    if (sameLength.length) {
      return { method: "same album+length, similar title", trackId: sameLength[0][1].trackId, ambiguous: sameLength.length > 1 };
    }
    // A radio edit or another pressing: near-identical title, any length.
    const sameTitle = key.bTitle
      ? pool
        .map((row) => [similarity(key.bTitle, row.bTitle), row])
        .filter(([score]) => score >= 0.8)
        .sort((a, b) => b[0] - a[0] || Math.abs(a[1].duration - key.duration) - Math.abs(b[1].duration - key.duration))
      : [];
    if (sameTitle.length) {
      return {
        method: "same album+title, other length",
        trackId: sameTitle[0][1].trackId,
        ambiguous: sameTitle.length > 1 && sameTitle[1][0] === sameTitle[0][0],
      };
    }
  }
  return null;
}

/**
 * The songs still waiting on an album that is on the server, paired with its
 * free tracks by length. Only when the album name picks out one record by one
 * artist, and the length picks out a track, since "Greatest Hits" names a
 * dozen records.
 */
function claimByAlbumAndLength(pending, index, claimed, links) {
  const wanted = new Map();
  for (const { record, key } of pending) {
    if (links.has(record.id) || !key.nAlbum) continue;
    const rows = index.byAlbum.get(key.nAlbum);
    if (!rows || new Set(rows.map((row) => row.nAlbumArtist || row.nArtist)).size > 1) continue;
    for (const row of rows) {
      if (claimed.has(row.trackId)) continue;
      const gap = Math.abs(row.duration - key.duration);
      if (gap <= DURATION_TOLERANCE) push(wanted, key.nAlbum, { gap, record, key, row });
    }
  }
  for (const candidates of wanted.values()) {
    const gaps = new Map();
    for (const { record, gap } of candidates) push(gaps, record.id, gap);
    const tied = new Set([...gaps].filter(([, list]) => list.length > 1 && [...list].sort((a, b) => a - b)[0] === [...list].sort((a, b) => a - b)[1]).map(([id]) => id));
    candidates.sort((a, b) => a.gap - b.gap);
    for (const { gap, record, key, row } of candidates) {
      if (tied.has(record.id) || links.has(record.id) || claimed.has(row.trackId)) continue;
      claimed.add(row.trackId);
      const informative = key.bTitle && row.bTitle && !TRACK_NO.test(key.bTitle);
      const unlike = informative && similarity(key.bTitle, row.bTitle) < 0.3;
      links.set(record.id, { method: "album+length", trackId: row.trackId, ambiguous: gap > 1 || Boolean(unlike) });
    }
  }
}

// An album recognised by its shape needs most of the server's copy accounted
// for, by several songs, and no second album with a comparable claim.
const SHAPE_MIN_SONGS = 3;
const SHAPE_MIN_SHARE = 0.6;
const SHAPE_TITLE = 0.85;

/** Records that name the same title at the same length as this file. */
function titleAgreement(key, row) {
  if (Math.abs(row.duration - key.duration) > DURATION_TOLERANCE) return 0;
  if (key.nTitle && key.nTitle === row.nTitle) return 1;
  if (key.bTitle && key.bTitle === row.bTitle) return 0.95;
  if (!key.bTitle || !row.bTitle) return 0;
  const score = similarity(key.bTitle, row.bTitle);
  return score >= SHAPE_TITLE ? score : 0;
}

/**
 * An album placed by its shape rather than its credit: most of one album on
 * the server carries the same titles at the same lengths as the songs of one
 * album in his library.
 *
 * This is what reaches a record whose credit is simply wrong, where no amount
 * of comparing artists can help. A compilation iTunes filed under its own name
 * - every song by "Celtic Christmas" - against the server's "Various Artists".
 * A rip whose artist came back from CDDB as "StellarStar" when the band is
 * "stellastarr*", album and all. Both had every title and every length right.
 *
 * The agreement has to fill the server's album, not just appear in it, so a
 * carol that turns up on forty Christmas records cannot carry one on its own,
 * and a second album with a comparable claim calls the whole thing off.
 */
function claimByAlbumShape(pending, index, claimed, links, linkedAlbums) {
  const groups = new Map();
  for (const entry of pending) {
    if (links.has(entry.record.id) || !entry.key.nAlbum) continue;
    push(groups, entry.key.nAlbum, entry);
  }
  for (const entries of groups.values()) {
    if (entries.length < SHAPE_MIN_SONGS) continue;
    // Which album on the server holds these songs, and which file is each one.
    const votes = new Map();
    for (const entry of entries) {
      const { key } = entry;
      const seen = new Set();
      for (const row of [...lookup(index.byTitle, key.nTitle), ...lookup(index.byBareTitle, key.bTitle)]) {
        if (row.albumId == null || seen.has(row.trackId)) continue;
        seen.add(row.trackId);
        const score = titleAgreement(key, row);
        if (!score) continue;
        let album = votes.get(row.albumId);
        if (!album) votes.set(row.albumId, (album = new Map()));
        const held = album.get(entry.record.id);
        if (!held || score > held.score) album.set(entry.record.id, { entry, row, score });
      }
    }
    const ranked = [...votes].sort((a, b) => b[1].size - a[1].size);
    const [best, runnerUp] = ranked;
    if (!best) continue;
    const [albumId, chosen] = best;
    const albumTracks = (index.byAlbumId.get(albumId) || []).length;
    if (chosen.size < SHAPE_MIN_SONGS || chosen.size < albumTracks * SHAPE_MIN_SHARE) continue;
    if (runnerUp && chosen.size < runnerUp[1].size * 2) continue;
    for (const { entry, row, score } of chosen.values()) {
      if (claimed.has(row.trackId) || links.has(entry.record.id)) continue;
      claimed.add(row.trackId);
      links.set(entry.record.id, { method: "album shape", trackId: row.trackId, ambiguous: score < 0.95 });
      const albumKey = `${normArtist(entry.record.albumArtist || entry.record.artist)}\n${entry.key.nAlbum}`;
      if (!linkedAlbums.has(albumKey)) linkedAlbums.set(albumKey, albumId);
    }
  }
}

/**
 * Stragglers on an album most of which already matched: the few free tracks of
 * that album are the only candidates, so a typo or a dropped article becomes
 * decidable. The title has to agree as well as the length.
 */
function claimLeftovers(pending, index, claimed, links, linkedAlbumsByKey) {
  const proposals = [];
  for (const { record, key } of pending) {
    if (links.has(record.id)) continue;
    const albumId = linkedAlbumsByKey.get(`${normArtist(record.albumArtist || record.artist)}\n${key.nAlbum}`);
    if (!albumId) continue;
    const near = index.rows.filter((row) => row.albumId === albumId && !claimed.has(row.trackId)
      && Math.abs(row.duration - key.duration) <= DURATION_TOLERANCE);
    if (!near.length || !key.bTitle) continue;
    const scored = near
      .map((row) => {
        const target = row.bTitle || row.nTitle;
        let score = similarity(key.bTitle, target);
        if (target && (target.includes(key.bTitle) || key.bTitle.includes(target))) score = Math.max(score, 0.9);
        return [score, row];
      })
      .sort((a, b) => b[0] - a[0]);
    const [best, runner] = scored;
    if (best[0] < 0.6 || (runner && best[0] - runner[0] < 0.15)) continue;
    const left = TRACK_NO.exec(key.bTitle);
    const right = TRACK_NO.exec(best[1].bTitle || "");
    if (left && right && left[1] !== right[1]) continue;
    proposals.push({ score: best[0], record, row: best[1] });
  }
  proposals.sort((a, b) => b.score - a.score);
  for (const { score, record, row } of proposals) {
    if (claimed.has(row.trackId) || links.has(record.id)) continue;
    claimed.add(row.trackId);
    links.set(record.id, { method: "free slot on a part-matched album", trackId: row.trackId, ambiguous: score < 0.75 });
  }
}

/**
 * Links for the records given, as a Map of record id to
 * { trackId, method, ambiguous }. `claimedTrackIds` are files other records
 * already hold; `linkedAlbums` maps "artist\nalbum" (normalised as
 * normArtist/normAlbum) to the album id where that iTunes album's songs
 * already landed.
 */
export function matchRecords(records = [], index, { claimedTrackIds = new Set(), linkedAlbums = new Map() } = {}) {
  const claimed = new Set(claimedTrackIds);
  const links = new Map();
  const pending = records.map((record) => ({ record, key: recordKey(record) }));
  for (const { record, key } of pending) {
    const found = matchOne(key, index, claimed);
    if (!found) continue;
    claimed.add(found.trackId);
    links.set(record.id, found);
  }
  claimByAlbumAndLength(pending, index, claimed, links);
  // The shape pass can name an album the earlier tiers never placed, so the
  // leftovers pass runs after it with that album in hand.
  const albums = new Map(linkedAlbums);
  claimByAlbumShape(pending, index, claimed, links, albums);
  claimLeftovers(pending, index, claimed, links, albums);
  return links;
}
