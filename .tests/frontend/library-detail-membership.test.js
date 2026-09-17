import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// An album page reached by its id shows what the server holds, which is not the
// same as what this person holds. It has to say which, and offer the way in.

const page = readFileSync(
  new URL("../../frontend/src/pages/LibraryPage.jsx", import.meta.url),
  "utf8",
);
const hook = readFileSync(
  new URL("../../frontend/src/hooks/useUserLibrary.js", import.meta.url),
  "utf8",
);

test("the detail pages ask whether this person holds the artist", () => {
  assert.match(page, /const personalLibrary = useUserLibrary\(detailArtistMbid/);
  assert.match(page, /const detailArtist = libraryAlbum \? getArtistForAlbum\(libraryAlbum\) : libraryArtist;/);
});

test("an album outside your library offers a way in, on both detail pages", () => {
  assert.equal(page.match(/Add to my library/g)?.length, 2, "album page and artist page");
  assert.equal(page.match(/In your library/g)?.length, 2);
});

test("the offer explains that the artist comes with it", () => {
  assert.match(page, /Adds \$\{[^}]+\} and their records on the server to your library/);
});

test("adding says what happened, without the hook shouting for everyone else", () => {
  assert.match(hook, /export function useUserLibrary\(mbid, \{ onAdded \} = \{\}\)/);
  assert.match(hook, /onAdded\?\.\(\)/);
  assert.match(page, /Their records on the server are yours now\./);
});
