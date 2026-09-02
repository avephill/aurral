// Parsing and fuzzy matching for bulk artist-list imports. Kept free of React
// so the rules can be exercised directly in tests.

const LIST_MARKER = /^\s*(?:[-*•·–—]|\d+[.)])\s+/;
const WRAPPING_QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g;
const MARKDOWN_HEADING = /^#{1,6}\s/;
const HEADER_LABELS = new Set(["artist", "artists", "artist name", "name", "band", "bands"]);

// Letters that NFD leaves alone but that people type interchangeably with
// their plain-ASCII form.
const TRANSLITERATIONS = [
  [/ß/g, "ss"],
  [/æ/g, "ae"],
  [/œ/g, "oe"],
  [/ø/g, "o"],
  [/[ðđ]/g, "d"],
  [/þ/g, "th"],
  [/ł/g, "l"],
];

// Anything at or above this is treated as the answer and preselected.
export const AUTO_MATCH_SCORE = 0.82;
// Below this a candidate is not worth showing at all.
export const CANDIDATE_SCORE = 0.55;

export function normalizeArtistName(value) {
  let text = String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  for (const [pattern, replacement] of TRANSLITERATIONS) {
    text = text.replace(pattern, replacement);
  }
  return text
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// A leading "the" is noise for matching but never for display.
export function artistMatchKey(value) {
  return normalizeArtistName(value).replace(/^the\s+/, "");
}

function cleanArtistLine(line) {
  let value = String(line ?? "");
  // Tabs never appear inside an artist name, so a tab means extra columns
  // pasted from a spreadsheet or a TSV export.
  if (value.includes("\t")) value = value.slice(0, value.indexOf("\t"));
  value = value.trim();
  if (!value) return "";
  if (MARKDOWN_HEADING.test(value)) return "";
  value = value.replace(LIST_MARKER, "");
  value = value.replace(WRAPPING_QUOTES, "");
  return value.trim();
}

/**
 * Turns pasted or uploaded text into a de-duplicated list of artist names.
 * One name per line; list markers, quotes, spreadsheet columns, markdown
 * headings and a leading column header are stripped.
 */
export function parseArtistList(text) {
  const entries = [];
  const seen = new Map();
  let checkedHeader = false;

  for (const line of String(text ?? "").split(/\r?\n/)) {
    const name = cleanArtistLine(line);
    if (!name) continue;
    if (!checkedHeader) {
      checkedHeader = true;
      if (HEADER_LABELS.has(normalizeArtistName(name))) continue;
    }
    const key = artistMatchKey(name);
    if (!key) continue;
    const existing = seen.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    const entry = { id: `row-${entries.length}`, input: name, key, occurrences: 1 };
    seen.set(key, entry);
    entries.push(entry);
  }

  return entries;
}

function bigrams(value) {
  const grams = new Map();
  for (let index = 0; index < value.length - 1; index += 1) {
    const gram = value.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  return grams;
}

function diceFromGrams(left, leftTotal, right, rightTotal) {
  if (!leftTotal || !rightTotal) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const [gram, count] of small) {
    const other = large.get(gram);
    if (other) shared += Math.min(count, other);
  }
  return (2 * shared) / (leftTotal + rightTotal);
}

/** Sørensen–Dice similarity over character bigrams, 0..1. */
export function similarity(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  return diceFromGrams(leftGrams, left.length - 1, rightGrams, right.length - 1);
}

/**
 * Precomputes lookup keys and bigrams for the catalog so a long import list
 * does not rebuild them for every row.
 */
export function buildArtistIndex(artists) {
  const byKey = new Map();
  const terms = [];
  const seenTerm = new Map();

  const addTerm = (key, artist) => {
    if (!key) return;
    let term = seenTerm.get(key);
    if (!term) {
      term = { key, grams: bigrams(key), total: Math.max(0, key.length - 1), artists: [] };
      seenTerm.set(key, term);
      terms.push(term);
    }
    if (!term.artists.includes(artist)) term.artists.push(artist);
  };

  for (const artist of Array.isArray(artists) ? artists : []) {
    if (!artist?.mbid) continue;
    const keys = new Set();
    keys.add(artistMatchKey(artist.artistName));
    // "Beatles, The" normalizes to "beatles the"; drop the trailing article so
    // it lines up with what someone actually types.
    const sortKey = artistMatchKey(artist.sortName);
    keys.add(sortKey);
    keys.add(sortKey.replace(/\s+the$/, ""));
    for (const key of keys) {
      if (!key) continue;
      addTerm(key, artist);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.includes(artist)) existing.push(artist);
      } else {
        byKey.set(key, [artist]);
      }
    }
  }

  return { byKey, terms };
}

const toCandidate = (artist, score) => ({
  mbid: artist.mbid,
  artistName: artist.artistName,
  inLibrary: !!artist.inLibrary,
  libraryAlbumCount: Number(artist.libraryAlbumCount) || 0,
  score,
});

function fuzzyCandidates(key, index, limit) {
  const grams = bigrams(key);
  const total = Math.max(0, key.length - 1);
  const best = new Map();

  for (const term of index.terms) {
    // Names of wildly different length can never clear the threshold, and
    // skipping them keeps a long list responsive.
    const ratio = Math.min(term.key.length, key.length) / Math.max(term.key.length, key.length);
    if (ratio < 0.5) continue;
    const score = diceFromGrams(grams, total, term.grams, term.total);
    if (score < CANDIDATE_SCORE) continue;
    for (const artist of term.artists) {
      const current = best.get(artist.mbid);
      if (!current || score > current.score) best.set(artist.mbid, toCandidate(artist, score));
    }
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.artistName.localeCompare(b.artistName))
    .slice(0, limit);
}

/**
 * Resolves one parsed name against the catalog.
 *
 * status is one of:
 *   exact     - the name matches a catalog artist outright
 *   ambiguous - several artists share that exact name
 *   close     - only a fuzzy match, so it wants a human look
 *   none      - nothing near enough to suggest
 */
export function matchArtistEntry(entry, index, { limit = 6 } = {}) {
  const exact = index.byKey.get(entry.key);
  if (exact?.length) {
    const candidates = exact.map((artist) => toCandidate(artist, 1));
    return {
      ...entry,
      status: exact.length > 1 ? "ambiguous" : "exact",
      candidates,
      selected: candidates[0].mbid,
    };
  }

  const candidates = fuzzyCandidates(entry.key, index, limit);
  if (!candidates.length) {
    return { ...entry, status: "none", candidates: [], selected: "" };
  }
  const [top] = candidates;
  const confident = top.score >= AUTO_MATCH_SCORE && (candidates[1]?.score ?? 0) < top.score;
  return {
    ...entry,
    status: "close",
    candidates,
    selected: confident ? top.mbid : "",
  };
}

/** Parses text and resolves every line against the catalog in one pass. */
export function matchArtistList(text, artists, options = {}) {
  const entries = parseArtistList(text);
  if (!entries.length) return [];
  const index = buildArtistIndex(artists);
  return entries.map((entry) => matchArtistEntry(entry, index, options));
}
