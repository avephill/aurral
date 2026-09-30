// What the search box searches, from where someone is. Library pages search
// the library - what can be played now - and Discover searches everything,
// including music to ask for. iTunes did the same: the box searched whichever
// source was showing. Settings has its own search.

const DISCOVER = /^\/(discover|search|artist|shows)(\/|$)/;

export function searchScopeFor(pathname = "") {
  if (pathname.startsWith("/settings")) return "settings";
  if (DISCOVER.test(pathname)) return "discover";
  return "library";
}

// Where Enter goes with a query, for each scope.
export function searchPathFor(scope, query) {
  const q = encodeURIComponent(String(query || "").trim());
  return scope === "library" ? `/library/search?q=${q}` : `/search?q=${q}`;
}
