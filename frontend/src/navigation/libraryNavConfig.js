export const DEFAULT_LIBRARY_VIEW = "home";

// In iTunes order: artists, albums, songs, then playlists and genres.
// Favorites is not listed; hearted songs live in a Favorites playlist, and
// /library/favorites still resolves so old links keep working.
export const LIBRARY_VIEWS = [
  // One artist list, not two. "Album Artists" and "Artists" rendered the same
  // data here, and the distinction is a cataloguer's rather than a listener's:
  // the track-level credit fills the sidebar with everyone who guested once.
  // /library/album-artists still resolves, so old links keep working.
  { id: "artists", label: "Artists", path: "/library/artists" },
  { id: "albums", label: "Albums", path: "/library/albums" },
  // Tracks came back once the canonical endpoint paged on the server: the view
  // now fetches one page of playable tracks rather than building the whole list.
  { id: "tracks", label: "Tracks", path: "/library/tracks" },
  // Not gated on accessFlow: with Navidrome-backed playlists these are the
  // person's own lists, read and written as them. accessFlow gates what Aurral
  // generates, which is a different thing.
  { id: "playlists", label: "Playlists", path: "/library/playlists" },
  { id: "genres", label: "Genres", path: "/library/genres" },
  // Words on songs rather than a property of the file, and what the smart
  // playlists read.
  { id: "tags", label: "Tags", path: "/library/tags" },
  // Personal-library bulk editor; only offered when the admin enabled user libraries.
  {
    id: "mine",
    label: "Bulk migration",
    path: "/library/mine",
    requiresUserLibraries: true,
    // The walkthrough sends people here first, so it needs to be able to find it.
    tour: "bulk-migration",
  },
];

export const isLibraryViewAvailable = (view, { hasPermission, userLibrariesEnabled } = {}) => {
  if (view.permission && !(typeof hasPermission === "function" && hasPermission(view.permission))) {
    return false;
  }
  if (view.requiresUserLibraries && !userLibrariesEnabled) return false;
  return true;
};
