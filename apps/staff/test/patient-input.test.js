import test from "node:test";
import assert from "node:assert/strict";
import { canonicalPhone } from "../shared/contact-input.js";
import {
  patientInput,
  classifyPatientDuplicate,
  similarPatientName,
  patientNameSignatures,
  shiftPatientYear,
} from "../shared/patient-input.js";
const person = {
  firstName: "Synthetic",
  fatherName: "Father",
  lastName: "Example",
  motherFirstName: "Mother",
  dateOfBirth: "2000-02-29",
  phone: "+96171123456",
  gender: "female",
};

test("selected-country phone formats accept national hyphens/spaces and preserve E.164 validation", () => {
  for (const raw of ["71-123456", "71-123 456", "71 123 456"])
    assert.equal(canonicalPhone(raw, "LB"), "+96171123456");
  assert.equal(canonicalPhone("03-123456", "LB"), "+9613123456");
  assert.equal(canonicalPhone("202-555-0123", "US"), "+12025550123");
  assert.equal(canonicalPhone("020-7946 0018", "GB"), "+442079460018");
  assert.equal(canonicalPhone("71-123456", "US"), null);
  for (const phone of ["+12025550123", "+442079460018", "+9613123456"])
    assert.deepEqual(
      patientInput({ ...person, phone }, "2026-10-27").errors,
      {},
    );
});
test("patient fields preserve display names, validate real dates and permit shared family phones", () => {
  const a = patientInput(
    { ...person, firstName: "  SyNtHeTiC  " },
    "2026-10-27",
  );
  assert.deepEqual(a.errors, {});
  assert.equal(a.record.firstName, "SyNtHeTiC");
  for (const dateOfBirth of ["2027-01-01", "2001-02-29", ""])
    assert.ok(
      patientInput({ ...person, dateOfBirth }, "2026-10-27").errors.dateOfBirth,
    );
  assert.equal(
    patientInput({ ...person, phone: person.phone }, "2026-10-27").record.phone,
    person.phone,
  );
  for (const field of Object.keys(person))
    assert.ok(
      patientInput({ ...person, [field]: "" }, "2026-10-27").errors[field],
    );
});
test("duplicate classification compares separate names, exact DOB and calendar-year discrepancies", () => {
  assert.equal(
    classifyPatientDuplicate(person, { ...person, firstName: " SYNTHETIC " }),
    "strong",
  );
  assert.equal(
    classifyPatientDuplicate(person, { ...person, fatherName: "Different" }),
    "possible",
  );
  assert.equal(
    classifyPatientDuplicate(person, {
      ...person,
      motherFirstName: "Different",
      dateOfBirth: "2001-02-28",
    }),
    "possible",
  );
  assert.equal(
    classifyPatientDuplicate(person, {
      ...person,
      motherFirstName: "Different",
      dateOfBirth: "2001-03-01",
    }),
    null,
  );
  assert.equal(
    classifyPatientDuplicate(person, { ...person, dateOfBirth: "1990-01-01" }),
    "possible",
  );
  assert.equal(
    classifyPatientDuplicate(person, { ...person, lastName: "Unrelated" }),
    null,
  );
  assert.equal(shiftPatientYear("2000-02-29", 1), "2001-02-28");
});
test("conservative name similarity covers one edit without aggressive Arabic normalization", () => {
  assert.equal(similarPatientName("Synthetic", "Synthetik"), true);
  assert.equal(similarPatientName("Synthetic", "Syntheti"), true);
  assert.equal(similarPatientName("Ali", "Aly"), false);
  assert.equal(similarPatientName("أحمد", "احمد"), false);
  assert.equal(similarPatientName("Synthetic", "Syntehtic"), false);
  assert.ok(
    patientNameSignatures("Synthetic").some((k) =>
      patientNameSignatures("Synthetik").includes(k),
    ),
  );
});
