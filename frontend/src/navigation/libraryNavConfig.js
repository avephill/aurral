export const DEFAULT_LIBRARY_VIEW = "home";

export const LIBRARY_VIEWS = [
  { id: "favorites", label: "Favorites", path: "/library/favorites" },
  { id: "albums", label: "Albums", path: "/library/albums" },
  // No "Tracks" view: a quarter of a million rows is not something anyone
  // browses, and the page had to build the whole list to show the first screen.
  // Track-level access is through an album, a search or a playlist.
  { id: "album-artists", label: "Album Artists", path: "/library/album-artists" },
  { id: "artists", label: "Artists", path: "/library/artists" },
  { id: "genres", label: "Genres", path: "/library/genres" },
  { id: "playlists", label: "Playlists", path: "/library/playlists", permission: "accessFlow" },
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
