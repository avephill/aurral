import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

const { createThreadedLibraryFileWatcher } = await import(
  "../../backend/services/libraryFileWatcher.js"
);

// Registering a recursive watch on Linux walks the whole tree on the calling
// thread; on the main thread that stopped the server answering for minutes
// after every restart. The watches now live on a worker thread.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeWorker() {
  const worker = new EventEmitter();
  worker.terminated = false;
  worker.unref = () => {};
  worker.terminate = async () => {
    worker.terminated = true;
  };
  return worker;
}

test("the threaded watcher debounces, ignores generated folders and reports its setup", async () => {
  const worker = fakeWorker();
  const root = process.cwd();
  let requestedRoots = null;
  let scheduled = 0;
  let changedRoots = [];
  let ready = null;
  const watcher = createThreadedLibraryFileWatcher({
    roots: [root],
    debounceMs: 5,
    workerFactory: (roots) => {
      requestedRoots = roots;
      return worker;
    },
    onChange: (roots) => {
      scheduled += 1;
      changedRoots = roots;
    },
    onReady: (message) => {
      ready = message;
    },
  });
  assert.deepEqual(requestedRoots, [root]);

  worker.emit("message", { type: "ready", roots: 1, elapsedMs: 309153 });
  assert.equal(ready.elapsedMs, 309153);

  worker.emit("message", { type: "change", root, filename: "Artist/Album/track.flac" });
  worker.emit("message", { type: "change", root, filename: "Artist/Album/track.flac" });
  await wait(15);
  assert.equal(scheduled, 1);
  assert.deepEqual(changedRoots, [root]);

  worker.emit("message", { type: "change", root, filename: "aurral-weekly-flow/flow/track.flac" });
  worker.emit("message", { type: "change", root, filename: "_staging/track.flac" });
  await wait(15);
  assert.equal(scheduled, 1);

  watcher.close();
  assert.equal(worker.terminated, true);
  worker.emit("message", { type: "change", root, filename: "Artist/Album/late.flac" });
  await wait(15);
  assert.equal(scheduled, 1, "a closed watcher must not schedule scans");
});

test("the watches run on a real worker thread and report file changes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psalter-watch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let resolveReady;
  const readySeen = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let resolveChange;
  const changeSeen = new Promise((resolve) => {
    resolveChange = resolve;
  });
  const errors = [];
  const watcher = createThreadedLibraryFileWatcher({
    roots: [root],
    debounceMs: 10,
    onReady: resolveReady,
    onChange: resolveChange,
    onError: (error) => errors.push(error),
  });
  t.after(() => watcher.close());

  const ready = await Promise.race([readySeen, wait(5000).then(() => null)]);
  assert.ok(ready, "the worker never reported that its watches were set up");
  assert.equal(ready.roots, 1);

  fs.mkdirSync(path.join(root, "Artist", "Album"), { recursive: true });
  fs.writeFileSync(path.join(root, "Artist", "Album", "track.flac"), "x");
  const changed = await Promise.race([changeSeen, wait(5000).then(() => null)]);
  assert.deepEqual(changed, [root]);
  assert.deepEqual(errors, []);
});
