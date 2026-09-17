// Which build is waiting? The page cannot tell from the service worker: the
// waiting worker has the same URL as the running one. The server, though, is
// already serving the new build, so its reported version names the update.
export const UPDATE_DISMISS_KEY = "aurral.dismissed-update";

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

// Turning the offer down should settle the matter until there is something
// newer, rather than returning on every page load. `waitingVersion` is null
// while the server has not answered yet.
export const shouldOfferUpdate = ({ needRefresh, waitingVersion, dismissedVersion }) => {
  if (!needRefresh) return false;
  if (!dismissedVersion) return true;
  if (waitingVersion === null || waitingVersion === undefined) return false;
  if (!waitingVersion) return true;
  return waitingVersion !== dismissedVersion;
};
