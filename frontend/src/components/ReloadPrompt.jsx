import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { useAuth } from "../contexts/AuthContext";
import { checkHealth } from "../utils/api/endpoints/auth.js";
import {
  isPageAlreadyCurrent,
  readDismissedUpdate,
  rememberDismissedUpdate,
  shouldOfferUpdate,
} from "../utils/appUpdate.js";

const runningVersion = import.meta.env.VITE_APP_VERSION || "";

function ReloadPrompt() {
  const { bootstrap } = useAuth();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered() {},
    onRegisterError() {},
  });
  const [waitingVersion, setWaitingVersion] = useState(null);
  const [dismissedVersion, setDismissedVersion] = useState(() =>
    readDismissedUpdate(globalThis.localStorage),
  );

  useEffect(() => {
    if (!needRefresh) return undefined;
    let cancelled = false;
    checkHealth({ force: true })
      .then((health) => {
        if (!cancelled) setWaitingVersion(String(health?.appVersion || ""));
      })
      .catch(() => {
        if (!cancelled) setWaitingVersion("");
      });
    return () => {
      cancelled = true;
    };
  }, [needRefresh]);

  // Nothing to tell anyone: the page is already the build the server has, so
  // say nothing and leave the waiting worker alone.
  //
  // Emphatically do not hand over to it to tidy up. The registration installs
  // a listener that reloads the page the moment any new worker takes control,
  // and asking it not to reload does not opt out of that - the argument is
  // ignored, and all the call does is send skip-waiting. Handing over here is
  // what reloaded the page a second time a couple of seconds after the first.
  useEffect(() => {
    if (!needRefresh) return;
    if (!isPageAlreadyCurrent({ waitingVersion, runningVersion })) return;
    setNeedRefresh(false);
  }, [needRefresh, setNeedRefresh, waitingVersion]);

  const close = () => {
    rememberDismissedUpdate(globalThis.localStorage, waitingVersion);
    setDismissedVersion(waitingVersion);
    setNeedRefresh(false);
  };

  // Taking the update is also an answer about this build: if the new worker
  // fails to take over, asking again about the same one helps nobody.
  const reload = () => {
    rememberDismissedUpdate(globalThis.localStorage, waitingVersion);
    updateServiceWorker(true);
  };

  // Someone being shown around the app is in the middle of something.
  if (bootstrap?.walkthroughPending === true) return null;

  if (!shouldOfferUpdate({ needRefresh, waitingVersion, dismissedVersion, runningVersion })) {
    return null;
  }

  return (
    <div className="reload-prompt">
      <div className="reload-prompt__content">
        <p className="reload-prompt__title">Psalter update ready</p>
        <p className="reload-prompt__text">
          This is the app itself, not your music — new albums and playlists appear on their own.
          Reloading restarts Psalter and stops whatever is playing.
        </p>
        <div className="reload-prompt__actions">
          <button
            type="button"
            className="btn btn-primary btn-sm btn--grow"
            onClick={reload}
          >
            Reload
          </button>
          <button type="button" className="btn btn-secondary btn-sm btn--grow" onClick={close}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

export default ReloadPrompt;
