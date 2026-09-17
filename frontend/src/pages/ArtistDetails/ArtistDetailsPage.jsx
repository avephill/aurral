import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  getArtistCover,
  getArtistDetails,
  fetchArtistOverrides,
  getArtistPreview,
  getSimilarArtistsForArtist,
  updateArtistOverrides,
} from "../../utils/api/endpoints/artists.js";
import { addArtistToLibrary } from "../../utils/api/endpoints/library.js";
import { getCoverImage } from "./utils";
import { useArtistTasteFeedback } from "../../hooks/useArtistTasteFeedback";

import { useParams, useLocation } from "react-router-dom";
import { useDiscoverNavigation } from "../../hooks/useDiscoverNavigation";
import { Music, X } from "lucide-react";
import { DotLoader } from "../../components/DotLoader";
import { useToast } from "../../contexts/ToastContext";
import { useAuth } from "../../contexts/AuthContext";
import { useUserLibrary } from "../../hooks/useUserLibrary.js";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useModalDialog } from "../../hooks/useModalDialog.js";
import { useArtistDetailsStream } from "./hooks/useArtistDetailsStream";
import { usePreviewPlayer } from "./hooks/usePreviewPlayer";
import { useArtistDetailsLibrary } from "./hooks/useArtistDetailsLibrary";
import { useArtistSearchFocus } from "./hooks/useArtistSearchFocus";
import { ARTIST_DETAILS_APPEARS_ON_LIMIT, allReleaseTypes } from "./constants";
import { ArtistDetailsHero } from "./components/ArtistDetailsHero";
import { ArtistDetailsActionBar } from "./components/ArtistDetailsActionBar";
import { ArtistDetailsLibraryAlbums } from "./components/ArtistDetailsLibraryAlbums";
import { ArtistDetailsReleaseGroups } from "./components/ArtistDetailsReleaseGroups";
import { ArtistDetailsAppearsOn } from "./components/ArtistDetailsAppearsOn";
import { ArtistDetailsAbout } from "./components/ArtistDetailsAbout";
import { ArtistDetailsSimilar } from "./components/ArtistDetailsSimilar";
import { DeleteArtistModal } from "./components/DeleteArtistModal";
import { DeleteAlbumModal } from "./components/DeleteAlbumModal";
import { AddArtistCustomizeModal } from "./components/AddArtistCustomizeModal";
import { queryClient, queryKeys } from "../../queryClient.js";
const MBID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ArtistDetailsPage() {
  const { mbid } = useParams();
  const { state: locationState } = useLocation();
  const navigate = useDiscoverNavigation();
  const artistNameFromNav = locationState?.artistName;
  const initialLibraryHint = useMemo(
    () => ({
      existsInLibrary:
        typeof locationState?.inLibrary === "boolean" ? locationState.inLibrary : undefined,
      libraryArtist: locationState?.libraryArtist || null,
    }),
    [locationState?.inLibrary, locationState?.libraryArtist],
  );
  const { showSuccess, showError } = useToast();
  const { hasPermission } = useAuth();
  const userLibrary = useUserLibrary(mbid);
  const similarArtistsScrollRef = useRef(null);
  const [showEditIdsModal, setShowEditIdsModal] = useState(false);
  const [idsError, setIdsError] = useState("");
  const [idsValues, setIdsValues] = useState({
    musicbrainzId: "",
    deezerArtistId: "",
  });
  const [visibleReleaseGroupCoverIds, setVisibleReleaseGroupCoverIds] = useState([]);
  const [visibleAppearsOnCoverIds, setVisibleAppearsOnCoverIds] = useState([]);
  const [visibleLibraryCoverIds, setVisibleLibraryCoverIds] = useState([]);

  const artistOverridesQuery = useQuery({
    queryKey: queryKeys.artistOverrides(mbid),
    queryFn: ({ signal }) => fetchArtistOverrides(mbid, { signal }),
    enabled: false,
    staleTime: 30_000,
  });
  const saveArtistOverridesMutation = useMutation({
    mutationFn: ({ artistMbid, values }) => updateArtistOverrides(artistMbid, values),
  });
  const addSimilarArtistMutation = useMutation({
    mutationFn: addArtistToLibrary,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.libraryCanonicalPrefix }),
  });
  const { mutateAsync: saveArtistOverrides } = saveArtistOverridesMutation;
  const { mutateAsync: addSimilarArtist } = addSimilarArtistMutation;
  const idsLoading = artistOverridesQuery.isFetching;
  const idsSaving = saveArtistOverridesMutation.isPending;

  const stream = useArtistDetailsStream(mbid, artistNameFromNav, {
    visibleCoverIds: [
      ...visibleReleaseGroupCoverIds,
      ...visibleAppearsOnCoverIds,
      ...visibleLibraryCoverIds,
    ],
    initialLibraryHint,
    appearsOnLimit: ARTIST_DETAILS_APPEARS_ON_LIMIT,
  });
  const canAddArtist = hasPermission("addArtist");
  const {
    lookup: artistFeedbackLookup,
    getFeedbackFlags,
    submitFeedback,
  } = useArtistTasteFeedback();
  const [tasteActionPending, setTasteActionPending] = useState(null);
  const canAddAlbum = hasPermission("addAlbum");
  const canChangeMonitoring = hasPermission("changeMonitoring");
  const canDeleteArtist = hasPermission("deleteArtist");
  const canDeleteAlbum = hasPermission("deleteAlbum");
  const {
    artist,
    coverImages,
    setCoverImages,
    libraryArtist,
    setLibraryArtist,
    libraryAlbums,
    setLibraryAlbums,
    similarArtists,
    setSimilarArtists,
    loading,
    error,
    setLoadingCover,
    loadingSimilar,
    setLoadingSimilar,
    loadingLibrary,
    loadingReleases,
    loadingAppearsOn,
    existsInLibrary,
    setExistsInLibrary,
    appSettings,
    albumCovers,
    fulfilledCoverIds,
    setAlbumCovers,
    setArtist,
  } = stream;

  const artistDisplayName = artist?.name || artistNameFromNav || "";
  useDocumentTitle(artistDisplayName);

  const tasteArtist = useMemo(
    () => ({
      id: artist?.id || mbid,
      name: artistDisplayName,
      tags: artist?.tags || [],
      genres: artist?.genres || [],
    }),
    [artist?.genres, artist?.id, artist?.tags, artistDisplayName, mbid],
  );

  const currentArtistFeedback = useMemo(
    () => getFeedbackFlags(tasteArtist),
    [getFeedbackFlags, tasteArtist],
  );

  const handleArtistTasteFeedback = useCallback(
    async (targetArtist, action, { isSelected = false } = {}) => {
      setTasteActionPending(action);
      try {
        return await submitFeedback(targetArtist, action, {
          isSelected,
          sourceContext: "artist_page",
          seedArtistName: tasteArtist.name,
        });
      } finally {
        setTasteActionPending(null);
      }
    },
    [submitFeedback, tasteArtist.name],
  );

  const handleCurrentArtistTasteFeedback = useCallback(
    async (action) => {
      await handleArtistTasteFeedback(tasteArtist, action, {
        isSelected: !!currentArtistFeedback[action],
      });
    },
    [currentArtistFeedback, handleArtistTasteFeedback, tasteArtist],
  );

  const handleAddSimilarArtistToLibrary = useCallback(
    async (similarArtist) => {
      const artistId = similarArtist?.id || similarArtist?.mbid;
      if (!similarArtist?.name || !artistId) return false;
      try {
        await addSimilarArtist({
          foreignArtistId: artistId,
          artistName: similarArtist.name,
        });
        showSuccess(`Adding ${similarArtist.name}...`);
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message ||
            err.response?.data?.error ||
            err.message ||
            "Failed to add artist to library",
        );
        return false;
      }
    },
    [addSimilarArtist, showError, showSuccess],
  );

  const library = useArtistDetailsLibrary({
    artist,
    libraryArtist,
    setLibraryArtist,
    libraryAlbums,
    setLibraryAlbums,
    existsInLibrary,
    setExistsInLibrary,
    appSettings,
    showSuccess,
    showError,
  });

  useArtistSearchFocus({
    navigate,
    mbid,
    locationState,
  });

  const preview = usePreviewPlayer(mbid, artistNameFromNav, artist);
  const {
    buildingQueue,
    setLoadingPreview,
    isArtistPlaybackActive,
    handlePreviewPlayAll,
    setPreviewTracks,
  } = preview;

  const handleOpenEditIds = async () => {
    if (!mbid) return;
    setShowEditIdsModal(true);
    setIdsError("");
    try {
      const { data } = await artistOverridesQuery.refetch({ throwOnError: true });
      setIdsValues({
        musicbrainzId: data?.musicbrainzId || "",
        deezerArtistId: data?.deezerArtistId || "",
      });
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to load artist IDs",
      );
    }
  };

  const handleSaveIds = async () => {
    if (!mbid || idsSaving) return;
    const musicbrainzId = idsValues.musicbrainzId.trim();
    const deezerArtistId = idsValues.deezerArtistId.trim();
    if (musicbrainzId && !MBID_REGEX.test(musicbrainzId)) {
      setIdsError("MusicBrainz ID must be a valid UUID.");
      return;
    }
    if (deezerArtistId && !/^\d+$/.test(deezerArtistId)) {
      setIdsError("Deezer Artist ID must be numeric.");
      return;
    }
    setIdsError("");
    setLoadingCover(true);
    setLoadingPreview(true);
    setLoadingSimilar(true);
    try {
      await saveArtistOverrides({
        artistMbid: mbid,
        values: {
          musicbrainzId: musicbrainzId || null,
          deezerArtistId: deezerArtistId || null,
        },
      });
      showSuccess("Artist IDs updated");
      setShowEditIdsModal(false);
      const name = artist?.name || artistNameFromNav || "";
      const [details, cover, previewData, similar] = await Promise.all([
        getArtistDetails(mbid, name, { releaseTypes: allReleaseTypes }).catch(() => null),
        getArtistCover(mbid, name, true).catch(() => ({ images: [] })),
        getArtistPreview(mbid, name).catch(() => ({ tracks: [] })),
        getSimilarArtistsForArtist(mbid, name).catch(() => ({ artists: [] })),
      ]);
      if (details?.id) {
        setArtist(details);
      }
      setAlbumCovers({});
      setCoverImages(cover?.images || []);
      setPreviewTracks(previewData?.tracks || []);
      setSimilarArtists(similar?.artists || []);
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to update artist IDs",
      );
    } finally {
      setLoadingCover(false);
      setLoadingPreview(false);
      setLoadingSimilar(false);
    }
  };

  const handleCoverError = async () => {
    if (!mbid) return;
    const name = artist?.name || artistNameFromNav || "";
    setLoadingCover(true);
    try {
      const cover = await getArtistCover(mbid, name, true).catch(() => ({
        images: [],
      }));
      setCoverImages(cover?.images || []);
    } finally {
      setLoadingCover(false);
    }
  };

  if (loading) {
    return (
      <div className="artist-loading">
        <DotLoader size="2xl" label={null} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="artist-error-panel">
        <div>
          <Music className="artist-error-icon" />
          <h3 className="artist-error-title">Error Loading Artist</h3>
          <p className="artist-error-copy">{error}</p>
          <button
            onClick={() => navigate("/search")}
            className="btn btn-primary artist-hidden-mobile"
          >
            Back to Search
          </button>
        </div>
      </div>
    );
  }

  if (!artist) {
    return null;
  }

  const artistCoverImage = getCoverImage(coverImages);
  return (
    <div className="artist-details-page">
      <ArtistDetailsHero
        artist={artist}
        coverImages={coverImages}
        onCoverError={handleCoverError}
        onNavigate={(path) => navigate(path)}
      />

      <ArtistDetailsActionBar
        library={library}
        existsInLibrary={existsInLibrary}
        loadingLibrary={loadingLibrary}
        canChangeMonitoring={canChangeMonitoring}
        canDeleteArtist={canDeleteArtist}
        canAddArtist={canAddArtist}
        canRefreshArtist={canChangeMonitoring}
        buildingQueue={buildingQueue}
        isArtistPlaybackActive={isArtistPlaybackActive}
        handlePreviewPlayAll={handlePreviewPlayAll}
        onEditIds={handleOpenEditIds}
        onTasteFeedback={handleCurrentArtistTasteFeedback}
        tasteFeedbackUsed={currentArtistFeedback}
        tasteActionPending={tasteActionPending}
        userLibrary={userLibrary}
      />

      {existsInLibrary && libraryAlbums && libraryAlbums.length > 0 && (
        <ArtistDetailsLibraryAlbums
          artist={artist}
          libraryAlbums={libraryAlbums}
          downloadStatuses={library.downloadStatuses}
          requestingAlbum={library.requestingAlbum}
          reSearchingAlbum={library.reSearchingAlbum}
          reSearchingMissingAlbums={library.reSearchingMissingAlbums}
          albumCovers={albumCovers}
          fulfilledCoverIds={fulfilledCoverIds}
          artistCoverImage={artistCoverImage}
          albumDropdownOpen={library.albumDropdownOpen}
          setAlbumDropdownOpen={library.setAlbumDropdownOpen}
          canDeleteAlbum={canDeleteAlbum}
          handleDeleteAlbumClick={library.handleDeleteAlbumClick}
          canReSearchAlbum={canAddAlbum}
          handleReSearchAlbum={library.handleReSearchAlbum}
          handleReSearchMissingDownloads={library.handleReSearchMissingDownloads}
          onVisibleCoverIdsChange={setVisibleLibraryCoverIds}
          artistName={artistDisplayName}
        />
      )}

      {(loadingReleases || (artist["release-groups"] && artist["release-groups"].length > 0)) && (
        <ArtistDetailsReleaseGroups
          artist={artist}
          loadingReleases={loadingReleases}
          albumCovers={albumCovers}
          fulfilledCoverIds={fulfilledCoverIds}
          artistCoverImage={artistCoverImage}
          getAlbumStatus={library.getAlbumStatus}
          canAddAlbum={canAddAlbum}
          handleRequestAlbum={library.handleRequestAlbum}
          requestingAlbum={library.requestingAlbum}
          artistName={artistDisplayName}
          onVisibleCoverIdsChange={setVisibleReleaseGroupCoverIds}
          onViewAll={() =>
            navigate(`/artist/${artist.id}/albums`, {
              state: { artistName: artist.name, inLibrary: existsInLibrary },
            })
          }
        />
      )}

      {(loadingAppearsOn ||
        (artist["appears-on-release-groups"] &&
          artist["appears-on-release-groups"].length > 0)) && (
        <ArtistDetailsAppearsOn
          artist={artist}
          loadingAppearsOn={loadingAppearsOn}
          albumCovers={albumCovers}
          fulfilledCoverIds={fulfilledCoverIds}
          artistCoverImage={artistCoverImage}
          getAlbumStatus={library.getAlbumStatus}
          canAddAlbum={canAddAlbum}
          handleRequestAlbum={library.handleRequestAlbum}
          requestingAlbum={library.requestingAlbum}
          artistName={artistDisplayName}
          onVisibleCoverIdsChange={setVisibleAppearsOnCoverIds}
          onViewAll={() =>
            navigate(`/artist/${artist.id}/appears-on`, {
              state: { artistName: artist.name, inLibrary: existsInLibrary },
            })
          }
        />
      )}

      <ArtistDetailsAbout
        artist={artist}
        libraryArtist={libraryArtist}
        appSettings={appSettings}
        existsInLibrary={existsInLibrary}
        coverImages={coverImages}
        onNavigate={(path) => navigate(path)}
      />

      {(loadingSimilar || similarArtists.length > 0) && (
        <ArtistDetailsSimilar
          loadingSimilar={loadingSimilar}
          similarArtists={similarArtists}
          similarArtistsScrollRef={similarArtistsScrollRef}
          onArtistClick={(id, name, inLibrary = undefined) =>
            navigate(`/artist/${id}`, {
              state: {
                artistName: name,
                ...(typeof inLibrary === "boolean" ? { inLibrary } : {}),
              },
            })
          }
          canAddArtist={canAddArtist}
          onAddToLibrary={handleAddSimilarArtistToLibrary}
          onArtistFeedback={handleArtistTasteFeedback}
          artistFeedbackLookup={artistFeedbackLookup}
        />
      )}

      <DeleteArtistModal
        show={library.showDeleteModal && !!libraryArtist}
        artistName={artist?.name}
        libraryArtistName={libraryArtist?.artistName}
        deleteFiles={library.deleteFiles}
        onDeleteFilesChange={library.setDeleteFiles}
        onCancel={library.handleDeleteCancel}
        onConfirm={library.handleDeleteConfirm}
        deleting={library.deletingArtist}
      />

      <DeleteAlbumModal
        show={!!library.showDeleteAlbumModal}
        title={library.showDeleteAlbumModal?.title}
        deleteFiles={library.deleteAlbumFiles}
        onDeleteFilesChange={library.setDeleteAlbumFiles}
        onCancel={library.handleDeleteAlbumCancel}
        onConfirm={library.handleDeleteAlbumConfirm}
        removing={library.removingAlbum}
      />

      <AddArtistCustomizeModal
        show={library.showAddCustomizeModal}
        artistName={artist?.name}
        loading={library.loadingLidarrPreferences}
        preferences={library.lidarrPreferences}
        rootFolderPath={library.customizeRootFolderPath}
        setRootFolderPath={library.setCustomizeRootFolderPath}
        qualityProfileId={library.customizeQualityProfileId}
        setQualityProfileId={library.setCustomizeQualityProfileId}
        tagId={library.customizeTagId}
        setTagId={library.setCustomizeTagId}
        onClose={() => library.setShowAddCustomizeModal(false)}
        onConfirm={library.handleCustomizeAddToLibrary}
        confirming={library.addingToLibrary}
      />

      <EditArtistIdsModal
        show={showEditIdsModal}
        loading={idsLoading}
        saving={idsSaving}
        values={idsValues}
        error={idsError}
        artistName={artist?.name}
        onChange={setIdsValues}
        onClose={() => setShowEditIdsModal(false)}
        onSave={handleSaveIds}
      />
    </div>
  );
}

