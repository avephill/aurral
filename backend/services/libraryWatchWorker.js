// Holds the library's recursive file watches on a worker thread.
//
// On Linux, Node registers a recursive fs.watch by walking every directory
// synchronously on the thread that asks. Against this library's storage that
// walk took over five minutes, and on the main thread nothing else ran for all
// of it: the server stopped answering after every restart and every settings
// save. Here the walk only occupies this worker.
//
// Changes are passed back raw. Filtering and debouncing stay on the main thread,
// next to the scan scheduling they feed, so this file needs nothing but fs.
import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const watchers = [];
const startedAt = Date.now();

const report = (root, error) => {
  parentPort.postMessage({ type: "error", root, message: error?.message || String(error) });
};

for (const root of workerData?.roots || []) {
  if (!fs.existsSync(root)) continue;
  try {
    const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
      parentPort.postMessage({
        type: "change",
        root,
        filename: filename == null ? null : String(filename),
      });
    });
    watcher.on("error", (error) => report(root, error));
    watchers.push(watcher);
  } catch (error) {
    report(root, error);
  }
}

parentPort.postMessage({ type: "ready", roots: watchers.length, elapsedMs: Date.now() - startedAt });
