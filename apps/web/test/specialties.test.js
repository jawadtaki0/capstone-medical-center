import test from "node:test";
import assert from "node:assert/strict";
import {
  specialtyDefinitions,
  getSpecialtyIcon,
  specialtyLabel,
} from "../src/data/specialties.js";
import { existsSync } from "node:fs";

test("all fourteen supplied icons have packaged assets", () => {
  assert.equal(specialtyDefinitions.length, 14);
  assert.equal(new Set(specialtyDefinitions.map((item) => item.id)).size, 14);
  for (const item of specialtyDefinitions) {
    assert.ok(existsSync(new URL(item.asset)), item.id);
    for (const alias of item.aliases)
      assert.equal(getSpecialtyIcon(alias).id, item.id);
  }
});

test("ENT aliases, case, whitespace and equivalent specialty wording share icons", () => {
  assert.equal(
    getSpecialtyIcon("ENT"),
    getSpecialtyIcon("ENT (Otolaryngology)"),
  );
  assert.equal(getSpecialtyIcon("  ent   ( Otolaryngology ) ").id, "ent");
  assert.equal(getSpecialtyIcon("Dentist").id, "dentistry");
  assert.equal(
    getSpecialtyIcon("Endocrinology and Diabetes").id,
    "endocrinology",
  );
  assert.equal(getSpecialtyIcon("Gastreonterologist").id, "gastroenterology");
});

test("Therapist is a display-only abbreviation and other labels stay unchanged", () => {
  const original = "Psychological & Behavioral Specialist (Therapist)";
  assert.equal(specialtyLabel(original), "Therapist");
  assert.equal(getSpecialtyIcon(original).id, "therapist");
  assert.equal(specialtyLabel("ENT (Otolaryngology)"), "ENT (Otolaryngology)");
  assert.equal(specialtyLabel("Dentistry"), "Dentistry");
});

test("unknown and missing specialties have a neutral fallback without hiding their text", () => {
  for (const input of ["Unknown specialty", "", null, undefined, 42]) {
    assert.equal(getSpecialtyIcon(input).id, "medical");
    assert.equal(getSpecialtyIcon(input).asset, null);
  }
  assert.equal(specialtyLabel("Unknown specialty"), "Unknown specialty");
  assert.equal(specialtyLabel(null), "Medical care");
});
