import createHonkerWorker from "./honkerWorkerFactory.js";
import { isDiscoveryRefreshEnabled } from "../config/featureFlags.js";
import { getDiscoveryRefreshQueue } from "./honkerDb.js";
import {
  clearDiscoveryUpdateProgress,
  getDiscoveryCache,
  recordDiscoveryUpdateProgress,
  updateDiscoveryCache,
} from "./discovery/index.js";
import {
  discoveryNeedsRefresh,
  isDiscoveryRefreshConfigured,
  markDiscoveryRefreshDequeued,
  scheduleNextDiscoveryRefresh,
} from "./discovery/refreshScheduler.js";
async function runDiscoveryRefresh(payload) {
  if (!isDiscoveryRefreshEnabled()) {
    getDiscoveryCache().isUpdating = false;
    clearDiscoveryUpdateProgress();
    return;
  }
  if (!(await isDiscoveryRefreshConfigured())) {
    getDiscoveryCache().isUpdating = false;
    clearDiscoveryUpdateProgress();
    return;
  }

  if (payload?.scheduleOnly === true && !discoveryNeedsRefresh()) {
    return;
  }

  const cache = getDiscoveryCache();
  if (!cache.isUpdating) {
    cache.isUpdating = true;
    recordDiscoveryUpdateProgress("starting", "Starting discovery refresh", 2, {
      reason: payload?.reason || "scheduled",
    });
  }

  await updateDiscoveryCache();
}

const {  start: startDiscoveryRefreshWorker,
  stop: stopDiscoveryRefreshWorker,
  isRunning: isDiscoveryRefreshWorkerRunning,
} = createHonkerWorker({
  name: "discovery-refresh",
  getQueue: getDiscoveryRefreshQueue,
  processJob: runDiscoveryRefresh,
  idlePollS: 5,
  retryDelayS: 300,
  onJobDequeue: markDiscoveryRefreshDequeued,
  onJobSuccess: scheduleNextDiscoveryRefresh,
  onJobError: () => {
    getDiscoveryCache().isUpdating = false;
    clearDiscoveryUpdateProgress();
  },
});

export {
  startDiscoveryRefreshWorker,
  stopDiscoveryRefreshWorker,
  isDiscoveryRefreshWorkerRunning,
};
