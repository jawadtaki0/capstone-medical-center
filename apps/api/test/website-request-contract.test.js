import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beirutEnd,
  intakeInput,
  publicRequest,
} from "../../../shared/website-request-contract.mjs";
import { createPublicIntake } from "../src/website-requests.js";
test("Beirut deadline and privacy projection never depend on machine timezone", () => {
  assert.equal(
    beirutEnd("2026-11-02", "11:00").toISOString(),
    "2026-11-02T09:00:00.000Z",
  );
  const p = publicRequest(
    {
      reference: "WR-SYNTHETIC",
      status: "awaiting",
      selection: {
        professionalName: "Dr. Synthetic",
        kind: "doctor",
        date: "2026-11-02",
        startTime: "09:00",
        endTime: "11:00",
      },
      language: "ar",
      endsAt: new Date("2026-11-02T09:00Z"),
      events: [],
      patient: { motherFirstName: "PRIVATE" },
      notes: "PRIVATE",
    },
    new Date("2026-11-02T09:00Z"),
  );
  assert.equal(p.windowEnded, true);
  assert.equal(JSON.stringify(p).includes("PRIVATE"), false);
});
test("strict intake does not accept arbitrary fields or weak retry authority", () => {
  assert.throws(() => intakeInput({ submissionKey: "short" }, "2026-10-28"));
});

test("hosted tracking can explicitly disable the localhost-only marker without widening its public projection", () => {
  const record = {
    reference: "WR-SYNTHETIC",
    status: "confirmed",
    bookingReference: "B-SYNTHETIC",
    language: "en",
    endsAt: new Date("2026-11-02T09:00Z"),
    selection: {
      professionalName: "Dr. Synthetic",
      kind: "doctor",
      date: "2026-11-02",
      startTime: "09:00",
      endTime: "11:00",
      capacity: 6,
    },
    patient: {
      firstName: "PRIVATE",
      motherFirstName: "PRIVATE",
      dateOfBirth: "PRIVATE",
      phone: "PRIVATE",
      gender: "PRIVATE",
    },
    notes: "PRIVATE",
    duplicateMatches: ["PRIVATE"],
    tokenEnvelope: "PRIVATE",
    events: [
      {
        status: "confirmed",
        at: "2026-10-29T12:00:00Z",
        privateNotes: "PRIVATE",
      },
    ],
  };
  const now = new Date("2026-10-29T12:00Z");
  const local = publicRequest(record, now);
  const hosted = publicRequest(record, now, { localReviewOnly: false });
  assert.equal(local.localReviewOnly, true);
  assert.equal(hosted.localReviewOnly, false);
  assert.deepEqual(Object.keys(local), Object.keys(hosted));
  assert.deepEqual({ ...local, localReviewOnly: false }, hosted);
  assert(!JSON.stringify(hosted).includes("PRIVATE"));
  assert.equal(hosted.capacity, undefined);
  assert.throws(() => publicRequest(record, now, { localReviewOnly: "false" }));
});

test("intake tracking carries only the explicit hosting flag; omitted local option remains true", async () => {
  const clock = () => new Date("2026-10-29T12:00Z"),
    record = {
      reference: "WR-SYNTHETIC",
      status: "awaiting",
      selection: {
        professionalName: "Dr. Synthetic",
        kind: "doctor",
        date: "2026-11-02",
        startTime: "09:00",
        endTime: "11:00",
      },
      language: "ar",
      endsAt: new Date("2026-11-02T09:00Z"),
      expiresAt: new Date("2026-12-02T09:00Z"),
      events: [],
      patient: { motherFirstName: "PRIVATE" },
      notes: "PRIVATE",
    };
  const options = {
    db: {
      collection: () => ({
        findOne: async () => record,
        findOneAndUpdate: async () => ({ count: 1 }),
      }),
    },
    client: {},
    key: Buffer.alloc(32, 1),
    clock,
    sessionReader: async () => [],
  };
  assert.equal(
    (await createPublicIntake(options).track("a".repeat(43), "synthetic"))
      .localReviewOnly,
    true,
  );
  const hosted = await createPublicIntake({
    ...options,
    localReviewOnly: false,
  }).track("a".repeat(43), "synthetic");
  assert.equal(hosted.localReviewOnly, false);
  assert(!JSON.stringify(hosted).includes("PRIVATE"));
  assert.throws(() =>
    createPublicIntake({ ...options, localReviewOnly: "false" }),
  );
});
