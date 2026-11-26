import test from "node:test";
import assert from "node:assert/strict";
import { createBookingRun } from "../src/lib/assistantBooking.js";

const session = {
  date: "2026-11-30",
  scopeId: "clinic:synthetic",
  sourceSessionId: "session:synthetic",
  version: "a".repeat(64),
};
const existing = { id: "patient-1", revision: 3 };
const record = { firstName: "Sami", lastName: "Haddad" };
function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    createPatient: async (input) => {
      calls.push(["createPatient", input]);
      return { patient: { id: "patient-new", revision: 1 } };
    },
    confirmBooking: async (input) => {
      calls.push(["confirmBooking", input]);
      return { booking: { bookingNumber: "B-00000001" } };
    },
    ...overrides,
  };
  return { api, calls };
}

test("preparing a confirmation writes nothing", () => {
  const { api, calls } = fakeApi();
  createBookingRun({ api, session, patient: existing });
  assert.equal(calls.length, 0);
});

test("one confirmation books the selected patient and session once", async () => {
  const { api, calls } = fakeApi();
  const run = createBookingRun({ api, session, patient: existing });
  const [first, second] = await Promise.all([run.confirm(), run.confirm()]);
  assert.equal(first.booking.bookingNumber, "B-00000001");
  assert.deepEqual(second, first);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["confirmBooking"],
  );
  assert.deepEqual(calls[0][1], {
    patientId: "patient-1",
    patientRevision: 3,
    date: "2026-11-30",
    scopeId: "clinic:synthetic",
    sourceSessionId: "session:synthetic",
    sessionVersion: "a".repeat(64),
    idempotencyKey: calls[0][1].idempotencyKey,
    noticeLanguage: "en",
  });
});

test("a new patient is registered once, even when booking is retried", async () => {
  let attempts = 0;
  const { api, calls } = fakeApi();
  const book = api.confirmBooking;
  api.confirmBooking = async (input) => {
    if (++attempts === 1) {
      calls.push(["confirmBooking", input]);
      throw Object.assign(new Error("This session is full."), {
        code: "booking_full",
      });
    }
    return book(input);
  };
  const run = createBookingRun({
    api,
    session,
    registration: { record, reviewDigest: "digest" },
  });
  await assert.rejects(run.confirm(), (error) => {
    assert.equal(error.patientSaved.id, "patient-new");
    assert.equal(error.code, "booking_full");
    return true;
  });
  await run.confirm();
  assert.deepEqual(
    calls.map(([name]) => name),
    ["createPatient", "confirmBooking", "confirmBooking"],
  );
  assert.equal(calls[1][1].idempotencyKey, calls[2][1].idempotencyKey);
});

test("a changed duplicate review stops before any booking", async () => {
  const { api, calls } = fakeApi({
    createPatient: async () => ({ reviewRequired: true, candidates: [{}] }),
  });
  const run = createBookingRun({
    api,
    session,
    registration: { record, reviewDigest: "old" },
  });
  const result = await run.confirm();
  assert.equal(result.reviewRequired, true);
  assert.equal(calls.length, 0);
});
