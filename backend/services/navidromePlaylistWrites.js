// Changing what a Navidrome playlist holds, safely.
//
// Two things about Navidrome make the obvious Subsonic calls unsafe:
//
// - A person's own connection hides playlist entries from libraries they
//   cannot open, but Navidrome counts positions against the whole list. A
//   playlist of Dad's showed him 11,531 of its 11,997 songs, and removing
//   "his" first song removed whichever hidden one stood first.
// - Like any recent Go program, Navidrome ignores a request carrying more than
//   10,000 parameters, without saying so. Rewriting a playlist of 11,000 to
//   100 in one updatePlaylist call left all 11,000 and added the 100 after.
//
// So entries are written through the admin's native API, which sees all of
// them and names each entry by its own id, in chunks, and checked afterwards.

export class PlaylistWriteError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

/** Make a playlist hold exactly these songs, in this order, and check it does. */
export async function rewritePlaylistEntries(admin, playlistId, songIds) {
  const ids = (Array.isArray(songIds) ? songIds : []).filter(Boolean).map(String);
  const current = await admin.getPlaylistTracks(playlistId);
  if (current.length) await admin.removePlaylistTracks(playlistId, current.map((track) => track.id));
  if (ids.length) await admin.addPlaylistTracks(playlistId, ids);
  const after = await admin.getPlaylistTracks(playlistId);
  if (after.length !== ids.length) {
    throw new PlaylistWriteError(`The playlist has ${after.length} songs after rewriting, not ${ids.length}`, 500);
  }
  return after.length;
}

// Which libraries a person's own connection can see; null means all of them.
async function visibleLibraryIds(admin, username) {
  const users = await admin.getUsers();
  const found = (Array.isArray(users) ? users : []).find((user) => (user?.userName || user?.username) === username);
  if (!found) throw new PlaylistWriteError(`Navidrome has no user called ${username}`, 404);
  if (found.isAdmin) return null;
  const libraries = await admin.getUserLibraries(found.id);
  return new Set((Array.isArray(libraries) ? libraries : []).map((library) => Number(library?.id ?? library)));
}

/**
 * Remove entries by their position in the list as this person sees it - the
 * only list they or their apps know - by finding the same entries in the
 * whole one. Their view is read again and has to line up exactly; if it does
 * not, the playlist changed in between and nothing is removed.
 */
export async function removeVisibleEntries({ admin, client, playlistId, username, indexes }) {
  const wanted = [...new Set((Array.isArray(indexes) ? indexes : [])
    .map(Number).filter((value) => Number.isInteger(value) && value >= 0))];
  if (!wanted.length) return 0;
  const [all, libraries, theirs] = await Promise.all([
    admin.getPlaylistTracks(playlistId),
    visibleLibraryIds(admin, username),
    client.getPlaylist(playlistId),
  ]);
  const visible = libraries ? all.filter((track) => libraries.has(Number(track.libraryId))) : all;
  const seen = theirs?.entry ? (Array.isArray(theirs.entry) ? theirs.entry : [theirs.entry]) : [];
  const lineUp = seen.length === visible.length
    && seen.every((entry, index) => String(entry.id) === String(visible[index].mediaFileId));
  if (!lineUp) throw new PlaylistWriteError("This playlist was edited elsewhere. Reload it and try again.");
  const entryIds = wanted.map((index) => visible[index]?.id);
  if (entryIds.some((id) => id == null)) throw new PlaylistWriteError("Entry not found", 404);
  await admin.removePlaylistTracks(playlistId, entryIds);
  return entryIds.length;
}
