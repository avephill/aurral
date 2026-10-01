import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { cleanupIsolatedState, resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

// Ideas and problems sent from the app, and what comes back.

const [isolatedState, { db }, feedback] = await setupIsolatedBackend(
  "feedback",
  "backend/config/db-sqlite.js",
  "backend/services/feedbackService.js",
);

const dad = { username: "dunshill", role: "user" };
const admin = { username: "avery", role: "admin" };

test.before(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM feedback").run();
});
test.after(() => cleanupIsolatedState(isolatedState));

test("a message keeps where it was written and the build it was written on", () => {
  const sent = feedback.sendFeedback("dunshill", { kind: "problem", message: "  The play button does nothing  ", page: "/library/album/7" }, { now: 1000 });
  assert.equal(sent.message, "The play button does nothing");
  assert.equal(sent.page, "/library/album/7");
  assert.ok(sent.appVersion, "the version it leads back to");
  assert.equal(sent.status, "new");
  assert.equal(sent.unreadReply, false);
  // Somewhere that is not a page of the app is not kept.
  assert.equal(feedback.sendFeedback("dunshill", { kind: "idea", message: "x", page: "https://elsewhere" }, { now: 1001 }).page, null);
  assert.throws(() => feedback.sendFeedback("dunshill", { kind: "rant", message: "x" }), /problem or an idea/);
  assert.throws(() => feedback.sendFeedback("dunshill", { kind: "idea", message: "   " }), /Write something/);
});

test("people see their own; an admin is told what nobody has read", () => {
  feedback.sendFeedback("helen", { kind: "idea", message: "Lyrics?" }, { now: 1002 });
  assert.deepEqual(feedback.listFeedbackFrom("dunshill").map((item) => item.username), ["dunshill", "dunshill"]);
  assert.equal(feedback.listAllFeedback().length, 3);
  assert.deepEqual(feedback.feedbackWaiting(admin), { unreadReplies: 0, unseen: 3 });
  assert.deepEqual(feedback.feedbackWaiting(dad), { unreadReplies: 0, unseen: 0 }, "not someone else's");
});

test("marking one read is not news to its sender; a reply is, until it is read", () => {
  const [, first] = feedback.listFeedbackFrom("dunshill");
  feedback.answerFeedback(first.id, { status: "seen" }, { now: 2000 });
  assert.equal(feedback.feedbackWaiting(dad).unreadReplies, 0);
  assert.equal(feedback.feedbackWaiting(admin).unseen, 2);

  feedback.answerFeedback(first.id, { reply: "Fixed - try it now", status: "done" }, { now: 3000 });
  assert.equal(feedback.feedbackWaiting(dad).unreadReplies, 1);
  const answered = feedback.listFeedbackFrom("dunshill").find((item) => item.id === first.id);
  assert.equal(answered.reply, "Fixed - try it now");
  assert.equal(answered.unreadReply, true);

  feedback.markRepliesRead("dunshill", { now: 4000 });
  assert.equal(feedback.feedbackWaiting(dad).unreadReplies, 0);
  assert.throws(() => feedback.answerFeedback(first.id, { status: "someday" }), /Unknown status/);
  assert.throws(() => feedback.answerFeedback(99999, { status: "done" }), /No such message/);
});

test("only an admin reads everyone's or answers", () => {
  const routes = readFileSync(new URL("../../backend/routes/feedback.js", import.meta.url), "utf8");
  assert.match(routes, /router\.use\(requireAuth\)/);
  for (const route of ['router.get("/", requireAdmin', 'router.patch("/:id", requireAdmin', 'router.delete("/:id", requireAdmin']) {
    assert.ok(routes.includes(route), route);
  }
  const server = readFileSync(new URL("../../backend/server.js", import.meta.url), "utf8");
  assert.match(server, /app\.use\("\/api\/feedback", feedbackRouter\)/);
});
