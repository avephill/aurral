import { db } from "../config/db-sqlite.js";

/**
 * Congregations: who reaches whom.
 *
 * A congregation is a group of people who share with each other. What you send
 * - a recommendation, a playlist, what you have been playing - goes to everyone
 * in every congregation you are in, and to nobody else. Someone can be in
 * several: the person who is in Family with their dad and in Roommates with
 * their flatmate reaches both, and those two never see each other.
 *
 * This does not scope the library. Everyone can still see, play and ask for the
 * same music; the server holds one collection. It scopes what people make and
 * what they listen to, which is the part that is nobody else's business.
 *
 * Two kinds, and the difference is who can join:
 * - `open`: anyone can see it and put themselves in it.
 * - `assigned`: only its own members and an admin see it at all, and only an
 *   admin puts people in. Family is this kind, which is what stops a flatmate
 *   wandering into it.
 */

const now = () => Date.now();

export class CongregationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CongregationError";
    this.status = status;
  }
}

const ENROLLMENTS = new Set(["open", "assigned"]);

const normalizeName = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

const rowView = (row, members) => ({
  id: row.id,
  name: row.name,
  description: row.description || "",
  enrollment: row.enrollment,
  members,
  memberCount: members.length,
});

function membersOf(id) {
  return db.prepare("SELECT username FROM congregation_members WHERE congregation_id = ? ORDER BY username")
    .all(id)
    .map((row) => row.username);
}

export function getCongregation(id) {
  const row = db.prepare("SELECT * FROM congregations WHERE id = ?").get(Number(id));
  return row ? rowView(row, membersOf(row.id)) : null;
}

/** The congregations someone is in. */
export function congregationsFor(username) {
  return db.prepare(`
    SELECT c.* FROM congregations AS c
    JOIN congregation_members AS m ON m.congregation_id = c.id
    WHERE m.username = ? ORDER BY c.name COLLATE NOCASE
  `).all(username).map((row) => rowView(row, membersOf(row.id)));
}

/**
 * What someone is allowed to see: the ones they are in, plus every open one.
 * An assigned congregation they are not in is not theirs to know about.
 */
export function visibleCongregations(username, { isAdmin = false } = {}) {
  if (isAdmin) {
    return db.prepare("SELECT * FROM congregations ORDER BY name COLLATE NOCASE")
      .all()
      .map((row) => rowView(row, membersOf(row.id)));
  }
  const mine = new Set(congregationsFor(username).map((entry) => entry.id));
  return db.prepare("SELECT * FROM congregations ORDER BY name COLLATE NOCASE")
    .all()
    .filter((row) => row.enrollment === "open" || mine.has(row.id))
    .map((row) => ({ ...rowView(row, membersOf(row.id)), joined: mine.has(row.id) }));
}

/**
 * Everyone this person shares with: all the members of all their
 * congregations, themselves left out. This is the one answer the rest of the
 * app asks for, so that adding a congregation somewhere cannot be forgotten
 * in one of the places that needs it.
 */
export function peopleSharingWith(username) {
  const rows = db.prepare(`
    SELECT DISTINCT other.username AS username
    FROM congregation_members AS mine
    JOIN congregation_members AS other ON other.congregation_id = mine.congregation_id
    WHERE mine.username = ? AND other.username != ?
    ORDER BY other.username
  `).all(username, username);
  return rows.map((row) => row.username);
}

