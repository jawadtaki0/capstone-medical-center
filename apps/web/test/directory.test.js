import test from "node:test";
import assert from "node:assert/strict";
import { filterProfessionals, parseDirectoryResponse } from "../src/lib/directory.js";

// All fixture identities are synthetic; no patient or booking information is used.
const professionals = [
  { id: "test:doctor:alex", name: "Dr. Alex Example", specialty: "ENT (Otolaryngology)", kind: "doctor" },
  { id: "test:doctor:jordan", name: "Dr. Jordan Example", specialty: "Cardiology", kind: "doctor" },
  { id: "test:specialist:sam", name: "Sam Example", specialty: "Dietitian", kind: "specialist" },
  { id: "test:specialist:taylor", name: "Taylor Example", specialty: "Psychological & Behavioral Specialist (Therapist)", kind: "specialist" },
  { id: "test:specialist:robin", name: "Robin Example", specialty: "Speech, Language, and Swallowing Therapist", kind: "specialist" },
];

function ids(items) {
  return items.map((item) => item.id);
}

test("directory search matches a professional name OR specialty immediately", () => {
  assert.deepEqual(ids(filterProfessionals(professionals, "Alex")), ["test:doctor:alex"]);
  assert.deepEqual(ids(filterProfessionals(professionals, "cardiology")), ["test:doctor:jordan"]);
  assert.deepEqual(ids(filterProfessionals(professionals, "Dietitian")), ["test:specialist:sam"]);
  assert.deepEqual(filterProfessionals(professionals, "No matching specialty"), []);
});

test("directory search is case-insensitive and normalizes surrounding and repeated whitespace", () => {
  assert.deepEqual(ids(filterProfessionals(professionals, "  dR.   ALEX   EXAMPLE  ")), ["test:doctor:alex"]);
  assert.deepEqual(ids(filterProfessionals(professionals, "  PSYCHOLOGICAL   &   BEHAVIORAL  ")), ["test:specialist:taylor"]);
  const irregular = [{ id: "test:doctor:spacing", name: "Dr.   Pat  Example", specialty: "General   Surgery", kind: "doctor" }];
  assert.deepEqual(filterProfessionals(irregular, "  GENERAL SURGERY "), irregular);
});

test("clearing or entering only whitespace restores the entire directory without mutating it", () => {
  const before = structuredClone(professionals);
  assert.equal(filterProfessionals(professionals, ""), professionals);
  assert.equal(filterProfessionals(professionals, " \t \n "), professionals);
  filterProfessionals(professionals, "Example");
  assert.deepEqual(professionals, before);
});

test("Therapist search matches the displayed label and original psychological wording", () => {
  assert.deepEqual(ids(filterProfessionals(professionals, "therapist")), ["test:specialist:taylor", "test:specialist:robin"]);
  const displayOnlyMatch = [{ ...professionals[3], specialty: "Psychological & Behavioral Specialist" }];
  assert.deepEqual(filterProfessionals(displayOnlyMatch, "Therapist"), displayOnlyMatch);
  for (const query of ["Psychological", "Behavioral", "Psychological & Behavioral Specialist"]) {
    assert.deepEqual(ids(filterProfessionals(professionals, query)), ["test:specialist:taylor"]);
  }
  assert.equal(professionals[3].specialty, "Psychological & Behavioral Specialist (Therapist)");
  const shortLabel = [{ ...professionals[3], specialty: "Therapist" }];
  assert.deepEqual(filterProfessionals(shortLabel, "Behavioral"), shortLabel);
  assert.deepEqual(filterProfessionals(shortLabel, "Psychological"), shortLabel);
  assert.equal(shortLabel[0].specialty, "Therapist");
});

test("response parsing includes both doctors and specialists without a fixed display limit", () => {
  const many = Array.from({ length: 35 }, (_, index) => ({
    id: `test:profile:${index}`,
    name: `Example Professional ${index}`,
    specialty: "Example specialty",
    kind: index % 2 === 0 ? "doctor" : "specialist",
  }));
  const parsed = parseDirectoryResponse({ professionals: many });
  assert.deepEqual(parsed, many.map((professional) => ({ ...professional, avatarVariant: "neutral" })));
  assert.equal(filterProfessionals(parsed, "Example").length, many.length);
  assert.ok(parsed.some((item) => item.kind === "doctor"));
  assert.ok(parsed.some((item) => item.kind === "specialist"));
  assert.deepEqual(parseDirectoryResponse({ professionals: [] }), []);
});

test("response parsing explicitly allowlists public fields and retains names and stored specialties", () => {
  const publicFields = { ...professionals[0], avatarVariant: "female" };
  const parsed = parseDirectoryResponse({ professionals: [{
    ...publicFields,
    internalNotes: "Synthetic private fixture value",
    active: true,
    phone: "synthetic-only",
    createdAt: "2026-01-01",
    gender: "male",
  }] });
  assert.deepEqual(parsed, [publicFields]);
  assert.notEqual(parsed[0], publicFields);
});

test("only the public avatar enum survives parsing; missing and malformed values become neutral", () => {
  for (const avatarVariant of ["male", "female", "neutral"]) {
    const [parsed] = parseDirectoryResponse({ professionals: [{ ...professionals[0], avatarVariant }] });
    assert.equal(parsed.avatarVariant, avatarVariant);
  }
  for (const avatarVariant of [undefined, null, "", "unknown", "Male", " female ", 42, {}, []]) {
    const [parsed] = parseDirectoryResponse({ professionals: [{ ...professionals[0], avatarVariant }] });
    assert.equal(parsed.avatarVariant, "neutral");
    assert.equal(parsed.name, professionals[0].name);
  }
});

test("malformed directory responses fail instead of inventing fallback professionals", () => {
  for (const payload of [null, undefined, [], {}, { professionals: null }, { professionals: {} }]) {
    assert.throws(() => parseDirectoryResponse(payload), /invalid/);
  }

  for (const field of ["id", "name", "specialty", "kind"]) {
    for (const value of [undefined, null, 42, "", "  "]) {
      assert.throws(() => parseDirectoryResponse({ professionals: [{ ...professionals[0], [field]: value }] }), /invalid/);
    }
  }
  assert.throws(() => parseDirectoryResponse({ professionals: [null] }), /invalid/);
  assert.throws(() => parseDirectoryResponse({ professionals: [{ ...professionals[0], kind: "admin" }] }), /invalid/);
});

test("duplicate stable profile IDs are rejected rather than rendered twice", () => {
  assert.throws(() => parseDirectoryResponse({ professionals: [professionals[0], { ...professionals[0], name: "Other Example" }] }), /duplicate/);
});
