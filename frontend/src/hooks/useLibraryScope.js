import { useCallback, useEffect, useState } from "react";

// Whether someone is looking at their own library or the whole server. One
// setting, kept per person on this device, that the Library page, the search
// box and library search results all follow: changing it in one changes it in
// the others at once.
//
// It starts on their own library: every personal library here is a symlinked
// subset of the shared one, and Navidrome already scopes what they can play.
// "Whole server" is a click away for anyone who wants it.

const SCOPE_KEY = "psalter.libraryScope";
const CHANGED = "psalter:library-scope";

export const readLibraryScope = (userId) => {
  try {
    return window.localStorage.getItem(`${SCOPE_KEY}:${userId}`) === "server" ? "server" : "mine";
  } catch {
    return "mine";
  }
};

export const writeLibraryScope = (userId, scope) => {
  try {
    window.localStorage.setItem(`${SCOPE_KEY}:${userId}`, scope);
  } catch {
    // A browser that refuses storage still gets the default each visit.
  }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { userId, scope } }));
};

export function useLibraryScope(userId) {
  const key = userId ?? "anon";
  const [scope, setScope] = useState(() => readLibraryScope(key));

  useEffect(() => {
    setScope(readLibraryScope(key));
    const follow = (event) => {
      if (event.detail?.userId === key) setScope(event.detail.scope);
    };
    window.addEventListener(CHANGED, follow);
    return () => window.removeEventListener(CHANGED, follow);
  }, [key]);

  const choose = useCallback(
    (next) => {
      setScope(next);
      writeLibraryScope(key, next);
    },
    [key],
  );

  return [scope, choose];
}
