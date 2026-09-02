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

// AURRAL_DISCOVER_DEFAULT_SECTIONS is a comma-separated, ordered list of the
// section ids enabled by default for users who have not saved a layout.
// Sections not listed are appended disabled so users can still turn them back
// on. Unset, or containing no valid id, keeps every section enabled in the
// standard order.
export const getDefaultDiscoverLayout = () => {
  const raw = String(process.env.AURRAL_DISCOVER_DEFAULT_SECTIONS || "").trim();
  const requested = raw
    ? raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => DISCOVER_SECTION_IDS.includes(id))
    : [];
  if (requested.length === 0) {
    return DISCOVER_SECTION_IDS.map((id) => ({ id, enabled: true }));
  }
  const seen = new Set();
  const layout = [];
  for (const id of requested) {
    if (seen.has(id)) continue;
    seen.add(id);
    layout.push({ id, enabled: true });
  }
  for (const id of DISCOVER_SECTION_IDS) {
    if (!seen.has(id)) layout.push({ id, enabled: false });
  }
  return layout;
};
