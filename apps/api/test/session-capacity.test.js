import test from "node:test";
import assert from "node:assert/strict";
import {
  validPatientLimit,
  parsePatientLimit,
  PATIENT_LIMIT_RULE,
} from "../../../shared/session-capacity.mjs";

test("manual nullable limit accepts all positive safe integers without a duration formula", () => {
  assert.equal(PATIENT_LIMIT_RULE, "manual-nullable-v1");
  for (const value of [null, 1, 3, 101, Number.MAX_SAFE_INTEGER])
    assert.equal(validPatientLimit(value), true);
  for (const value of [
    undefined,
    "3",
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(validPatientLimit(value), false);
});

test("blank means unset; typed invalid values are never rounded, clamped or parsed partially", () => {
  assert.equal(parsePatientLimit(""), null);
  assert.equal(parsePatientLimit("3"), 3);
  for (const value of ["0", "-1", "3.5", "3x", "1e3", "9007199254740992"])
    assert.throws(() => parsePatientLimit(value), /positive whole/);
});

test("pure future admission precondition rejects unset; no booking endpoint is implemented", () => {
  const admissionReady = (capacity) =>
    capacity !== null && validPatientLimit(capacity);
  assert.equal(admissionReady(null), false);
  assert.equal(admissionReady(3), true);
});
