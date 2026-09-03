import assert from "node:assert/strict";
import test from "node:test";

import {
  recordRequestForRepeatDetection,
  resetRepeatRequestTracking,
} from "../../backend/services/diagnostics.js";
import { logger } from "../../backend/services/logger.js";

const captureWarnings = (run) => {
  const warnings = [];
  const original = logger.warn;
  logger.warn = (category, message, meta) => warnings.push({ category, message, meta });
  try {
    run();
  } finally {
    logger.warn = original;
  }
  return warnings;
};

test.beforeEach(() => {
  resetRepeatRequestTracking();
  delete process.env.AURRAL_REPEAT_REQUEST_LIMIT;
});

test.after(() => {
  resetRepeatRequestTracking();
  delete process.env.AURRAL_REPEAT_REQUEST_LIMIT;
});

test("a client refetching one endpoint in a loop is reported once", () => {
  process.env.AURRAL_REPEAT_REQUEST_LIMIT = "5";
  const warnings = captureWarnings(() => {
    for (let i = 0; i < 12; i += 1) {
      recordRequestForRepeatDetection({ method: "GET", path: "/api/user-library/new", userId: 7 });
    }
  });

  assert.equal(warnings.length, 1, "should complain on the crossing, not per request");
  assert.equal(warnings[0].message, "Repeated identical requests");
  assert.equal(warnings[0].meta.path, "/api/user-library/new");
  assert.equal(warnings[0].meta.userId, 7);
  assert.equal(warnings[0].meta.count, 5);
});

test("ordinary browsing across endpoints stays quiet", () => {
  process.env.AURRAL_REPEAT_REQUEST_LIMIT = "5";
  const warnings = captureWarnings(() => {
    for (let i = 0; i < 12; i += 1) {
      recordRequestForRepeatDetection({ method: "GET", path: `/api/page/${i}`, userId: 7 });
    }
  });
  assert.deepEqual(warnings, []);
});

test("two users hitting the same endpoint are counted apart", () => {
  process.env.AURRAL_REPEAT_REQUEST_LIMIT = "3";
  const warnings = captureWarnings(() => {
    for (let i = 0; i < 2; i += 1) {
      recordRequestForRepeatDetection({ method: "GET", path: "/api/discover", userId: 1 });
      recordRequestForRepeatDetection({ method: "GET", path: "/api/discover", userId: 2 });
    }
  });
  assert.deepEqual(warnings, [], "two users at two requests each is not a loop");
});

test("writes are not counted; a repeated POST is usually the user", () => {
  process.env.AURRAL_REPEAT_REQUEST_LIMIT = "2";
  const warnings = captureWarnings(() => {
    for (let i = 0; i < 8; i += 1) {
      recordRequestForRepeatDetection({ method: "POST", path: "/api/requests", userId: 7 });
    }
  });
  assert.deepEqual(warnings, []);
});
