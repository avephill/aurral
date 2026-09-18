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
});

test("the shell itself cannot scroll on those pages", () => {
  // The guarantee behind the layout: whatever the page does with the space,
  // the thing that used to scroll as a whole is not allowed to.
  assert.match(shell, /\.app-main--fills \{[^}]*overflow: hidden;/);
});

test("the height is handed down as flex space, not as a percentage", () => {
  // A percentage has to resolve against every ancestor in turn and silently
  // becomes "as tall as the content" if one of them is not definite. That is
  // how this page ended up scrolling as a whole, twice.
  assert.match(shell, /\.app-main--fills \.app-main__content \{[^}]*flex: 1;/);
  assert.match(shell, /\.app-main--fills \.app-main__content \{[^}]*min-height: 0;/);
  assert.doesNotMatch(shell, /\.app-main--fills \.app-main__content \{[^}]*height: 100%;/);
  for (const [name, css] of [["playlists", playlists], ["tags", tags]]) {
    const page = css.match(name === "playlists" ? /\.nd-playlists \{[^}]*\}/g : /\.tags-page \{[^}]*\}/g);
    const filling = page.find((rule) => rule.includes("flex-direction: column"));
    assert.match(filling, /flex: 1;/, `${name} takes the space left over`);
    assert.doesNotMatch(filling, /height: 100%/, `${name} does not ask for a share of a height`);
  }
});

test("neither page asks the shell for height from the outside", () => {
  // A page cannot style its own ancestors reliably, and when that failed the
  // whole page scrolled instead of the boxes inside it.
  assert.doesNotMatch(playlists, /:has\(/);
  assert.doesNotMatch(tags, /:has\(/);
});

test("the boxes inside take the whole height, with no ceiling of their own", () => {
  // Both pages had a viewport calculation capping their boxes. Every one was
  // a guess at how much sits above them, and each guess left the page a
  // little too tall.
  for (const [name, css] of [["playlists", playlists], ["tags", tags]]) {
    const from = css.indexOf("@media (min-width: 768px)");
    const next = css.indexOf("@media", from + 1);
    const desktop = css.slice(from, next === -1 ? undefined : next);
    const capped = [...desktop.matchAll(/max-height: (?!none)([^;]+);/g)].map((match) => match[1]);
    assert.deepEqual(capped, [], `${name} no longer guesses at the height above its boxes`);
  }
});

test("the boxes are what scroll", () => {
  assert.match(playlists, /overflow-y: auto;\s*overscroll-behavior: contain;/);
  assert.match(tags, /\.tags-page__panel-body \{[^}]*overflow-y: auto;/);
});
