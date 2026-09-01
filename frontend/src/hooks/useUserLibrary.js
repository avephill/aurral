import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMyUserLibrary,
  addArtistToMyLibrary,
  removeArtistFromMyLibrary,
} from "../utils/api/endpoints/userLibrary.js";
import { useToast } from "../contexts/ToastContext";

const USER_LIBRARY_QUERY_KEY = ["user-library"];

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
    onError: (error) =>
      showError(
        error?.response?.data?.error || error?.message || "Failed to add to your library",
      ),
  });

  const removeMutation = useMutation({
    mutationFn: () => removeArtistFromMyLibrary(mbid),
    onSuccess: invalidate,
    onError: (error) =>
      showError(
        error?.response?.data?.error || error?.message || "Failed to remove from your library",
      ),
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
