import { getData, postData, deleteData } from "../core.js";

export const getMyUserLibrary = (options = {}) => getData("/user-library", options);

export const getUserLibraryCatalog = (options = {}) => getData("/user-library/catalog", options);

export const getNewToServer = (options = {}) => getData("/user-library/new", options);

export const addArtistToMyLibrary = (mbid) => postData("/user-library/artists", { mbid });

export const addArtistsToMyLibraryBulk = (mbids) =>
  postData("/user-library/artists/bulk", { mbids, action: "add" });

export const removeArtistsFromMyLibraryBulk = (mbids) =>
  postData("/user-library/artists/bulk", { mbids, action: "remove" });

export const removeArtistFromMyLibrary = (mbid) =>
  deleteData(`/user-library/artists/${encodeURIComponent(mbid)}`);

export const syncUserLibraries = () => postData("/user-library/sync");

// Single albums, put in your library without the rest of the artist.
export const getMyLibraryAlbums = (options = {}) => getData("/user-library/albums", options);

export const removeMyLibraryAlbums = (folders) => postData("/user-library/albums/remove", { folders });
