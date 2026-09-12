// The theme lives in localStorage so it can be applied before React mounts and
// keeps working when signed out. That storage is per browser, so this module
// mirrors it onto the signed-in account: the server copy wins at sign-in, and
// every later change is pushed back up. The result is one theme per person
// rather than one per browser.
import { getMyTheme, updateMyTheme } from "./api/endpoints/auth.js";
import {
  applyStoredThemeSelection,
  getThemeSettings,
  hasStoredThemeSelection,
  subscribeToThemeChanges,
} from "./theme.js";

let unsubscribe = null;
let syncedUserId = null;
// The selection we last saw from, or sent to, the server. Used to avoid
// echoing the server's own value straight back at it.
let lastSyncedSelection = null;

function sameSelection(a, b) {
  return !!a && !!b && a.themeId === b.themeId && a.appearance === b.appearance;
}

function pushThemeToServer() {
  const selection = getThemeSettings();
  if (sameSelection(selection, lastSyncedSelection)) return;
  lastSyncedSelection = selection;
  // Best effort: a failed save must never break theme switching in the UI.
  updateMyTheme(selection).catch(() => {
    lastSyncedSelection = null;
  });
}

export function stopThemeSync() {
  unsubscribe?.();
  unsubscribe = null;
  syncedUserId = null;
  lastSyncedSelection = null;
}

/**
 * Mirror the theme for the signed-in user. Pass a falsy id when signed out.
 * Safe to call on every render of the auth provider; it only acts when the
 * signed-in user changes.
 */
export function startThemeSync(userId) {
  if (!userId) {
    stopThemeSync();
    return;
  }
  if (syncedUserId === userId) return;
  stopThemeSync();
  syncedUserId = userId;

  getMyTheme()
    .then((data) => {
      // Another sign-in may have landed while the request was in flight.
      if (syncedUserId !== userId) return;
      const stored = data?.theme;
      if (stored?.themeId) {
        lastSyncedSelection = { themeId: stored.themeId, appearance: stored.appearance };
        applyStoredThemeSelection(stored.themeId, stored.appearance);
      } else if (hasStoredThemeSelection()) {
        // Nothing stored for this account yet, and this browser holds a theme
        // someone chose here: keep it and claim it for the account.
        pushThemeToServer();
      }
      // Otherwise leave the account empty. A browser that has simply never had
      // a theme picked in it must not write its default over the choice this
      // person made somewhere else and has not signed in with yet.
    })
    .catch(() => {})
    .finally(() => {
      if (syncedUserId !== userId) return;
      unsubscribe = subscribeToThemeChanges(pushThemeToServer);
    });
}
