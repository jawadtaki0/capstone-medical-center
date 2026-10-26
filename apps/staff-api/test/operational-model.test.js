import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveSessions,
  assertNoOverlap,
  validateOperationalRecord,
  operationalAccess,
} from "../src/operational-model.js";

const weekly = (id, scopeId, startTime, endTime, extra = {}) => ({
  id,
  scopeId,
  professionalId: "doctor:synthetic",
  weekday: 1,
  startTime,
  endTime,
  capacity: 5,
  status: "active",
  appointmentRequired: false,
  ...extra,
});
test("same-professional intervals reject cross-clinic overlap but permit adjacent sessions", () => {
  assert.doesNotThrow(() =>
    assertNoOverlap([
      weekly("a", "one", "09:00", "12:00"),
      weekly("b", "two", "12:00", "15:00"),
    ]),
  );
  assert.throws(
    () =>
      assertNoOverlap([
        weekly("a", "one", "09:00", "12:00"),
        weekly("b", "two", "11:59", "15:00"),
      ]),
    { code: "schedule_overlap" },
  );
});
test("date exceptions replace only their scope/day and include changed hours in cross-clinic validation", () => {
  const sessions = [
    weekly("a", "one", "09:00", "11:00"),
    weekly("b", "two", "12:00", "14:00"),
  ];
  const changes = [
    {
      id: "change",
      scopeId: "one",
      date: "2026-10-19",
      closed: false,
      sessions: [weekly("a", "one", "12:30", "13:30")],
    },
  ];
  assert.equal(effectiveSessions(sessions, [], "2026-10-19").length, 2);
  assert.equal(
    effectiveSessions(
      sessions,
      [{ ...changes[0], closed: true, sessions: [] }],
      "2026-10-19",
    ).length,
    1,
  );
  assert.throws(() => assertNoOverlap(sessions, changes), {
    code: "schedule_overlap",
  });
  assert.equal(effectiveSessions(sessions, changes, "2026-10-20").length, 0);
});
test("validation accepts nullable/manual safe-integer limits and rejects invalid hours, forged properties and service capacity", () => {
  const input = weekly("a", "one", "09:00", "11:00");
  assert.equal(
    validateOperationalRecord("sessions", { ...input, capacity: null })
      .capacity,
    null,
  );
  for (const capacity of [3, 101, Number.MAX_SAFE_INTEGER])
    assert.equal(
      validateOperationalRecord("sessions", {
        ...input,
        endTime: "10:07",
        capacity,
      }).capacity,
      capacity,
    );
  for (const patch of [
    { startTime: "23:00", endTime: "01:00" },
    { capacity: 0 },
    { capacity: -1 },
    { capacity: 3.5 },
    { capacity: "3" },
    { capacity: Number.MAX_SAFE_INTEGER + 1 },
    { professionalId: null, capacity: 3 },
    { weekday: 7 },
    { roles: ["Admin"] },
    { slots: [] },
  ])
    assert.throws(
      () => validateOperationalRecord("sessions", { ...input, ...patch }),
      { code: "invalid_input" },
    );
  assert.throws(
    () =>
      validateOperationalRecord("exceptions", {
        id: "x",
        scopeId: "one",
        date: "2026-02-30",
        closed: true,
        sessions: [],
      }),
    { code: "invalid_input" },
  );
});
test("explicit service assignment permits Lab Admin Audiometry without hardcoding its name or granting clinics", () => {
  assert.throws(() => validateOperationalRecord("__proto__", {}), {
    code: "invalid_input",
  });
  const clinic = { id: "clinic", kind: "clinic", active: true },
    service = { id: "audio", kind: "service", active: true };
  assert.equal(
    operationalAccess(["Lab Admin"], ["audio", "clinic"], service).edit,
    true,
  );
  assert.equal(
    operationalAccess(["Lab Admin"], ["audio", "clinic"], clinic).edit,
    false,
  );
  assert.equal(
    operationalAccess(["Clinic Admin"], ["audio"], service).view,
    false,
  );
  assert.equal(operationalAccess(["Clinic Admin"], [], clinic).view, false);
  assert.equal(
    operationalAccess(["Receptionist"], ["clinic"], clinic).edit,
    false,
  );
  assert.equal(
    operationalAccess(["Clinic Admin"], ["clinic"], clinic).edit,
    true,
  );
  assert.equal(operationalAccess(["Admin"], [], clinic).publish, true);
});
