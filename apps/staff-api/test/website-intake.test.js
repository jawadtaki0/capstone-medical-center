import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  createPublicIntake,
  ensureIntakeIndexes,
  PUBLIC_INTAKE_COLLECTIONS,
} from "../../api/src/website-requests.js";
import {
  randomToken,
  digest,
} from "../../../shared/website-request-security.mjs";
let f, api;
const key = randomBytes(32);
const selection = {
  date: "2027-11-01",
  scopeId: "clinic:synthetic",
  sourceSessionId: "session:synthetic",
  professionalId: "doctor:synthetic",
  professionalName: "Dr. Synthetic",
  specialty: "Dentistry",
  kind: "doctor",
  startTime: "09:00",
  endTime: "11:00",
  appointmentRequired: true,
};
const patient = {
  firstName: "Synthetic",
  fatherName: "Father",
  lastName: "Intake",
  motherFirstName: "Mother",
  dateOfBirth: "2000-02-29",
  phone: "+96171123456",
  gender: "female",
  preferredLanguage: "ar",
};
const input = () => ({
  submissionKey: randomToken(),
  selection: {
    date: selection.date,
    sourceSessionId: selection.sourceSessionId,
    professionalId: selection.professionalId,
  },
  patient: { ...patient },
  honeypot: "",
});
before(async () => {
  f = await createSecurityFixture();
  await ensureIntakeIndexes(f.db);
});
beforeEach(async () => {
  await f.reset();
  for (const c of PUBLIC_INTAKE_COLLECTIONS)
    await f.db.collection(c).deleteMany({});
  api = createPublicIntake({
    db: f.db,
    client: f.client,
    key,
    sessionReader: async () => [selection],
    clock: f.clock,
  });
});
after(async () => {
  if (f) {
    for (const c of PUBLIC_INTAKE_COLLECTIONS)
      await f.db.collection(c).deleteMany({});
    await f.reset();
    await f.close();
  }
});
test("durable public intake needs no Cedar; concurrent retry returns exact receipt without duplicate records", async () => {
  const v = input();
  const out = await Promise.all(
    Array.from({ length: 4 }, () => api.submit(v, "source")),
  );
  assert.equal(new Set(out.map((r) => r.requestId)).size, 1);
  assert.equal(new Set(out.map((r) => r.trackingToken)).size, 1);
  assert.equal(await f.db.collection("website_requests").countDocuments({}), 1);
  const row = await f.db.collection("website_requests").findOne({});
  assert.equal(JSON.stringify(row).includes(out[0].trackingToken), false);
  const tracking = await api.track(out[0].trackingToken, "read");
  for (const s of [patient.phone, patient.dateOfBirth, patient.motherFirstName])
    assert.equal(JSON.stringify(tracking).includes(s), false);
  assert.equal((await api.pull(0)).requests.length, 1);
  await assert.rejects(
    api.submit({ ...v, patient: { ...patient, firstName: "Other" } }, "source"),
    { code: "request_retry_conflict" },
  );
});
test("validation/honeypot and persistent source counters do not treat family phone as identity", async () => {
  await assert.rejects(api.submit({ ...input(), honeypot: "bot" }, "bot"));
  for (let i = 0; i < 5; i++) await api.submit(input(), `source${i}`);
  assert.equal(
    (await api.pull()).requests.filter((r) => r.phoneReview).length,
    1,
  );
  for (let i = 0; i < 10; i++) await api.submit(input(), "shared");
  await assert.rejects(api.submit(input(), "shared"), {
    code: "request_rate_limited",
  });
  const restarted = createPublicIntake({
    db: f.db,
    client: f.client,
    key,
    sessionReader: async () => [selection],
    clock: f.clock,
  });
  await assert.rejects(restarted.submit(input(), "shared"), {
    code: "request_rate_limited",
  });
  assert.equal(await f.db.collection("auth_throttles").countDocuments({}), 0);
});
test("ordered status acknowledgements, stale suppression, rotation one winner and old-token refusal", async () => {
  const original = input();
  const r = await api.submit(original, "source");
  const event = (sequence, status, reason = null) => {
    const v = {
      requestId: r.requestId,
      sequence,
      status,
      reason,
      bookingReference: "B-00000001",
      at: f.clock().toISOString(),
    };
    return { ...v, digest: digest(v) };
  };
  await api.accept(event(1, "confirmed"));
  await api.accept(event(2, "cancelled", "session_unavailable"));
  await api.accept(event(1, "confirmed"));
  assert.equal((await api.track(r.trackingToken, "read")).status, "cancelled");
  const rotate = { requestId: r.requestId, generation: 1, key: randomToken() };
  const out = await Promise.all([api.rotate(rotate), api.rotate(rotate)]);
  assert.deepEqual(out[0], out[1]);
  await assert.rejects(api.submit(original, "source"), {
    code: "request_link_replaced",
  });
  await assert.rejects(api.track(r.trackingToken, "read"));
  await assert.rejects(api.rotate({ ...rotate, key: randomToken() }), {
    code: "request_stale",
  });
});
test("expiry and explicit cleanup preserve tombstone and reject late resurrection", async () => {
  const r = await api.submit(input(), "source");
  const row = await f.db
    .collection("website_requests")
    .findOne({ _id: r.requestId });
  f.advance(row.expiresAt.getTime() - f.clock().getTime());
  await assert.rejects(api.track(r.trackingToken, "read"));
  assert.equal((await api.cleanup()).eligible, 1);
  assert.ok(
    (await f.db.collection("website_requests").findOne({ _id: r.requestId }))
      .patient,
  );
  await api.cleanup({ apply: true });
  const cleaned = await f.db
    .collection("website_requests")
    .findOne({ _id: r.requestId });
  assert.equal(cleaned.patient, undefined);
  assert.ok(cleaned.purgedAt);
  await assert.rejects(api.submit(input(), "source"));
  assert.equal(await f.db.collection("patients").countDocuments({}), 0);
});
