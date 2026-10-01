import express from "express";
import { noCache } from "../middleware/cache.js";
import { requireAdmin, requireAuth } from "../middleware/requirePermission.js";
import {
  answerFeedback,
  deleteFeedback,
  feedbackWaiting,
  listAllFeedback,
  listFeedbackFrom,
  markRepliesRead,
  sendFeedback,
} from "../services/feedbackService.js";

// Ideas and problems: anyone signed in can send one and read their own;
// admins read everyone's, mark them, and write back.

const router = express.Router();
router.use(requireAuth);

const fail = (res, error, fallback) =>
  res.status(error?.status || 500).json({ error: error?.message || fallback });

router.get("/waiting", noCache, (req, res) => {
  try {
    res.json(feedbackWaiting(req.user));
  } catch (error) {
    fail(res, error, "Could not check for messages");
  }
});

router.get("/mine", noCache, (req, res) => {
  try {
    res.json({ items: listFeedbackFrom(req.user.username) });
  } catch (error) {
    fail(res, error, "Could not read your messages");
  }
});

router.post("/", (req, res) => {
  try {
    res.status(201).json(sendFeedback(req.user.username, req.body || {}));
  } catch (error) {
    fail(res, error, "Could not send that");
  }
});

router.post("/mine/read", (req, res) => {
  try {
    markRepliesRead(req.user.username);
    res.json({ ok: true });
  } catch (error) {
    fail(res, error, "Could not mark those read");
  }
});

router.get("/", requireAdmin, noCache, (req, res) => {
  try {
    res.json({ items: listAllFeedback() });
  } catch (error) {
    fail(res, error, "Could not read the messages");
  }
});

router.patch("/:id", requireAdmin, (req, res) => {
  try {
    const { status, reply } = req.body || {};
    res.json(answerFeedback(Number(req.params.id), { status, reply }));
  } catch (error) {
    fail(res, error, "Could not update that");
  }
});

router.delete("/:id", requireAdmin, (req, res) => {
  try {
    deleteFeedback(Number(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    fail(res, error, "Could not delete that");
  }
});

export default router;
