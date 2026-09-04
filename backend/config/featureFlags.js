// Deployment-level feature switches. These are env-driven so an operator can
// turn a whole subsystem off regardless of per-user permissions or admin role.

// AURRAL_PLAYLISTS_ENABLED=false disables playlist making entirely: the
// accessFlow permission is denied for everyone (admins included), which gates
// all playlist creation routes and UI, and the automatic discovery/weekly-flow
// playlist builders stop running.
export const isPlaylistsEnabled = () => process.env.AURRAL_PLAYLISTS_ENABLED !== "false";

// AURRAL_DISCOVERY_ENABLED=false disables discovery entirely: no refresh is
// ever enqueued or run, the refresh route reports it off, and the Discover UI
// is hidden. Discovery samples the whole library, which is expensive on a large
// one, so this exists to keep it from running at all.
export const isDiscoveryEnabled = () => process.env.AURRAL_DISCOVERY_ENABLED !== "false";

// AURRAL_LIBRARY_RECOMMENDATIONS_ENABLED=false drops the whole-library
// recommendation engine: no taste profile, no recommendation pipeline, no
// genre stats, and the three rails built from them ("Recommended", "Global
// Trending", "Because You Like") disappear from Discover.
//
// Those rails describe one taste profile sampled from the entire server. That
// is defensible on a single-owner install and meaningless on a shared one,
// where every member curates their own personal library — and it is by far the
// most expensive thing discovery does. The per-user rails (New to Server,
// Recently Added, Recent Releases, Shows Near You, Artist News) are scoped to
// the viewer's library and keep working.
export const isLibraryRecommendationsEnabled = () =>
  process.env.AURRAL_LIBRARY_RECOMMENDATIONS_ENABLED !== "false";

// The discovery refresh exists to build that whole-library cache — taste
// profile, recommendations, genre stats and the discovery playlists derived
// from them — so it only runs when both switches are on. The rails that read
// the library per-user fetch on request and never wait for it.
export const isDiscoveryRefreshEnabled = () =>
  isDiscoveryEnabled() && isLibraryRecommendationsEnabled();

// AURRAL_PLAYLIST_NORMALIZE_ENABLED=true rewrites hand-made Navidrome playlists
// onto the main library after each user-library reconcile, so a playlist built
// while browsing a personal library stops being invisible to everyone else.
//
// Opt-in rather than opt-out: it edits playlists people made by hand, and an
// install without personal libraries has nothing for it to fix.
export const isPlaylistNormalizeEnabled = () =>
  process.env.AURRAL_PLAYLIST_NORMALIZE_ENABLED === "true";
