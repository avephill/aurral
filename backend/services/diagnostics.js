import { monitorEventLoopDelay } from "node:perf_hooks";

import { logger } from "./logger.js";

const NS_PER_MS = 1e6;

const readEnvNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const getSlowRequestThresholdMs = () =>
  readEnvNumber("AURRAL_SLOW_REQUEST_MS", 1000);

let histogram = null;
let timer = null;

// Event-loop lag is the one signal that catches "the app is unresponsive"
// regardless of the cause: blocking JS, a synchronous SQLite call, or native
// addon work that never shows up in a V8 CPU profile.
export function startEventLoopMonitor() {
  if (timer) return false;
  const thresholdMs = readEnvNumber("AURRAL_LOOP_LAG_MS", 250);
  const intervalMs = readEnvNumber("AURRAL_LOOP_LAG_INTERVAL_MS", 30000);

  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  let previousCpu = process.cpuUsage();
  let previousAt = Date.now();

  timer = setInterval(() => {
    const maxMs = histogram.max / NS_PER_MS;
    const meanMs = histogram.mean / NS_PER_MS;
    const p99Ms = histogram.percentile(99) / NS_PER_MS;
    histogram.reset();

    const cpu = process.cpuUsage();
    const now = Date.now();
    const elapsedMs = Math.max(1, now - previousAt);
    // Percent of one core used since the last window.
    const cpuPercent =
      ((cpu.user - previousCpu.user + (cpu.system - previousCpu.system)) /
        1000 /
        elapsedMs) *
      100;
    previousCpu = cpu;
    previousAt = now;

    if (!Number.isFinite(maxMs) || maxMs < thresholdMs) return;
    logger.warn("perf", "Event loop blocked", {
      maxMs: Math.round(maxMs),
      p99Ms: Math.round(p99Ms),
      meanMs: Math.round(meanMs),
      cpuPercent: Math.round(cpuPercent),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      windowS: Math.round(elapsedMs / 1000),
    });
  }, intervalMs);
  timer.unref?.();
  return true;
}

export function stopEventLoopMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
  histogram?.disable();
  histogram = null;
}
