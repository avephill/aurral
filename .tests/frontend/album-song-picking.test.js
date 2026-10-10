import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Choosing several of an album's songs and adding them to a playlist at once.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../../frontend/src/pages/LibraryPage.jsx");
const menu = read("../../frontend/src/pages/ArtistDetails/components/TrackPlaylistMenu.jsx");

test("the album menu starts choosing, with every playable song ticked", () => {
  assert.match(page, /label: "Add songs to a playlist\.\.\."/);
  assert.match(page, /label: "Add songs to a playlist\.\.\.",[\s\S]{0,80}startPicking\(libraryAlbum, albumTracks, "playlist"\)/);
  assert.match(
    page,
    /setPicking\(\{\s*albumId: album\.id,\s*purpose,\s*ids: new Set\(albumTracks\.filter\(\(track\) => firstAvailableFile\(track\)\)/,
  );
});

test("a song that is not on the server cannot be ticked", () => {
  assert.match(page, /className="native-library-track__pick"[\s\S]{0,120}disabled=\{!file\}/);
});

test("songs already in the playlist are not added twice", () => {
  assert.match(page, /addSharedPlaylistTracks\(target\?\.playlistId, \{ tracks: payloads, skipExisting: true \}\)/);
  assert.match(page, /already in it/);
});

test("the playlist menu opens upwards when there is no room below", () => {
  assert.match(menu, /\{ bottom: window\.innerHeight - rect\.top \+ 8, left \}/);
});

// The same choosing, for tags.

const tagsModal = read("../../frontend/src/components/TagsModal.jsx");

test("the album menu can start choosing songs to tag", () => {
  assert.match(page, /label: "Tag songs\.\.\.",[\s\S]{0,80}startPicking\(libraryAlbum, albumTracks, "tags"\)/);
  assert.match(page, /forTags \? \(/);
  assert.match(page, /kind: "tracks",\s*ids: chosen\.map\(\(track\) => track\.id\)/);
});

test("several songs get each tag added, and keep what they had", () => {
  assert.match(tagsModal, /for \(const tag of wanted\) await applyTag\(\{ trackIds: subject\.ids, tag \}\)/);
  assert.match(tagsModal, /Tags they have already are kept\./);
  // Nothing is read for several songs: there is no one set of tags to show.
  assert.match(tagsModal, /isMany\s*\? Promise\.resolve\(\{ tags: \[\] \}\)/);
});

// Typing a tag and pressing Save is how most people tag something. A word
// left in the box used to be dropped for one song or one record - only the
// several-songs form kept it - and the dialog closed as if it had worked.

test("a tag typed but not entered is saved, whatever is being tagged", () => {
  const save = tagsModal.slice(tagsModal.indexOf("const save = async"), tagsModal.indexOf("const taken = new Set("));
  assert.match(save, /const typed = draft\.trim\(\)\.toLowerCase\(\);\s*const wanted = typed && !tags\.includes\(typed\) \? \[\.\.\.tags, typed\] : tags;/);
  assert.match(save, /applyTag\(\{ trackIds: subject\.ids, tag \}\)/);
  assert.match(save, /setTagsForAlbum\(subject\.id, wanted\)/);
  assert.match(save, /setTagsForTrack\(subject\.id, \[\.\.\.wanted, /);
  assert.doesNotMatch(save, /setTagsFor(Album|Track)\(subject\.id, (\[\.\.\.)?tags\b/, "not the chips alone");
});

test("a saved tag reaches the tag lists straight away", () => {
  assert.match(tagsModal, /queryClient\.invalidateQueries\(\{ queryKey: \["tags"\] \}\)/);
  for (const reader of ["../../frontend/src/components/TagFilter.jsx", "../../frontend/src/pages/TagsPage.jsx"]) {
    assert.match(read(reader), /queryKey: \["tags"\]/, `${reader} reads that list`);
  }
});

// What a shelf card and an album page say about what is here.

test("cards carry no counts; the Recently added shelves say when", () => {
  const page = read("../../frontend/src/pages/LibraryPage.jsx");
  assert.doesNotMatch(page, /" available"/, 'no "1/4 available" on a card');
  assert.doesNotMatch(page, /artistAlbumCount/, "nor an album count under an artist");
  assert.match(page, /homeAlbums\.map\(\(album\) => renderAlbumCard\(album, \{ showAdded: true \}\)\)/);
  assert.match(page, /homeRecentArtists\.map\(\(artist\) => renderArtistCard\(artist, \{ showAdded: true \}\)\)/);
  assert.match(page, /return "Added " \+ date\.toLocaleDateString/);
  const home = read("../../backend/services/libraryHomeService.js");
  assert.match(home, /recentAlbums: withAddedDates\(getCanonicalLibraryPage\(/);
});

test("an album page says how much of it is missing, and a missing track's real length", () => {
  const page = read("../../frontend/src/pages/LibraryPage.jsx");
  assert.match(page, /\{availability\.total - availability\.available\} of \{availability\.total\} tracks missing/);
  // Lidarr's length is milliseconds; it used to be multiplied by 1000.
  assert.match(page, /const lidarrDurationMs = Number\(track\?\.metadata\?\.duration\);\s*return lidarrDurationMs > 0 \? lidarrDurationMs : null;/);
  assert.doesNotMatch(page, /metadataDurationSeconds \* 1000/);
  const css = read("../../frontend/src/index.css");
  assert.match(css, /\.native-library-track\.is-missing \.native-library-track__cover \{\s*opacity: 0\.45;/);
});

// An artist asked for whose music has not arrived is wanted, not had: saying
// "In My Library" sent someone looking for Ola Belle Reed on a page that only
// shows music the server holds.

test("an artist with nothing on the server is not called in your library", () => {
  const page = read("../../frontend/src/pages/ArtistDetails/ArtistDetailsPage.jsx");
  const bar = read("../../frontend/src/pages/ArtistDetails/components/ArtistDetailsActionBar.jsx");
  assert.match(page, /existsInLibrary && !loadingLibrary && libraryArtist && !anAlbumHasFiles/, "only once Lidarr has answered");
  assert.match(page, /nothingOnServer=\{nothingOnServer\}/);
  assert.match(bar, /label: nothingOnServer \? "Wanted – nothing here yet" : "In My Library"/);
});
