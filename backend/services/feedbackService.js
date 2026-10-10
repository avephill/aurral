import { db } from "../config/db-sqlite.js";
import { APP_VERSION } from "../config/constants.js";

// Ideas and problems people send from the app, and what an admin says back.
// Everyone sees their own; admins see everyone's and mark each one as they go.

export const FEEDBACK_KINDS = ["problem", "idea"];
export const FEEDBACK_STATUSES = ["new", "seen", "planned", "done", "wont"];
const MAX_MESSAGE = 5000;
const MAX_REPLY = 2000;

export class FeedbackError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const toItem = (row) => ({
  id: row.id,
  username: row.username,
  kind: row.kind,
  message: row.message,
  page: row.page || null,
  appVersion: row.app_version || null,
  status: row.status,
  reply: row.reply || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  // Something came back that its sender has not looked at yet.
  unreadReply: row.updated_at > row.created_at && (row.reply_seen_at || 0) < row.updated_at,
});

export function sendFeedback(username, { kind, message, page } = {}, { now = Date.now() } = {}) {
  if (!FEEDBACK_KINDS.includes(kind)) throw new FeedbackError("Say whether it is a problem or an idea");
  const text = String(message || "").trim();
  if (!text) throw new FeedbackError("Write something first");
  if (text.length > MAX_MESSAGE) throw new FeedbackError(`Keep it under ${MAX_MESSAGE} characters`);
  const where = typeof page === "string" && page.startsWith("/") ? page.slice(0, 300) : null;
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO feedback (username, kind, message, page, app_version, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'new', ?, ?)
  `).run(username, kind, text, where, APP_VERSION, now, now);
  return toItem(db.prepare("SELECT * FROM feedback WHERE id = ?").get(lastInsertRowid));
}

export function listFeedbackFrom(username) {
  return db.prepare("SELECT * FROM feedback WHERE username = ? ORDER BY created_at DESC, id DESC")
    .all(username).map(toItem);
}

export function listAllFeedback() {
  return db.prepare(`
    SELECT * FROM feedback
    ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, created_at DESC, id DESC
  `).all().map(toItem);
}

// For the sidebar: admins are told about anything nobody has looked at yet,
// everyone else about an answer they have not read.
export function feedbackWaiting(user) {
  const unreadReplies = db.prepare(`
    SELECT COUNT(*) AS n FROM feedback
    WHERE username = ? AND updated_at > created_at AND COALESCE(reply_seen_at, 0) < updated_at
  `).get(user.username).n;
  const unseen = user.role === "admin"
    ? db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'").get().n
    : 0;
  return { unreadReplies, unseen };
}

export function markRepliesRead(username, { now = Date.now() } = {}) {
  db.prepare("UPDATE feedback SET reply_seen_at = ? WHERE username = ? AND updated_at > created_at")
    .run(now, username);
}

export function answerFeedback(id, { status, reply } = {}, { now = Date.now() } = {}) {
  const row = db.prepare("SELECT * FROM feedback WHERE id = ?").get(id);
  if (!row) throw new FeedbackError("No such message", 404);
  const nextStatus = status === undefined ? row.status : status;
  if (!FEEDBACK_STATUSES.includes(nextStatus)) throw new FeedbackError("Unknown status");
  const nextReply = reply === undefined ? row.reply : String(reply || "").trim() || null;
  if (nextReply && nextReply.length > MAX_REPLY) throw new FeedbackError(`Keep it under ${MAX_REPLY} characters`);
  // Marking something seen is housekeeping, not news for its sender; a new
  // status past that, or a reply, is.
  const tellsSender = nextReply !== row.reply || (nextStatus !== row.status && !["new", "seen"].includes(nextStatus));
  db.prepare("UPDATE feedback SET status = ?, reply = ?, updated_at = ? WHERE id = ?")
    .run(nextStatus, nextReply, tellsSender ? Math.max(now, row.created_at + 1) : row.updated_at, id);
  return toItem(db.prepare("SELECT * FROM feedback WHERE id = ?").get(id));
}

export function deleteFeedback(id) {
  const { changes } = db.prepare("DELETE FROM feedback WHERE id = ?").run(id);
  if (!changes) throw new FeedbackError("No such message", 404);
}
