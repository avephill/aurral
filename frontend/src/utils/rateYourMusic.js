// RateYourMusic has no API and no id in anyone's metadata, so there are only
// two ways to reach an artist's page there. MusicBrainz sometimes carries the
// real URL as an "other databases" relation, and that is the one to use. When
// it does not, a guessed slug is worse than useless - RYM disambiguates names
// with suffixes and 404s on anything else - so fall back to its search, which
// always lands somewhere sensible.

const RATE_YOUR_MUSIC_HOST = /(^|\.)rateyourmusic\.com$/i;

export const isRateYourMusicUrl = (href) => {
  try {
    return RATE_YOUR_MUSIC_HOST.test(new URL(String(href)).hostname);
  } catch {
    return false;
  }
};

export const rateYourMusicSearchUrl = (name) =>
  `https://rateyourmusic.com/search?searchterm=${encodeURIComponent(String(name || "").trim())}&searchtype=a`;

/**
 * The best RateYourMusic link for an artist, or null when there is not even a
 * name to search with. `exact` says whether it goes straight to their page.
 */
export function rateYourMusicLink({ name, hrefs = [] } = {}) {
  const known = (Array.isArray(hrefs) ? hrefs : []).find((href) => isRateYourMusicUrl(href));
  if (known) return { href: String(known), exact: true };
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  return { href: rateYourMusicSearchUrl(trimmed), exact: false };
}
