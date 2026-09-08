import { useSyncExternalStore } from "react";
import { getThemeSettings, subscribeToThemeChanges } from "../utils/theme.js";

const readThemeId = () => getThemeSettings().themeId;

// The id of the selected theme, for the few places where a theme changes
// which existing rows are shown rather than only how they look.
export function useThemeId() {
  return useSyncExternalStore(subscribeToThemeChanges, readThemeId, readThemeId);
}
