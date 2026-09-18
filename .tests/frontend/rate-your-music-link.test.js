import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isRateYourMusicUrl,
  rateYourMusicLink,
  rateYourMusicSearchUrl,
} from "../../frontend/src/utils/rateYourMusic.js";

test("a RateYourMusic URL is recognised on any of its hosts", () => {
  assert.equal(isRateYourMusicUrl("https://rateyourmusic.com/artist/tom-waits"), true);
  assert.equal(isRateYourMusicUrl("https://www.rateyourmusic.com/artist/tom-waits"), true);
  assert.equal(isRateYourMusicUrl("https://rateyourmusic.com.example.net/artist/x"), false);
  assert.equal(isRateYourMusicUrl("https://musicbrainz.org/artist/abc"), false);
  assert.equal(isRateYourMusicUrl("not a url"), false);
});

test("the real page wins over a search when MusicBrainz knows it", () => {
  const link = rateYourMusicLink({
    name: "Tom Waits",
    hrefs: ["https://www.discogs.com/artist/1", "https://rateyourmusic.com/artist/tom-waits"],
  });
  assert.deepEqual(link, { href: "https://rateyourmusic.com/artist/tom-waits", exact: true });
});

test("without a known page it searches by name rather than guessing a slug", () => {
  const link = rateYourMusicLink({ name: "Tom Waits" });
  assert.equal(link.exact, false);
  assert.equal(link.href, rateYourMusicSearchUrl("Tom Waits"));
  assert.match(link.href, /searchterm=Tom%20Waits/);
  assert.match(link.href, /searchtype=a/);
});

test("a name that needs escaping stays a single parameter", () => {
  const link = rateYourMusicLink({ name: "Godspeed You! Black Emperor" });
  const url = new URL(link.href);
  assert.equal(url.searchParams.get("searchterm"), "Godspeed You! Black Emperor");
});

test("no name and no relation means no link at all", () => {
  assert.equal(rateYourMusicLink({ name: "   " }), null);
  assert.equal(rateYourMusicLink(), null);
});

test("the artist page offers the link beside its other databases", () => {
  const source = readFileSync(
    new URL("../../frontend/src/pages/ArtistDetails/components/ArtistDetailsAbout.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /rateYourMusicLink\(/);
  assert.match(source, /label: "RateYourMusic"/);
  // It reads the relations it already gathered, so a known page is not
  // listed twice - once promoted and once as a bare hostname.
  assert.match(source, /hrefs: relationLinks\.map/);
  assert.equal(source.includes("buildRelationLinks(artist).filter"), false);
});
