const hasReleaseGroupType = (releaseGroup, type) =>
  releaseGroup?.["primary-type"] === type ||
  (releaseGroup?.["secondary-types"] || []).includes(type);

// A studio release is one MusicBrainz gives no secondary type: not a live
// recording, a demo, a remix, a compilation or a soundtrack. The distinction
// matters because a heavily documented band buries its records under its
// concerts - Modest Mouse has a dozen albums and fifty taped shows, and the
// shows sort in among them.
export const isStudioRelease = (releaseGroup) =>
  (releaseGroup?.["secondary-types"] || []).length === 0;

export const matchesReleaseGroupTab = (releaseGroup, tab, studioOnly = false) => {
  const isCompilation = hasReleaseGroupType(releaseGroup, "Compilation");
  // The compilations tab is defined by a secondary type, so studio-only would
  // empty it rather than filter it.
  if (tab === "compilations") return isCompilation;
  if (studioOnly && !isStudioRelease(releaseGroup)) return false;
  if (tab === "all") return true;
  if (isCompilation) return false;
  if (tab === "singles") {
    return ["EP", "Single"].includes(releaseGroup?.["primary-type"]);
  }
  return releaseGroup?.["primary-type"] === "Album";
};

export const matchesReleaseGroupSearch = (releaseGroup, searchTerm) =>
  String(releaseGroup?.title || "")
    .toLowerCase()
    .includes(String(searchTerm || "").trim().toLowerCase());
