import test from "node:test";
import assert from "node:assert/strict";
import {
  laboratoryTests,
  laboratoryCategories,
  filterLaboratoryTests,
  audiometryEntries,
  laboratoryFaqs,
  audiometryFaqs,
} from "../src/data/labAudioContent.js";

test("the fixed catalogue has exactly 24 unique tests in six stable browsing categories with complete preparation and references", () => {
  assert.equal(laboratoryTests.length, 24);
  assert.equal(new Set(laboratoryTests.map((t) => t.id)).size, 24);
  assert.equal(laboratoryCategories.length, 6);
  for (const t of laboratoryTests) {
    for (const k of [
      "name",
      "category",
      "sample",
      "description",
      "preparation",
      "question",
      "answer",
    ])
      assert.ok(t[k]?.trim(), t.id + ":" + k);
    assert.equal(t.checked, "2026-11-04");
    assert.ok(t.sources.length);
    for (const source of t.sources) {
      const u = new URL(source.url);
      assert.equal(u.protocol, "https:");
      assert.equal(u.hostname, "medlineplus.gov");
      assert.ok(!u.pathname.includes("007007"));
    }
  }
  assert.deepEqual(filterLaboratoryTests(), laboratoryTests);
});
test("search matches supplied abbreviations and aliases and combines with stable category filtering", () => {
  assert.deepEqual(
    filterLaboratoryTests(" FBC ").map((t) => t.id),
    ["cbc"],
  );
  assert.deepEqual(
    filterLaboratoryTests("SGPT").map((t) => t.id),
    ["alt"],
  );
  assert.deepEqual(
    filterLaboratoryTests("iFOBT").map((t) => t.id),
    ["fit"],
  );
  assert.deepEqual(
    filterLaboratoryTests("FT4").map((t) => t.id),
    ["free-t4"],
  );
  assert.equal(filterLaboratoryTests("CBC", "Urine and stool").length, 0);
  assert.equal(filterLaboratoryTests("culture", "Urine and stool").length, 2);
  assert.equal(filterLaboratoryTests("not-a-test").length, 0);
  assert.equal(laboratoryCategories.length, 6);
});
test("method and preparation distinctions remain per-test, not blanket fasting/medicine instructions", () => {
  const byId = Object.fromEntries(laboratoryTests.map((t) => [t.id, t]));
  assert.match(byId["fasting-glucose"].preparation, /at least eight hours/);
  assert.match(byId.hba1c.preparation, /not normally needed/);
  assert.match(byId.ferritin.preparation, /Fasting may be requested/);
  assert.match(byId.fit.answer, /guaiac tests are different/);
  assert.match(byId.crp.answer, /high-sensitivity test/);
  assert.match(byId["pt-inr"].answer, /Do not change it yourself/);
  assert.match(
    byId["urine-culture"].preparation,
    /do not stop treatment yourself/,
  );
});
test("only three informational hearing assessments and the agreed FAQ sets are exposed", () => {
  assert.deepEqual(
    audiometryEntries.map((t) => t.id),
    ["pure-tone", "speech", "tympanometry"],
  );
  assert.match(
    audiometryEntries[2].description,
    /not a replacement for measuring hearing thresholds/,
  );
  assert.equal(laboratoryFaqs.length, 4);
  assert.equal(audiometryFaqs.length, 3);
  for (const e of audiometryEntries) {
    assert.ok(e.sources[0].url.includes("hearing-tests-for-adults"));
    assert.equal(e.checked, "2026-11-04");
  }
  assert.match(audiometryFaqs[0][1], /not offered/);
});
