import test from "node:test";
import assert from "node:assert/strict";
import { createPublicIntake } from "../src/website-requests.js";
import { intakeInput } from "../../../shared/website-request-contract.mjs";
import {
  digest,
  requestCrypto,
} from "../../../shared/website-request-security.mjs";

for (const [label, owner, status, show] of [
  ["eligible guest", undefined, "awaiting", true],
  [
    "signed in",
    { accountId: "synthetic-holder", profileId: "synthetic-profile" },
    "awaiting",
    false,
  ],
  ["cancelled guest", undefined, "cancelled_by_patient", false],
])
  test("receipt link for " + label, async () => {
    const clock = () => new Date("2026-12-05T06:00Z");
    const input = {
      submissionKey: "b".repeat(43),
      honeypot: "",
      selection: {
        date: "2026-12-05",
        professionalId: "fixture",
        sourceSessionId: "fixture",
        startTime: "11:00",
        endTime: "12:00",
      },
      patient: {
        firstName: "Synthetic",
        fatherName: "Fixture",
        lastName: "Guest",
        motherFirstName: "Review",
        dateOfBirth: "2000-02-29",
        phone: "+12025550123",
        gender: "female",
        preferredLanguage: "en",
      },
    };
    const v = intakeInput(input, "2026-12-05");
    const key = Buffer.alloc(32, 11),
      crypto = requestCrypto(key);
    const _id = digest(input.submissionKey);
    const row = {
      _id,
      owner,
      status,
      generation: 1,
      selection: v.selection,
      reference: "WR-1111111111111111",
      expiresAt: new Date("2027-01-04T10:00Z"),
      submissionDigest: crypto.source(
        digest({
          selection: v.selection,
          patient: v.patient,
          ...(owner ? { owner } : {}),
        }),
      ),
      tokenEnvelope: crypto.seal({ token: "t".repeat(43) }, _id + ":1"),
    };
    const db = {
      collection: (name) =>
        name === "website_requests"
          ? { findOne: async () => row }
          : { findOneAndUpdate: async () => ({ count: 1 }) },
    };
    const client = {
      startSession: () => ({
        withTransaction: (fn) => fn(),
        endSession: async () => {},
      }),
    };
    const intake = createPublicIntake({
      db,
      client,
      key,
      clock,
      sessionReader: async () => [],
    });
    const receipt = await intake.submit(input, "synthetic-source", owner);
    if (show)
      assert.match(
        receipt.cancellationLink,
        /^\/cancel#[a-f0-9]{64}\.\d{13}\.[a-f0-9]{64}$/u,
      );
    else assert.equal(receipt.cancellationLink, undefined);
  });
