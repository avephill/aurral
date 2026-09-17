import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { checkHealth } from "../utils/api/endpoints/auth.js";
import {
  readDismissedUpdate,
  rememberDismissedUpdate,
  shouldOfferUpdate,
} from "../utils/appUpdate.js";

function ReloadPrompt() {
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

  const close = () => {
    rememberDismissedUpdate(globalThis.localStorage, waitingVersion);
    setDismissedVersion(waitingVersion);
    setNeedRefresh(false);
  };

  if (!shouldOfferUpdate({ needRefresh, waitingVersion, dismissedVersion })) {
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
            onClick={() => updateServiceWorker(true)}
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
