import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Two pages fill the window and scroll inside themselves. Only the shell
// knows how much height is left under the topbar and over the player, so it
// hands it down through a class on the main element - the same way the
// settings page asks for its own scrolling - rather than through a selector
// that has to guess at the page from outside.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const layout = read("../../frontend/src/components/Layout.jsx");
const shell = read("../../frontend/src/index.css");
const playlists = read("../../frontend/src/pages/navidromePlaylists.css");
const tags = read("../../frontend/src/pages/tags.css");

test("the shell marks the pages that fill the window", () => {
  assert.match(layout, /"\/library\/playlists", "\/library\/tags"/);
  assert.match(layout, /app-main--fills/);
  assert.match(shell, /\.app-main--fills \.app-main__content \{\s*height: 100%;/);
});

test("neither page asks the shell for height from the outside", () => {
  // A page cannot style its own ancestors reliably, and when that failed the
  // whole page scrolled instead of the boxes inside it.
  assert.doesNotMatch(playlists, /:has\(/);
  assert.doesNotMatch(tags, /:has\(/);
});

test("each scrolling box has a ceiling as well as a height", () => {
  // If the height ever stops arriving, a box with only `height: 100%` grows
  // to its content and the page scrolls again. The ceiling keeps the scroll
  // inside the box either way.
  for (const [name, css] of [["playlists", playlists], ["tags", tags]]) {
    const boxes = [...css.matchAll(/height: 100%;\s*max-height: ([^;]+);/g)].map((match) => match[1]);
    assert.ok(boxes.length > 0, `${name} has a box that fills and scrolls`);
    for (const value of boxes) {
      assert.match(value, /calc\(100dvh - [\d.]+rem\)/, `${name}: a real ceiling, not none`);
    }
  }
});

test("the boxes scroll, not the page", () => {
  assert.match(playlists, /\.nd-playlists \{\s*display: flex;\s*height: 100%;/);
  assert.match(playlists, /overflow-y: auto;\s*overscroll-behavior: contain;/);
  assert.match(tags, /\.tags-page \{\s*display: flex;\s*height: 100%;/);
});
