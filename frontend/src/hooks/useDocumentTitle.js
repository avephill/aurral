import { useEffect } from "react";

const DEFAULT_TITLE = "Psalter";

export function useDocumentTitle(title) {
  useEffect(() => {
    const trimmed = title?.trim() || "";
    document.title = trimmed ? `${trimmed} - ${DEFAULT_TITLE}` : DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title]);
}
