import test from "node:test";
import assert from "node:assert/strict";
import {
  beirutClock,
  datedSessionId,
  resolveBookingSessions,
  assertBookableTime,
} from "../src/booking-model.js";

const session = {
  id: "session:one",
  scopeId: "clinic:one",
  professionalId: "doctor:one",
  weekday: 1,
  startTime: "09:00",
  endTime: "11:00",
  capacity: 3,
  status: "active",
  appointmentRequired: true,
};
const event = {
  id: "publication:1",
  sequence: 1,
  effectiveFrom: null,
  publishedAt: "2026-01-01T00:00:00Z",
  scopeIds: ["clinic:one"],
  publishesHours: true,
  scopes: [{ id: "clinic:one", kind: "clinic", name: "Clinic", active: true }],
  professionals: [
    {
      id: "doctor:one",
      name: "Synthetic",
      specialty: "Dentistry",
      scopeIds: ["clinic:one"],
      active: true,
    },
  ],
  sessions: [session],
  exceptions: [],
  hours: Array.from({ length: 7 }, (_, i) => ({
    id: String(i),
    closed: false,
    startTime: "08:00",
    endTime: "17:00",
  })),
};
test("Beirut clock uses actual center date/minute across midnight and DST", () => {
  assert.deepEqual(beirutClock(new Date("2026-10-28T21:59:59Z")), {
    date: "2026-10-28",
    time: "23:59",
  });
  assert.deepEqual(beirutClock(new Date("2026-10-28T22:00:00Z")), {
    date: "2026-10-29",
    time: "00:00",
  });
  assert.equal(
    beirutClock(new Date("2026-07-01T21:00:00Z")).date,
    "2026-07-02",
  );
});
test("today is bookable before start and during session, but exact end and past dates reject", () => {
  const s = { date: "2026-10-28", startTime: "09:00", endTime: "11:00" };
  for (const at of [
    "2026-10-28T06:59:59Z",
    "2026-10-28T07:00:00Z",
    "2026-10-28T08:59:59Z",
  ])
    assert.doesNotThrow(() => assertBookableTime(s, new Date(at)));
  for (const at of ["2026-10-28T09:00:00Z", "2026-10-28T22:00:00Z"])
    assert.throws(() => assertBookableTime(s, new Date(at)), {
      code: "booking_ended",
    });
  assert.doesNotThrow(() =>
    assertBookableTime(
      { ...s, date: "2028-10-28" },
      new Date("2026-10-28T09:00:00Z"),
    ),
  );
});
test("published recurrence, scoped future changes and dated replacement resolve; limits overlay without draft hours leaking", () => {
  const data = {
    sessions: [{ ...session, capacity: null, startTime: "10:00" }],
    exceptions: [],
  };
  const first = resolveBookingSessions([event], data, "2026-11-02");
  assert.equal(first[0].startTime, "09:00");
  assert.equal(first[0].capacity, null);
  assert.equal(
    first[0].id,
    datedSessionId("2026-11-02", "clinic:one", "session:one"),
  );
  const future = {
    ...event,
    id: "publication:2",
    sequence: 2,
    effectiveFrom: "2026-11-03",
    sessions: [],
    exceptions: [
      {
        date: "2026-11-09",
        scopeId: "clinic:one",
        closed: false,
        sessions: [{ ...session, id: "session:date", capacity: 7 }],
      },
    ],
  };
  assert.equal(
    resolveBookingSessions([event, future], data, "2026-11-02").length,
    1,
  );
  assert.equal(
    resolveBookingSessions([event, future], data, "2026-11-09")[0].capacity,
    7,
  );
  assert.equal(
    resolveBookingSessions([event, future], data, "2026-11-16").length,
    0,
  );
  assert.equal(resolveBookingSessions([], data, "2026-11-02").length, 0);
});
