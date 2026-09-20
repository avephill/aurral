import { useEffect, useMemo, useRef, useState } from "react";
import { useDiscoverNavigation } from "../../../hooks/useDiscoverNavigation";
import { ArrowRight, Music, Star } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import AddActionButton from "../../../components/AddActionButton";
import { navigateToReleaseGroup } from "../../../utils/searchNavigation";
import PillToggle from "../../../components/PillToggle";
import { matchesReleaseGroupTab } from "../releaseFilters";
import {
  getReleaseGroupCoverUrl,
  getReleaseMetric,
  getReleaseYear,
  readStudioReleasesOnly,
  writeStudioReleasesOnly,
} from "../utils";
import { getAlbumAddButtonLabel } from "../../../utils/albumAddAction";

const viewModes = [
  { value: "albums", label: "Albums" },
  { value: "singles", label: "Singles & EPs" },
  { value: "compilations", label: "Compilations" },
];

// A discography reads as a list. Side-scrolling cards hid most of a long one
// and made the years impossible to follow.
const LIST_LIMIT = 40;

const sortLatest = (items) =>
  [...items].sort((a, b) =>
    String(b["first-release-date"] || "").localeCompare(String(a["first-release-date"] || "")),
  );

const getVisibleReleases = (releaseGroups, viewMode, limit, studioOnly) =>
  sortLatest(
    releaseGroups.filter((releaseGroup) =>
      matchesReleaseGroupTab(releaseGroup, viewMode, studioOnly),
    ),
  ).slice(0, limit);

export function ArtistDetailsReleaseGroups({
  artist,
  loadingReleases,
  albumCovers,
  fulfilledCoverIds,
  artistCoverImage,
  getAlbumStatus,
  canAddAlbum,
  handleRequestAlbum,
  requestingAlbum,
  artistName,
  onVisibleCoverIdsChange,
  onViewAll,
}) {
  const navigate = useDiscoverNavigation();
  const [viewMode, setViewMode] = useState("albums");
  const [studioOnly, setStudioOnly] = useState(readStudioReleasesOnly);
  const releaseGridRef = useRef(null);
  const releaseGroups = useMemo(() => artist["release-groups"] || [], [artist]);
  const visibleReleaseGroups = useMemo(
    () => getVisibleReleases(releaseGroups, viewMode, LIST_LIMIT, studioOnly),
    [releaseGroups, studioOnly, viewMode],
  );

  const handleStudioOnlyChange = (next) => {
    setStudioOnly(next);
    writeStudioReleasesOnly(next);
  };

  useEffect(() => {
    onVisibleCoverIdsChange?.(visibleReleaseGroups.map((item) => item.id).filter(Boolean));
  }, [onVisibleCoverIdsChange, visibleReleaseGroups]);

  const coverOptions = (releaseGroup) => ({
    artistFallback: artistCoverImage,
    resolved: fulfilledCoverIds?.has(releaseGroup.id),
  });

  const openRelease = (releaseGroup) => {
    navigateToReleaseGroup(navigate, releaseGroup, {
      artistMbid: artist?.id,
      artistName: artistName || artist?.name || "",
      coverUrl: getReleaseGroupCoverUrl(releaseGroup, albumCovers, coverOptions(releaseGroup)),
    });
  };

  if (releaseGroups.length === 0 && !loadingReleases) return null;

  return (
    <section className="artist-section">
      <div className="artist-heading-row">
        <div className="artist-min-0">
          <div className="artist-controls-row">
            <h2 className="artist-section-title">Discography</h2>
            {loadingReleases && <DotLoader size="sm" label={null} />}
          </div>
          <div className="artist-release-page__filters">
            <div className="artist-tabs">
              {viewModes.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => setViewMode(mode.value)}
                  className={`artist-tab${viewMode === mode.value ? " is-active" : ""}`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {viewMode === "compilations" ? null : (
              <div className="artist-release-page__type-toggle">
                <span>Studio only</span>
                <PillToggle
                  checked={studioOnly}
                  onChange={(event) => handleStudioOnlyChange(event.target.checked)}
                  aria-label="Show studio releases only"
                />
              </div>
            )}
          </div>
        </div>
        <button type="button" onClick={onViewAll} className="artist-link-button">
          View All
          <ArrowRight className="artist-icon-sm" />
        </button>
      </div>

      <div ref={releaseGridRef} className="artist-release-list">
        {visibleReleaseGroups.map((releaseGroup) => {
          const status = getAlbumStatus(releaseGroup.id);
          const metric = getReleaseMetric(releaseGroup);
          const coverUrl = getReleaseGroupCoverUrl(
            releaseGroup,
            albumCovers,
            coverOptions(releaseGroup),
          );
          const owned = status?.status === "available" || status?.status === "added";
          return (
            <article
              key={releaseGroup.id}
              className="artist-release-row"
              onClick={() => openRelease(releaseGroup)}
            >
              <div className="artist-release-row__cover">
                {coverUrl ? (
                  <img src={coverUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <div className="artist-release-row__placeholder">
                    <Music className="artist-icon-sm" />
                  </div>
                )}
              </div>
              <div className="artist-release-row__text">
                <h3 className="artist-release-row__title artist-truncate">{releaseGroup.title}</h3>
                <p className="artist-release-row__meta artist-truncate">
                  {[getReleaseYear(releaseGroup), releaseGroup["primary-type"]]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {metric.label ? (
                <p className="artist-release-row__metric">
                  <Star className="artist-star-icon" />
                  {metric.label}
                </p>
              ) : <span />}
              <div className="artist-release-row__action" onClick={(event) => event.stopPropagation()}>
                {owned ? (
                  <span className="artist-release-row__status" title="In the library">
                    <SearchLibraryCheck size="discover" />
                    <span className="sr-only">In the library</span>
                  </span>
                ) : canAddAlbum ? (
                  <AddActionButton
                    onClick={(event) => {
                      event.stopPropagation();
                      handleRequestAlbum(releaseGroup.id, releaseGroup.title);
                    }}
                    isLoading={requestingAlbum === releaseGroup.id}
                    disabled={requestingAlbum === releaseGroup.id}
                    label={getAlbumAddButtonLabel({ status: status?.status })}
                  />
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
