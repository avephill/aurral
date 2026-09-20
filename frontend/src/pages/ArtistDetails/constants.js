export const primaryReleaseTypes = ["Album", "EP", "Single"];
export const secondaryReleaseTypes = [
  "Live",
  "Remix",
  "Compilation",
  "Demo",
  "Broadcast",
  "Soundtrack",
  "Spokenword",
  "Other",
];
export const allReleaseTypes = [...primaryReleaseTypes, ...secondaryReleaseTypes];

export const emptyArtistShape = {
  disambiguation: "",
  "type-id": null,
  type: null,
  country: null,
  "life-span": { begin: null, end: null, ended: false },
  tags: [],
  genres: [],
  relations: [],
  "appears-on-release-groups": [],
  "release-group-count": 0,
  "release-count": 0,
};

export const RELEASE_LIST_VIEW_MODE_KEY = "aurralReleaseListViewMode";
// Remembered across artists: someone who wants records rather than bootlegs
// wants that on the next artist too.
export const RELEASE_STUDIO_ONLY_KEY = "psalterStudioReleasesOnly";
export const ARTIST_DETAILS_APPEARS_ON_LIMIT = 24;
