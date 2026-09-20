import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Both menus close when the page scrolls under them, because the panel is
// positioned against a rectangle that has moved. The listener is a capturing
// one, so it also hears a submenu scrolling its own list of playlists - and
// closing on that made every playlist past the seventh unreachable.
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a menu does not close when something inside it scrolls", () => {
  const library = source("../../frontend/src/components/LibraryItemMenu.jsx");
  const closeOnScroll = library.slice(
    library.indexOf("const closeOnScroll"),
    library.indexOf("document.addEventListener(\"pointerdown\""),
  );
  assert.match(closeOnScroll, /menuRef\.current\?\.contains\(event\.target\)/);
  assert.match(closeOnScroll, /return;/);
  assert.match(library, /window\.addEventListener\("scroll", closeOnScroll, true\)/);
  assert.match(library, /window\.removeEventListener\("scroll", closeOnScroll, true\)/);
  // The resize listener keeps closing outright: a resize moves everything.
  assert.match(library, /window\.addEventListener\("resize", closeOnViewportChange\)/);

  const track = source("../../frontend/src/pages/ArtistDetails/components/TrackPlaylistMenu.jsx");
  const handleScroll = track.slice(
    track.indexOf("const handleScroll"),
    track.indexOf("document.addEventListener(\"pointerdown\""),
  );
  assert.match(handleScroll, /menuRef\.current\?\.contains\(event\.target\)/);
  assert.match(track, /window\.addEventListener\("scroll", handleScroll, true\)/);
  assert.match(track, /window\.removeEventListener\("scroll", handleScroll, true\)/);
});