export default ArtistDetailsPage;

function EditArtistIdsModal({
  show,
  loading,
  saving,
  values,
  error,
  artistName,
  onChange,
  onClose,
  onSave,
}) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: show,
    onClose,
    closeDisabled: saving,
  });

  if (!show) return null;
  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artist-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="artist-modal__header">
          <h3 id={titleId} className="artist-modal__title">
            Edit Artist IDs
          </h3>
          <button
            type="button"
            className="btn btn-surface btn-icon-square"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X className="artist-icon-md" />
          </button>
        </div>
        <p className="artist-modal__subcopy">
          {artistName ? `${artistName}: ` : ""}
          Update the MusicBrainz or Deezer ID to fix metadata and cover art.
        </p>
        <div className="artist-modal__fields">
          <div>
            <label className="artist-field-label">MusicBrainz ID</label>
            <input
              type="text"
              value={values.musicbrainzId}
              disabled={loading || saving}
              onChange={(e) =>
                onChange((prev) => ({
                  ...prev,
                  musicbrainzId: e.target.value,
                }))
              }
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="artist-input"
            />
          </div>
          <div>
            <label className="artist-field-label">Deezer Artist ID</label>
            <input
              type="text"
              value={values.deezerArtistId}
              disabled={loading || saving}
              onChange={(e) =>
                onChange((prev) => ({
                  ...prev,
                  deezerArtistId: e.target.value,
                }))
              }
              placeholder="Numeric Deezer ID"
              className="artist-input"
            />
          </div>
          <p className="artist-subtext">Leave both fields blank to clear overrides.</p>
          {error && <div className="artist-error-text">{error}</div>}
        </div>
        <div className="artist-modal__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSave}
            disabled={loading || saving}
          >
            {saving ? <DotLoader size="sm" label={null} /> : null}
            {saving ? "Saving..." : "Save IDs"}
          </button>
        </div>
      </div>
    </div>
  );
}
