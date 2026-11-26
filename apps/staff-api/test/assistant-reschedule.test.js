import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  seedPublicationAuthority,
  signInSynthetic,
} from "./helpers/publication-authority.js";
import { beirutClock } from "../src/booking-model.js";

let f, admin, patient, monday, nextMonday, current;
const post = (path, token, body) =>
  f.request(path, { method: "POST", token, body });
const good = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const addDays = (day, count) => {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
};
const sessionOn = async (date) =>
  good(await post("/bookings/sessions", admin.token, { date })).sessions[0];
async function register(first, last) {
  const record = {
    firstName: first,
    fatherName: "Father",
    lastName: last,
    motherFirstName: "Mother",
    dateOfBirth: "2000-02-29",
    phone: "+96171123456",
    gender: "female",
  };
  const check = good(await post("/patients/check", admin.token, { record }));
  return good(
    await post("/patients/create", admin.token, {
      record,
      reviewDigest: check.reviewDigest,
    }),
  ).patient;
}
async function book(p, date) {
  const s = await sessionOn(date);
  return good(
    await post("/bookings/confirm", admin.token, {
      patientId: p.id,
      patientRevision: p.revision,
      date,
      scopeId: s.scopeId,
      sourceSessionId: s.sourceSessionId,
      sessionVersion: s.version,
      idempotencyKey: randomUUID(),
    }),
  ).booking;
}
async function move(date, extra = {}) {
  const s = await sessionOn(date);
  return {
    bookingId: current.id,
    date,
    scopeId: s.scopeId,
    sourceSessionId: s.sourceSessionId,
    sessionVersion: s.version,
    idempotencyKey: randomUUID(),
    publicReason: "details_check",
    ...extra,
  };
}
const confirmed = () =>
  f.db.collection("bookings").find({ status: "confirmed" }).toArray();

before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
  const authority = await seedPublicationAuthority(f);
  admin = authority.admin;
  const day = beirutClock(f.clock()).date;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  monday = addDays(day, (8 - weekday) % 7 || 7);
  nextMonday = addDays(monday, 7);
  good(await authority.publish(null));
  patient = await register("Synthetic", "Mover");
  current = await book(patient, monday);
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});

test("reschedule moves the booking and releases the old place", async () => {
  const result = good(
    await post("/bookings/reschedule", admin.token, await move(nextMonday)),
  );
  assert.equal(result.booking.date, nextMonday);
  assert.equal(result.previous.status, "cancelled");
  const live = await confirmed();
  assert.deepEqual(
    live.map((b) => [b.patientId, b.date]),
    [[patient.id, nextMonday]],
  );
  assert.equal((await sessionOn(monday)).confirmed, 0);
});

test("a full or changed session keeps the old booking", async () => {
  const input = await move(nextMonday);
  const stale = await post("/bookings/reschedule", admin.token, {
    ...input,
    sessionVersion: "0".repeat(64),
  });
  assert.equal(stale.status, 409);
  const capacity = (await sessionOn(nextMonday)).capacity;
  for (let i = 0; i < capacity; i++)
    await book(
      await register("Synthetic", `Filler${"abcdefgh"[i]}`),
      nextMonday,
    );
  const full = await post(
    "/bookings/reschedule",
    admin.token,
    await move(nextMonday),
  );
  assert.equal(full.body.error.code, "booking_full");
  const old = await f.db.collection("bookings").findOne({ _id: current.id });
  assert.equal(old.status, "confirmed");
});

test("a repeated confirmation moves the booking only once", async () => {
  const input = await move(nextMonday);
  const first = good(await post("/bookings/reschedule", admin.token, input));
  const second = good(await post("/bookings/reschedule", admin.token, input));
  assert.equal(second.booking.id, first.booking.id);
  assert.equal(second.replayed, true);
  assert.equal((await confirmed()).length, 1);
  const again = await post("/bookings/reschedule", admin.token, {
    ...input,
    idempotencyKey: randomUUID(),
  });
  assert.equal(again.status, 409);
});

test("only booking roles with the clinic can reschedule or search", async () => {
  const input = await move(nextMonday);
  for (const roles of [["Receptionist"], ["Clinic Admin"], ["Lab Admin"]]) {
    const person = await signInSynthetic(f, roles);
    const denied = await post("/bookings/reschedule", person.token, input);
    assert.equal(denied.status, 403, roles[0]);
    const search = await post("/bookings/upcoming", person.token, {
      query: "Mover",
    });
    assert.equal(search.status, 403, roles[0]);
  }
  assert.equal((await confirmed())[0].date, monday);
});

test("upcoming search matches name or number and lists every match", async () => {
  await book(await register("Another", "Mover"), nextMonday);
  const find = async (query) =>
    good(await post("/bookings/upcoming", admin.token, { query })).bookings;
  assert.equal((await find("mover")).length, 2);
  assert.equal((await find("synthetic mover")).length, 1);
  assert.equal((await find(current.bookingNumber))[0].id, current.id);
  assert.equal((await find(patient.patientNumber))[0].id, current.id);
  assert.equal((await find("nobody")).length, 0);
  assert.equal((await find(".*")).length, 0);
});

test("asking to cancel or reschedule only opens a form", async () => {
  for (const [text, type] of [
    [`cancel the booking ${current.bookingNumber}`, "cancel"],
    [`reschedule the booking ${current.bookingNumber}`, "reschedule"],
  ]) {
    const body = good(await post("/assistant/message", admin.token, { text }));
    assert.equal(body.task?.type, type, text);
    assert.equal(body.task.prefill.bookingNumber, current.bookingNumber);
  }
  assert.equal((await confirmed()).length, 1);
  const lab = await signInSynthetic(f, ["Lab Admin"]);
  const denied = good(
    await post("/assistant/message", lab.token, {
      text: `cancel the booking ${current.bookingNumber}`,
    }),
  );
  assert.equal(denied.task, undefined);
});
