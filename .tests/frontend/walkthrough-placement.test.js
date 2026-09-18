import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cardClearsTarget,
  placeWalkthroughCard,
} from "../../frontend/src/utils/walkthroughPlacement.js";

const CARD = { width: 416, height: 220 };
const DESKTOP = { width: 1440, height: 900 };

test("beside a sidebar entry, the card stands to its right", () => {
  const target = { top: 300, left: 16, width: 220, height: 40 };
  const at = placeWalkthroughCard({ target, card: CARD, viewport: DESKTOP });
  assert.ok(at.left > target.left + target.width, "clear of the sidebar");
  assert.ok(cardClearsTarget(at, target, CARD), "and not over it");
});

test("under the search box, which runs across the top", () => {
  const target = { top: 16, left: 400, width: 640, height: 48 };
  const at = placeWalkthroughCard({ target, card: CARD, viewport: DESKTOP });
  assert.ok(at.top >= target.top + target.height, "below the box");
  assert.ok(cardClearsTarget(at, target, CARD));
});

test("something against the right edge pushes the card to its left", () => {
  const target = { top: 200, left: 1200, width: 220, height: 60 };
  const at = placeWalkthroughCard({ target, card: CARD, viewport: DESKTOP });
  assert.ok(at.left + CARD.width <= target.left, "left of it");
  assert.ok(cardClearsTarget(at, target, CARD));
});

test("the card is kept on screen when its anchor sits near the bottom", () => {
  const target = { top: 860, left: 16, width: 220, height: 36 };
  const at = placeWalkthroughCard({ target, card: CARD, viewport: DESKTOP });
  assert.ok(at.top >= 0, "not off the top");
  assert.ok(at.top + CARD.height <= DESKTOP.height, "nor off the bottom");
  assert.ok(cardClearsTarget(at, target, CARD));
});

test("a step with nothing to point at leaves the card where the stylesheet put it", () => {
  assert.equal(placeWalkthroughCard({ target: null, card: CARD, viewport: DESKTOP }), null);
});

test("a target filling the screen leaves nowhere clear, so the card takes the roomier strip", () => {
  const target = { top: 0, left: 0, width: 1440, height: 700 };
  const at = placeWalkthroughCard({ target, card: CARD, viewport: DESKTOP });
  assert.ok(at.top > target.height / 2, "down in the free strip below, not over the middle of it");
  assert.ok(at.top + CARD.height <= DESKTOP.height, "still on screen");
});

const source = readFileSync(
  new URL("../../frontend/src/components/Walkthrough.jsx", import.meta.url),
  "utf8",
);

test("the tour says a library is a subset of the server's", () => {
  assert.match(source, /The server holds more music than your library does/);
});

test("it says an artist you hold keeps collecting their new records", () => {
  assert.match(source, /Once an artist is in your library, anything of theirs that reaches the server later joins it/);
});

test("the Discover step mentions what has just been added", () => {
  assert.match(source, /what has just been added to the server/);
});

test("it opens by saying what the app is for, without the sales pitch", () => {
  assert.match(source, /listen to your music, rate it, and add more of it/);
});

// The tour sends someone to Bulk migration before anything else: picking what
// of the server's music is theirs is what makes the rest of the app useful.

test("the tour starts people at bulk migration", () => {
  const source = readFileSync(
    new URL("../../frontend/src/components/Walkthrough.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /title: "Start here"/);
  assert.match(source, /path: "\/library\/mine"/);
  assert.match(source, /data-tour="bulk-migration"/);
  // It comes before the steps about finding and playing things.
  assert.ok(
    source.indexOf('title: "Start here"') < source.indexOf('title: "Finding something"'),
  );
});

test("the step is dropped where personal libraries are off", () => {
  const source = readFileSync(
    new URL("../../frontend/src/components/Walkthrough.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /needs: \(bootstrap\) => bootstrap\?\.userLibrariesEnabled === true/);
  // And the count reads off what is actually being shown, not the full list.
  assert.match(source, /\{step \+ 1\} of \{steps\.length\}/);
  assert.match(source, /STEPS\.filter\(\(entry\) => !entry\.needs \|\| entry\.needs\(bootstrap\)\)/);
});

test("the sidebar can be pointed at by name", () => {
  const sidebar = readFileSync(
    new URL("../../frontend/src/components/Sidebar.jsx", import.meta.url),
    "utf8",
  );
  const nav = readFileSync(
    new URL("../../frontend/src/navigation/libraryNavConfig.js", import.meta.url),
    "utf8",
  );
  assert.match(sidebar, /data-tour=\{entry\.tour \|\| undefined\}/);
  assert.match(nav, /tour: "bulk-migration"/);
});
