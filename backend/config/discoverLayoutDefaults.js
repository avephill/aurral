import { isLibraryRecommendationsEnabled } from "./featureFlags.js";

export const DISCOVER_SECTION_IDS = [
  "newToServer",
  "recentlyAdded",
  "playlists",
  "recommendedShows",
  "recentReleases",
  "news",
  "recommended",
  "globalTop",
  "genreSections",
];

// Rails derived from the whole-library recommendation engine. With that engine
// off they have no data to show, so they are dropped from the layout entirely
// rather than offered as a switch that does nothing.
export const LIBRARY_RECOMMENDATION_SECTION_IDS = ["recommended", "globalTop", "genreSections"];

const getAvailableSectionIds = () =>
  isLibraryRecommendationsEnabled()
    ? DISCOVER_SECTION_IDS
    : DISCOVER_SECTION_IDS.filter((id) => !LIBRARY_RECOMMENDATION_SECTION_IDS.includes(id));

// AURRAL_DISCOVER_DEFAULT_SECTIONS is a comma-separated, ordered list of the
// section ids enabled by default for users who have not saved a layout.
// Sections not listed are appended disabled so users can still turn them back
// on. Unset, or containing no valid id, keeps every section enabled in the
// standard order.
export const getDefaultDiscoverLayout = () => {
  const available = getAvailableSectionIds();
  const raw = String(process.env.AURRAL_DISCOVER_DEFAULT_SECTIONS || "").trim();
  const requested = raw
    ? raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => available.includes(id))
    : [];
  if (requested.length === 0) {
    return available.map((id) => ({ id, enabled: true }));
  }
  const seen = new Set();
  const layout = [];
  for (const id of requested) {
    if (seen.has(id)) continue;
    seen.add(id);
    layout.push({ id, enabled: true });
  }
  for (const id of available) {
    if (!seen.has(id)) layout.push({ id, enabled: false });
  }
  return layout;
};
