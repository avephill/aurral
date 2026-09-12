export const DEFAULT_LIBRARY_VIEW = "home";

export const LIBRARY_VIEWS = [
  { id: "favorites", label: "Favorites", path: "/library/favorites" },
  { id: "albums", label: "Albums", path: "/library/albums" },
  // No "Tracks" view: a quarter of a million rows is not something anyone
  // browses, and the page had to build the whole list to show the first screen.
  // Track-level access is through an album, a search or a playlist.
  // One artist list, not two. "Album Artists" and "Artists" rendered the same
  // data here, and the distinction is a cataloguer's rather than a listener's:
  // the track-level credit fills the sidebar with everyone who guested once.
  // /library/album-artists still resolves, so old links keep working.
  { id: "artists", label: "Artists", path: "/library/artists" },
  { id: "genres", label: "Genres", path: "/library/genres" },
  // Not gated on accessFlow: with Navidrome-backed playlists these are the
  // person's own lists, read and written as them. accessFlow gates what Aurral
  // generates, which is a different thing.
  { id: "playlists", label: "Playlists", path: "/library/playlists" },
  // Personal-library bulk editor; only offered when the admin enabled user libraries.
  { id: "mine", label: "Bulk migration", path: "/library/mine", requiresUserLibraries: true },
];

export const isLibraryViewAvailable = (view, { hasPermission, userLibrariesEnabled } = {}) => {
  if (view.permission && !(typeof hasPermission === "function" && hasPermission(view.permission))) {
    return false;
  }
  if (view.requiresUserLibraries && !userLibrariesEnabled) return false;
  return true;
};
