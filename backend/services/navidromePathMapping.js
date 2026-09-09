/**
 * Pure helpers for lining up Aurral's file paths with Navidrome's.
 *
 * The two see the same music tree under different mount points, and Navidrome
 * may report a song path either relative to its library root or absolute,
 * depending on version. None of that has to be configured: the two paths for
 * one file share a suffix, and everything before the shared part is the
 * respective root. Once the roots are known for one file they hold for every
 * file in that library.
 */

const MIN_SHARED_SEGMENTS = 2;

export function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function segments(value) {
  return normalizePath(value).split("/").filter((segment) => segment.length > 0);
}

/**
 * How many trailing path segments two paths have in common.
 */
export function sharedSuffixLength(first, second) {
  const a = segments(first);
  const b = segments(second);
  let count = 0;
  while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count]) {
    count += 1;
  }
  return count;
}

/**
 * Given Aurral's absolute path and Navidrome's path for the same file, work
 * out both roots and the library-relative path. Needs at least the album and
 * file segments to agree; a bare filename match could be a coincidence.
 *
 * Returns null when the paths do not describe the same file.
 */
export function deriveRoots(aurralPath, navidromePath) {
  const a = segments(aurralPath);
  const b = segments(navidromePath);
  const shared = sharedSuffixLength(aurralPath, navidromePath);
  if (shared < MIN_SHARED_SEGMENTS) return null;
  // Navidrome's path relative to its library root is at most the whole
  // reported path. When it is relative, everything in it is shared.
  const relativeSegments = b.length <= shared ? b : b.slice(b.length - shared);
  const relative = relativeSegments.join("/");
  const aurralRootSegments = a.slice(0, a.length - relativeSegments.length);
  if (!aurralRootSegments.length) return null;
  const aurralRoot = `${normalizePath(aurralPath).startsWith("/") ? "/" : ""}${aurralRootSegments.join("/")}`;
  const navidromeRootSegments = b.slice(0, b.length - relativeSegments.length);
  const navidromeRoot = navidromeRootSegments.length
    ? `${normalizePath(navidromePath).startsWith("/") ? "/" : ""}${navidromeRootSegments.join("/")}`
    : "";
  return { aurralRoot, navidromeRoot, relative };
}

/**
 * The part of an absolute path under a root, or null when it is not under it.
 */
export function relativeToRoot(absolutePath, root) {
  const path = normalizePath(absolutePath);
  const base = normalizePath(root);
  if (!base) return path.replace(/^\/+/, "");
  if (!path.startsWith(`${base}/`)) return null;
  return path.slice(base.length + 1);
}

/**
 * Strip Navidrome's root from a reported song path when the path is absolute;
 * relative paths pass through unchanged.
 */
export function navidromeRelativePath(songPath, navidromeRoot) {
  const path = normalizePath(songPath);
  const root = normalizePath(navidromeRoot);
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path.replace(/^\/+/, "");
}

export function joinRoot(root, relative) {
  const base = normalizePath(root);
  const rest = normalizePath(relative).replace(/^\/+/, "");
  return base ? `${base}/${rest}` : `/${rest}`;
}

/**
 * The trailing segments to look a file up by when the roots are still
 * unknown: album folder plus filename, which is specific enough to trust.
 */
export function lookupSuffix(path) {
  const parts = segments(path);
  return parts.slice(-MIN_SHARED_SEGMENTS).join("/");
}
