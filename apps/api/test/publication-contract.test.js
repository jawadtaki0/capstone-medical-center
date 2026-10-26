import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDelivery,
  validateDelivery,
  payloadDigest,
} from "../../../shared/publication-contract.mjs";
import { publicationEvent } from "../../../shared/test-fixtures/publication.mjs";
import { composePublications } from "../../../shared/published-timeline.mjs";

test("version two preserves one undated baseline before scoped dated changes", () => {
  const baseline = publicationEvent(1, null);
  baseline.professionals[0].gender = "male";
  const future = publicationEvent(2, "2026-11-01");
  future.professionals[0].gender = "male";
  future.professionals[0].name = "Dr. Synthetic Future";
  const delivery = buildDelivery("stream:synthetic", [baseline, future]);
  assert.equal(delivery.schemaVersion, 2);
  assert.equal(
    composePublications(delivery.events, "2000-01-01").professionals[0].name,
    baseline.professionals[0].name,
  );
  assert.equal(
    composePublications(delivery.events, "2026-11-01").professionals[0].name,
    "Dr. Synthetic Future",
  );
  const invalid = structuredClone(delivery);
  invalid.events[1].effectiveFrom = null;
  assert.throws(() => validateDelivery(invalid));
  invalid.events[1].effectiveFrom = "2026-11-01";
  invalid.schemaVersion = 1;
  assert.throws(() => validateDelivery(invalid));
});

test("published wire projection excludes revisions, capacity, credentials, grants and private fields at every level", () => {
  const event = publicationEvent();
  event.staffContacts = "private";
  event.professionals[0].passwordHash = "private";
  event.sessions[0].patientId = "private";
  const payload = buildDelivery("stream:synthetic", [event]);
  assert.equal(validateDelivery(payload), payload);
  const serialized = JSON.stringify(payload);
  for (const field of [
    "private",
    "revision",
    "capacity",
    "gender",
    "passwordHash",
    "patientId",
    "staffContacts",
  ])
    assert.equal(serialized.includes(field), false, field);
  assert.equal(payload.events[0].professionals[0].id, "doctor:synthetic");
});
test("wire validator rejects extra fields, incomplete timeline, broken references, dates and oversized input", () => {
  const base = buildDelivery("stream:synthetic", [publicationEvent()]);
  for (const mutate of [
    (p) => {
      p.grants = [];
    },
    (p) => {
      p.sequence = 2;
    },
    (p) => {
      p.events[0].professionals[0].email = "private@example.com";
    },
    (p) => {
      p.events[0].sessions[0].professionalId = "doctor:missing";
    },
    (p) => {
      p.events[0].effectiveFrom = "2026-02-30";
    },
    (p) => {
      p.events[0].hours = [];
    },
  ]) {
    const payload = structuredClone(base);
    mutate(payload);
    assert.throws(() => validateDelivery(payload));
  }
  assert.throws(() => validateDelivery(base, 2));
});
test("ordering uses complete publication sequences, not effective dates; digest is stable across object-key order", () => {
  const first = publicationEvent(),
    next = publicationEvent(2, "2026-11-01");
  const payload = buildDelivery("stream:synthetic", [first, next]);
  assert.equal(payload.sequence, 2);
  assert.equal(
    payloadDigest(payload),
    payloadDigest({
      events: payload.events,
      sequence: 2,
      streamId: payload.streamId,
      schemaVersion: 1,
    }),
  );
  const duplicate = structuredClone(payload);
  duplicate.events[1].sequence = 1;
  assert.throws(() => validateDelivery(duplicate));
});
