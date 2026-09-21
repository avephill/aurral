import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// A <label> hands every click inside it to the control it labels. Wrapping the
// people picker in one meant the text box swallowed the clicks on the names,
// so a person offered in the list could not be chosen - the picker works bare
// on the Social page and did not in the recommend dialog for that reason alone.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the people picker is never wrapped in a label", () => {
  for (const path of [
    "../../frontend/src/components/RecommendModal.jsx",
    "../../frontend/src/pages/SocialPage.jsx",
  ]) {
    const source = read(path);
    let index = source.indexOf("<PeoplePicker");
    while (index !== -1) {
      const before = source.slice(0, index);
      const openedLabel = before.lastIndexOf("<label");
      const closedLabel = before.lastIndexOf("</label>");
      assert.ok(
        openedLabel === -1 || closedLabel > openedLabel,
        `${path} wraps a PeoplePicker in a <label>`,
      );
      index = source.indexOf("<PeoplePicker", index + 1);
    }
  }
});

test("the picker can be captioned without a label element", () => {
  const picker = read("../../frontend/src/components/PeoplePicker.jsx");
  assert.match(picker, /aria-labelledby=\{labelId \|\| undefined\}/);
  assert.match(read("../../frontend/src/components/RecommendModal.jsx"), /labelId=\{sendToId\}/);
});
