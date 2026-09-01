// Deployment-level feature switches. These are env-driven so an operator can
// turn a whole subsystem off regardless of per-user permissions or admin role.

// AURRAL_PLAYLISTS_ENABLED=false disables playlist making entirely: the
// accessFlow permission is denied for everyone (admins included), which gates
// all playlist creation routes and UI, and the automatic discovery/weekly-flow
// playlist builders stop running.
export const isPlaylistsEnabled = () => process.env.AURRAL_PLAYLISTS_ENABLED !== "false";
