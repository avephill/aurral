// A waiting service worker is not the same thing as a stale page.
//
// Navigations here come from the network, so a reload fetches the new HTML and
// its new assets and runs them at once, while the old worker is still the one
// registered. The browser then installs the new worker, it goes to waiting, and
// the app asks about an update the person already has - which is what they saw:
// the new page first, the notice a moment later.
//
// So the question is not "is a worker waiting" but "is the page older than what
// the server is serving". The running build is stamped in at build time and the
// server reports its own, and only when those differ has someone really got an
// old app on screen - a tab left open across a deploy.

export const UPDATE_DISMISS_KEY = "aurral.dismissed-update";

const normalize = (value) => String(value || "").trim().replace(/^v/, "");

export const readDismissedUpdate = (storage) => {
  try {
    return storage?.getItem(UPDATE_DISMISS_KEY) || "";
  } catch {
    return "";
  }
};

export const rememberDismissedUpdate = (storage, version) => {
  try {
    if (version) storage?.setItem(UPDATE_DISMISS_KEY, version);
  } catch {
    // A private window refuses to store, and then the prompt asks again. That
    // is the old behaviour, not a failure worth reporting.
  }
};

/** The page is current: let the waiting worker take over without a word. */
export const isPageAlreadyCurrent = ({ waitingVersion, runningVersion }) =>
  Boolean(waitingVersion) &&
  Boolean(runningVersion) &&
  normalize(waitingVersion) === normalize(runningVersion);

// `waitingVersion` is null while the server has not answered yet, and "" when
// it would not say.
export const shouldOfferUpdate = ({
  needRefresh,
  waitingVersion,
  dismissedVersion,
  runningVersion,
}) => {
  if (!needRefresh) return false;
  if (waitingVersion === null || waitingVersion === undefined) return false;
  if (isPageAlreadyCurrent({ waitingVersion, runningVersion })) return false;
  if (!dismissedVersion) return true;
  if (!waitingVersion) return true;
  return normalize(waitingVersion) !== normalize(dismissedVersion);
};
