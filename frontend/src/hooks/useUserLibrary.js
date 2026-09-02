import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMyUserLibrary,
  getNewToServer,
  getUserLibraryCatalog,
  addArtistToMyLibrary,
  addArtistsToMyLibraryBulk,
  removeArtistFromMyLibrary,
  removeArtistsFromMyLibraryBulk,
} from "../utils/api/endpoints/userLibrary.js";
import { useToast } from "../contexts/ToastContext";

const USER_LIBRARY_QUERY_KEY = ["user-library"];
const NEW_TO_SERVER_QUERY_KEY = ["user-library", "new"];
const CATALOG_QUERY_KEY = ["user-library", "catalog"];

const errorMessage = (error, fallback) =>
  error?.response?.data?.error || error?.message || fallback;

export function useUserLibrary(mbid) {
  const queryClient = useQueryClient();
  const { showError } = useToast();

  const query = useQuery({
    queryKey: USER_LIBRARY_QUERY_KEY,
    queryFn: ({ signal }) => getMyUserLibrary({ signal }),
    staleTime: 30000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: USER_LIBRARY_QUERY_KEY });

  const addMutation = useMutation({
    mutationFn: () => addArtistToMyLibrary(mbid),
    onSuccess: invalidate,
    onError: (error) => showError(errorMessage(error, "Failed to add to your library")),
  });

  const removeMutation = useMutation({
    mutationFn: () => removeArtistFromMyLibrary(mbid),
    onSuccess: invalidate,
    onError: (error) =>
      showError(errorMessage(error, "Failed to remove from your library")),
  });

  const enabled = query.data?.enabled === true;
  const inMyLibrary =
    !!mbid &&
    Array.isArray(query.data?.artists) &&
    query.data.artists.some((artist) => artist.mbid === mbid);

  return {
    enabled,
    inMyLibrary,
    artists: query.data?.artists || [],
    loading: query.isLoading,
    pending: addMutation.isPending || removeMutation.isPending,
    add: () => addMutation.mutate(),
    remove: () => removeMutation.mutate(),
  };
}

export function useNewToServer({ enabled = true, days, limit } = {}) {
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToast();
  const [pendingArtistMbid, setPendingArtistMbid] = useState(null);

  const query = useQuery({
    queryKey: [...NEW_TO_SERVER_QUERY_KEY, days || null, limit || null],
    queryFn: ({ signal }) => getNewToServer({ signal, params: { days, limit } }),
    enabled,
    staleTime: 60000,
  });

  const addMutation = useMutation({
    mutationFn: ({ artistMbid }) => addArtistToMyLibrary(artistMbid),
    onMutate: ({ artistMbid }) => setPendingArtistMbid(artistMbid),
    onSuccess: (_result, { artistName }) => {
      showSuccess(`Added ${artistName || "artist"} to your library`);
      queryClient.invalidateQueries({ queryKey: USER_LIBRARY_QUERY_KEY });
    },
    onError: (error) => showError(errorMessage(error, "Failed to add to your library")),
    onSettled: () => setPendingArtistMbid(null),
  });

  const addArtist = useCallback(
    (album) => {
      const artistMbid = album?.artistMbid || album?.foreignArtistId;
      if (!artistMbid || addMutation.isPending) return;
      addMutation.mutate({ artistMbid, artistName: album?.artistName });
    },
    [addMutation],
  );

  return {
    enabled: query.data?.enabled === true,
    albums: Array.isArray(query.data?.albums) ? query.data.albums : [],
    loading: query.isLoading,
    pendingArtistMbid,
    addArtist,
  };
}

const pluralArtists = (count) => `${count} artist${count === 1 ? "" : "s"}`;

// Whole main-library catalog with membership flags, plus bulk add/remove.
export function useUserLibraryCatalog({ enabled = true } = {}) {
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToast();

  const query = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: ({ signal }) => getUserLibraryCatalog({ signal }),
    enabled,
    staleTime: 30000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: USER_LIBRARY_QUERY_KEY });

  const mutation = useMutation({
    mutationFn: ({ mbids, action }) =>
      action === "remove" ? removeArtistsFromMyLibraryBulk(mbids) : addArtistsToMyLibraryBulk(mbids),
    onSuccess: (result, { action }) => {
      const changed = Array.isArray(result?.changed) ? result.changed.length : 0;
      const missing = Array.isArray(result?.missing) ? result.missing.length : 0;
      const verb = action === "remove" ? "Removed" : "Added";
      const preposition = action === "remove" ? "from" : "to";
      showSuccess(
        `${verb} ${pluralArtists(changed)} ${preposition} your library${missing ? ` (${missing} not in the main library)` : ""}`,
      );
      invalidate();
    },
    onError: (error, { action }) =>
      showError(
        errorMessage(
          error,
          action === "remove" ? "Failed to remove from your library" : "Failed to add to your library",
        ),
      ),
  });

  const apply = useCallback(
    (mbids, action) => {
      const list = Array.isArray(mbids) ? mbids.filter(Boolean) : [];
      if (!list.length || mutation.isPending) return Promise.resolve(null);
      return mutation.mutateAsync({ mbids: list, action }).catch(() => null);
    },
    [mutation],
  );

  return {
    enabled: query.data?.enabled === true,
    artists: Array.isArray(query.data?.artists) ? query.data.artists : [],
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    pending: mutation.isPending,
    pendingAction: mutation.isPending ? mutation.variables?.action : null,
    addArtists: (mbids) => apply(mbids, "add"),
    removeArtists: (mbids) => apply(mbids, "remove"),
  };
}