/** Whether these two are in any congregation together. */
export function sharesWith(a, b) {
  if (!a || !b || a === b) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM congregation_members AS x
    JOIN congregation_members AS y ON y.congregation_id = x.congregation_id
    WHERE x.username = ? AND y.username = ? LIMIT 1
  `).get(a, b));
}

/**
 * A new account joins every congregation anyone may join. The assigned ones
 * stay an admin's decision, so a new person can still land in none at all -
 * which leaves them unable to reach anyone, and no one able to reach them.
 * Settings says who is in that position.
 */
export function enrollNewMember(username) {
  const name = String(username || "").trim();
  if (!name) return [];
  const rows = db.prepare("SELECT id FROM congregations WHERE enrollment = 'open'").all();
  if (!rows.length) return [];
  const at = Date.now();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO congregation_members (congregation_id, username, joined_at) VALUES (?, ?, ?)",
  );
  db.transaction(() => {
    for (const row of rows) insert.run(row.id, name, at);
  })();
  return rows.map((row) => row.id);
}

export function createCongregation({ name, description = "", enrollment = "assigned", members = [] }) {
  const cleanName = normalizeName(name);
  if (!cleanName) throw new CongregationError("A congregation needs a name");
  if (!ENROLLMENTS.has(enrollment)) throw new CongregationError("Enrollment must be open or assigned");
  const existing = db.prepare("SELECT id FROM congregations WHERE name = ? COLLATE NOCASE").get(cleanName);
  if (existing) throw new CongregationError(`There is already a congregation called ${cleanName}`, 409);
  const at = now();
  const id = db.prepare(`
    INSERT INTO congregations (name, description, enrollment, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `).run(cleanName, String(description || "").slice(0, 400), enrollment, at, at).lastInsertRowid;
  setMembers(id, members);
  return getCongregation(id);
}

export function updateCongregation(id, { name, description, enrollment }) {
  const current = db.prepare("SELECT * FROM congregations WHERE id = ?").get(Number(id));
  if (!current) throw new CongregationError("No such congregation", 404);
  const cleanName = name === undefined ? current.name : normalizeName(name);
  if (!cleanName) throw new CongregationError("A congregation needs a name");
  if (enrollment !== undefined && !ENROLLMENTS.has(enrollment)) {
    throw new CongregationError("Enrollment must be open or assigned");
  }
  const clash = db.prepare("SELECT id FROM congregations WHERE name = ? COLLATE NOCASE AND id != ?")
    .get(cleanName, current.id);
  if (clash) throw new CongregationError(`There is already a congregation called ${cleanName}`, 409);
  db.prepare("UPDATE congregations SET name = ?, description = ?, enrollment = ?, updated_at = ? WHERE id = ?").run(
    cleanName,
    description === undefined ? current.description : String(description || "").slice(0, 400),
    enrollment === undefined ? current.enrollment : enrollment,
    now(),
    current.id,
  );
  return getCongregation(current.id);
}

export function deleteCongregation(id) {
  const info = db.prepare("DELETE FROM congregations WHERE id = ?").run(Number(id));
  if (!info.changes) throw new CongregationError("No such congregation", 404);
  return { removed: true };
}

/** Replace who is in one. Only an admin gets here. */
export function setMembers(id, usernames = []) {
  const wanted = [...new Set((Array.isArray(usernames) ? usernames : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  const known = new Set(db.prepare("SELECT username FROM users").all().map((row) => row.username));
  const unknown = wanted.filter((username) => !known.has(username));
  if (unknown.length) throw new CongregationError(`No account called ${unknown[0]}`);
  const at = now();
  db.transaction(() => {
    db.prepare("DELETE FROM congregation_members WHERE congregation_id = ?").run(Number(id));
    const insert = db.prepare(
      "INSERT OR IGNORE INTO congregation_members (congregation_id, username, joined_at) VALUES (?, ?, ?)",
    );
    for (const username of wanted) insert.run(Number(id), username, at);
  })();
  return getCongregation(id);
}

/** Put yourself in one. Only works on the ones anyone may join. */
export function joinCongregation({ id, username }) {
  const row = db.prepare("SELECT * FROM congregations WHERE id = ?").get(Number(id));
  if (!row) throw new CongregationError("No such congregation", 404);
  if (row.enrollment !== "open") {
    throw new CongregationError(`${row.name} is one someone puts you in rather than one you join`, 403);
  }
  db.prepare("INSERT OR IGNORE INTO congregation_members (congregation_id, username, joined_at) VALUES (?, ?, ?)")
    .run(row.id, username, now());
  return getCongregation(row.id);
}

/**
 * Take yourself out. Allowed whoever put you there: staying in a group you did
 * not ask for is not something to have to ask an admin about.
 */
export function leaveCongregation({ id, username }) {
  const info = db.prepare("DELETE FROM congregation_members WHERE congregation_id = ? AND username = ?")
    .run(Number(id), username);
  if (!info.changes) throw new CongregationError("You are not in that one", 404);
  return { left: true };
}
