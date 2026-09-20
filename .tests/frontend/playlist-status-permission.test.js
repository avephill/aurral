import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Someone without the accessFlow permission has no Psalter-generated flow, but
// they do have playlists of their own in Navidrome. Letting the refusal from
// /playlists/status escape meant the "Add to playlist" menu showed
// "Permission required: accessFlow" instead of their own lists.
test("a refused flow status still lists the Navidrome playlists", () => {
  const source = readFileSync(
    new URL("../../frontend/src/utils/api/endpoints/playlists.js", import.meta.url),
    "utf8",
  );
  const fetcher = source.slice(
    source.indexOf("const fetchPlaylistStatus"),
    source.indexOf("export const getFlowStatus"),
  );
  assert.match(fetcher, /try \{\s*status = await getData\("\/playlists\/status"/);
  // A cancelled request, and any failure when Navidrome is not the store, are
  // still real failures.
  assert.match(fetcher, /if \(isCanceled\(error\) \|\| !isNavidromePlaylistStore\(\)\) throw error;/);
  assert.match(fetcher, /getNavidromePlaylists/);
});
