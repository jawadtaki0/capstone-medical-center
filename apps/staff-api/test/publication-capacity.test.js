import test from "node:test";
import assert from "node:assert/strict";
import { validatePublication } from "../src/operational-publication.js";

function snapshot() {
  return {
    scopes: [{ id: "clinic:synthetic", kind: "clinic", active: true }],
    professionals: [
      {
        id: "doctor:synthetic",
        specialty: "Dentistry",
        gender: "male",
        active: true,
        scopeIds: ["clinic:synthetic"],
      },
    ],
    sessions: [
      {
        id: "synthetic",
        scopeId: "clinic:synthetic",
        professionalId: "doctor:synthetic",
        weekday: 1,
        startTime: "09:00",
        endTime: "10:00",
        capacity: 2,
        status: "active",
        appointmentRequired: true,
      },
    ],
    exceptions: [],
    hours: Array.from({ length: 7 }, (_, day) => ({
      id: String(day),
      closed: false,
      startTime: "08:00",
      endTime: "17:00",
    })),
  };
}
test("publication accepts manual or unset limits while preserving gender and hours safeguards", () => {
  assert.doesNotThrow(() => validatePublication(snapshot()));
  for (const capacity of [null, 3, 101, Number.MAX_SAFE_INTEGER]) {
    const value = snapshot();
    value.sessions[0].capacity = capacity;
    value.sessions[0].endTime = "10:07";
    assert.doesNotThrow(() => validatePublication(value));
    value.professionals[0].specialty = "Therapist";
    assert.doesNotThrow(() => validatePublication(value));
    assert.equal(value.sessions[0].capacity, capacity);
  }
  for (const mutate of [
    (s) => {
      s.professionals[0].gender = "neutral";
    },
    (s) => {
      delete s.professionals[0].gender;
    },
    (s) => {
      s.sessions[0].capacity = 0;
    },
    (s) => {
      s.sessions[0].endTime = "18:00";
    },
    (s) => {
      s.sessions[0].capacity = Number.MAX_SAFE_INTEGER + 1;
    },
  ]) {
    const value = snapshot();
    mutate(value);
    const before = structuredClone(value);
    assert.throws(() => validatePublication(value), {
      code: "publication_incomplete",
    });
    assert.deepEqual(value, before);
  }
});
test("dated replacement limits are independent nullable values, not inherited or calculated", () => {
  const value = snapshot();
  value.exceptions.push({
    id: "synthetic-date",
    scopeId: "clinic:synthetic",
    date: "2026-10-26",
    closed: false,
    sessions: [{ ...value.sessions[0], endTime: "11:00" }],
  });
  value.exceptions[0].sessions[0].capacity = null;
  assert.doesNotThrow(() => validatePublication(value));
  value.exceptions[0].sessions[0].capacity = 3;
  assert.doesNotThrow(() => validatePublication(value));
});
