import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

// Congregations decide who reaches whom. The case that matters: someone in
// Family with their father and in Roommates with their flatmate reaches both,
// and those two never see each other.

const [isolatedState, { db }, { userOps }, congregations] = await setupIsolatedBackend(
  "congregations",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/congregationService.js",
);

test.before(() => {
  resetDatabase(db);
  for (const name of ["avery", "dunshill", "sister", "flatmate", "stranger"]) {
    userOps.createUser(name, "hash");
  }
  db.prepare("DELETE FROM congregation_members").run();
  db.prepare("DELETE FROM congregations").run();
  congregations.createCongregation({
    name: "Family", enrollment: "assigned", members: ["avery", "dunshill", "sister"],
  });
  congregations.createCongregation({
    name: "Roommates", enrollment: "assigned", members: ["avery", "flatmate"],
  });
});

test.after(() => cleanupIsolatedState(isolatedState));

test("you reach everyone in every congregation you are in", () => {
  assert.deepEqual(
    congregations.peopleSharingWith("avery").sort(),
    ["dunshill", "flatmate", "sister"],
  );
});

test("and the people either side of you never meet", () => {
  assert.deepEqual(congregations.peopleSharingWith("dunshill").sort(), ["avery", "sister"]);
  assert.equal(congregations.sharesWith("dunshill", "flatmate"), false, "the point of the whole thing");
  assert.equal(congregations.sharesWith("avery", "flatmate"), true);
});

test("someone in nothing reaches nobody", () => {
  assert.deepEqual(congregations.peopleSharingWith("stranger"), []);
  assert.equal(congregations.sharesWith("stranger", "avery"), false);
});

test("an assigned congregation is invisible to people outside it", () => {
  const seen = congregations.visibleCongregations("flatmate").map((entry) => entry.name);
  assert.deepEqual(seen, ["Roommates"], "Family is not theirs to know about");
  const admin = congregations.visibleCongregations("flatmate", { isAdmin: true }).map((entry) => entry.name);
  assert.deepEqual(admin.sort(), ["Family", "Roommates"]);
});

test("an open one is on offer to everybody, and can be joined and left", () => {
  const open = congregations.createCongregation({ name: "Hymns", enrollment: "open" });
  assert.ok(congregations.visibleCongregations("stranger").some((entry) => entry.name === "Hymns"));

  congregations.joinCongregation({ id: open.id, username: "stranger" });
  assert.deepEqual(congregations.congregationsFor("stranger").map((e) => e.name), ["Hymns"]);

  congregations.leaveCongregation({ id: open.id, username: "stranger" });
  assert.deepEqual(congregations.congregationsFor("stranger"), []);
});

test("an assigned one cannot be joined by the person who fancies it", () => {
  const family = congregations.visibleCongregations("avery").find((entry) => entry.name === "Family");
  assert.throws(
    () => congregations.joinCongregation({ id: family.id, username: "flatmate" }),
    /someone puts you in/,
  );
  assert.equal(congregations.sharesWith("dunshill", "flatmate"), false);
});

test("you can always take yourself out of one you were put in", () => {
  const family = congregations.visibleCongregations("avery").find((entry) => entry.name === "Family");
  congregations.leaveCongregation({ id: family.id, username: "sister" });
  assert.equal(congregations.sharesWith("sister", "dunshill"), false);
  congregations.setMembers(family.id, ["avery", "dunshill", "sister"]);
  assert.equal(congregations.sharesWith("sister", "dunshill"), true);
});

test("two congregations cannot share a name", () => {
  assert.throws(() => congregations.createCongregation({ name: "family" }), /already a congregation/);
});

test("only accounts that exist can be put in one", () => {
  const family = congregations.visibleCongregations("avery").find((entry) => entry.name === "Family");
  assert.throws(() => congregations.setMembers(family.id, ["nobody"]), /No account called nobody/);
});
