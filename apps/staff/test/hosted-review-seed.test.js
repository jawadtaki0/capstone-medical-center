import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareHostedReviewSeed,
  assertHostedSeedLedger,
  seedHostedReview,
} from "../scripts/hosted-review-seed.js";

function source() {
  const professionals = Array.from({ length: 19 }, (_, i) => ({
    id: `doctor:synthetic-${i}`,
    name: `Synthetic Doctor ${i}`,
    specialty: "Synthetic specialty",
    kind: "doctor",
    gender: i % 2 ? "female" : "male",
    active: true,
    scopeIds: ["clinic:synthetic"],
    revision: 9,
    privateExtra: "must not copy",
  }));
  const sessions = Array.from({ length: 34 }, (_, i) => ({
    id: `session:synthetic-${i}`,
    scopeId: "clinic:synthetic",
    professionalId: professionals[i % 19].id,
    weekday: i % 7,
    startTime: "09:00",
    endTime: "10:00",
    capacity: 99,
    status: "active",
    appointmentRequired: i < 9,
  }));
  return {
    schemaVersion: 1,
    sourceDigest: "a".repeat(64),
    reviewOnly: true,
    baseline: {
      scopes: [
        {
          id: "clinic:synthetic",
          name: "Synthetic Clinic",
          kind: "clinic",
          active: true,
        },
        {
          id: "service:synthetic-lab",
          name: "Synthetic Lab",
          kind: "service",
          active: true,
        },
        {
          id: "service:synthetic-audio",
          name: "Synthetic Audio",
          kind: "service",
          active: true,
        },
      ],
      professionals,
      sessions,
      exceptions: [],
      hours: Array.from({ length: 7 }, (_, day) => ({
        id: String(day),
        closed: false,
        startTime: "08:00",
        endTime: "17:00",
      })),
    },
  };
}
const limits = (s) => ({
  rows: s.baseline.sessions.map((r) => ({
    sessionId: r.id,
    professionalId: r.professionalId,
    weekday: r.weekday,
    startTime: r.startTime,
    endTime: r.endTime,
    appointmentRequired: r.appointmentRequired,
    capacity: 3,
  })),
});

test("review preparation preserves IDs/gender/flags and uses only exact approved private limits", () => {
  const s = source(),
    before = structuredClone(s);
  const p = prepareHostedReviewSeed(s, limits(s));
  assert.equal(p.records.professionals.length, 19);
  assert.equal(p.records.sessions.length, 34);
  assert.equal(
    p.records.sessions.filter((r) => r.appointmentRequired).length,
    9,
  );
  assert.ok(p.records.sessions.every((r) => r.capacity === 3));
  assert.equal(p.records.professionals[0].gender, "male");
  assert.equal(p.records.professionals[0].privateExtra, undefined);
  assert.equal(p.records.professionals[0].revision, undefined);
  assert.deepEqual(s, before);
});

test("missing/duplicate limits, changed windows or missing gender refuse rather than infer", () => {
  for (const variant of ["missing", "duplicate", "window", "gender"]) {
    const s = source(),
      l = limits(s);
    if (variant === "missing") l.rows.pop();
    if (variant === "duplicate") l.rows[1] = l.rows[0];
    if (variant === "window") l.rows[0].endTime = "11:00";
    if (variant === "gender") s.baseline.professionals[0].gender = "neutral";
    assert.throws(() => prepareHostedReviewSeed(s, l));
  }
});

test("service-only hours stay nonbookable with null capacity", () => {
  const s = source();
  s.baseline.sessions.push({
    id: "service:synthetic-hours",
    scopeId: "service:synthetic-lab",
    professionalId: null,
    weekday: 1,
    startTime: "09:00",
    endTime: "17:00",
    capacity: 99,
    status: "active",
    appointmentRequired: false,
  });
  const l = limits(s);
  l.rows.pop();
  assert.equal(
    prepareHostedReviewSeed(s, l).records.sessions.at(-1).capacity,
    null,
  );
});

test("completed matching seed can be reused without reseeding; incomplete or changed identity refuses", () => {
  const identity = {
    sourceDigest: "a".repeat(64),
    configDigest: "b".repeat(64),
    streamId: "stream:synthetic",
  };
  assert.equal(assertHostedSeedLedger(null, identity), false);
  assert.equal(
    assertHostedSeedLedger(
      { ...identity, version: 1, status: "complete" },
      identity,
    ),
    true,
  );
  for (const patch of [
    { status: "initializing" },
    { sourceDigest: "c".repeat(64) },
    { configDigest: "d".repeat(64) },
    { streamId: "other" },
  ])
    assert.throws(() =>
      assertHostedSeedLedger(
        { ...identity, version: 1, status: "complete", ...patch },
        identity,
      ),
    );
});

test("matching completed seed preserves later edits and never asks for credentials or API writes", async () => {
  const s = source();
  const identity = {
    sourceDigest: s.sourceDigest,
    configDigest: "b".repeat(64),
    streamId: "stream:synthetic",
  };
  let collections = 0;
  const fixture = {
    db: {
      collection(name) {
        collections++;
        assert.equal(name, "hosted_seed_state");
        return {
          findOne: async () => ({
            ...identity,
            version: 1,
            status: "complete",
          }),
        };
      },
    },
  };
  const result = await seedHostedReview(fixture, {
    source: s,
    approved: limits(s),
    identity,
    saveAccess: () => {
      throw new Error("must not rewrite access");
    },
  });
  assert.deepEqual(result, { reused: true });
  assert.equal(collections, 1);
});

test("interrupted seed refuses without resetting or starting account initialization", async () => {
  const s = source(),
    identity = {
      sourceDigest: s.sourceDigest,
      configDigest: "b".repeat(64),
      streamId: "stream:synthetic",
    };
  const fixture = {
    db: {
      collection(name) {
        assert.equal(name, "hosted_seed_state");
        return {
          findOne: async () => ({
            ...identity,
            version: 1,
            status: "initializing",
          }),
        };
      },
    },
  };
  await assert.rejects(
    seedHostedReview(fixture, { source: s, approved: limits(s), identity }),
    /reconciliation/,
  );
});
