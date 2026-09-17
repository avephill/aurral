import test from "node:test";
import assert from "node:assert/strict";
import { describeRecommendationFrom, formatAudience } from "../../frontend/src/utils/audience.js";

test("one other person is named", () => {
  assert.equal(formatAudience(["dunshill"], "avery"), "dunshill");
});

test("the reader comes first, as themselves", () => {
  assert.equal(formatAudience(["admin", "dunshill"], "dunshill"), "you and admin");
});

test("three or more read as a list", () => {
  assert.equal(
    formatAudience(["admin", "authadmin", "dunshill"], "dunshill"),
    "you, admin and authadmin",
  );
});

test("a recommendation to everyone says who everyone is", () => {
  assert.equal(
    describeRecommendationFrom({ sender: "avery", audience: ["admin", "dunshill"] }, "dunshill"),
    "avery told you and admin",
  );
});

test("with nobody to name it still says who it came from", () => {
  assert.equal(describeRecommendationFrom({ sender: "avery", audience: [] }, "dunshill"), "from avery");
});
