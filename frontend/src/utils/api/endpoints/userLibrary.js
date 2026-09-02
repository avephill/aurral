import { getData, postData, deleteData } from "../core.js";

export const getMyUserLibrary = (options = {}) => getData("/user-library", options);

export const getNewToServer = (options = {}) => getData("/user-library/new", options);

export const addArtistToMyLibrary = (mbid) => postData("/user-library/artists", { mbid });

export const addArtistsToMyLibraryBulk = (mbids) =>
  postData("/user-library/artists/bulk", { mbids });

export const removeArtistFromMyLibrary = (mbid) =>
  deleteData(`/user-library/artists/${encodeURIComponent(mbid)}`);

export const syncUserLibraries = () => postData("/user-library/sync");
