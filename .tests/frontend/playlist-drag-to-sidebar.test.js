import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Dragging a song from the list on the right onto a playlist on the left.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../../frontend/src/pages/NavidromePlaylistsPage.jsx");
const css = read("../../frontend/src/pages/navidromePlaylists.css");
const itunes = read("../../frontend/src/itunesTheme.css");

test("any song can be dragged, not only in a list you can reorder", () => {
  assert.match(page, /draggable=\{canReorder \|\| Boolean\(track\.navidromeId \|\| track\.trackId\)\}/);
});

test("only your own hand-kept playlists, other than this one, take a drop", () => {
  assert.match(page, /playlist\.owned && !playlist\.smart && String\(playlist\.id\) !== selectedId/);
});

test("a dropped song is found afresh, with its id to fall back on, and never added twice", () => {
  assert.match(page, /songId: track\.navidromeId,\s*\}\s*: \{ songId: track\.navidromeId \};/);
  assert.match(page, /tracks: \[song\], skipExisting: true/);
  assert.match(page, /is already in \$\{playlist\.name\}/);
});

test("the playlist under the song shows it will take it, in both themes", () => {
  assert.match(css, /\.nd-playlists__item\.is-drop-over \{/);
  assert.match(itunes, /\.nd-playlists__item\.is-drop-over \{/);
});
