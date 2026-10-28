import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  seedPublicationAuthority,
  signInSynthetic,
} from "./helpers/publication-authority.js";
import { beirutClock } from "../src/booking-model.js";
import { buildDelivery } from "../../../shared/publication-contract.mjs";

let f, authority, admin, date;
const post = (action, token, body) =>
  f.request(`/bookings/${action}`, { method: "POST", token, body });
const good = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
  authority = await seedPublicationAuthority(f);
  admin = authority.admin;
  const current = new Date(`${beirutClock(f.clock()).date}T12:00:00Z`);
  current.setUTCDate(
    current.getUTCDate() + ((8 - current.getUTCDay()) % 7 || 7),
  );
  date = current.toISOString().slice(0, 10);
  good(await authority.publish(null));
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});
async function patient(index = 1) {
  index = String(index).replace(/[0-9]/g, (v) => "abcdefghij"[Number(v)]);
  const record = {
    firstName: `Synthetic${index}`,
    fatherName: "Father",
    lastName: `Booking${index}`,
    motherFirstName: "Mother",
    dateOfBirth: "2000-02-29",
    phone: "+96171123456",
    gender: "female",
  };
  const body = good(
    await f.request("/patients/check", {
      method: "POST",
      token: admin.token,
      body: { record },
    }),
  );
  return good(
    await f.request("/patients/create", {
      method: "POST",
      token: admin.token,
      body: {
        record,
        reviewDigest: body.reviewDigest,
        duplicateOverride: {
          acknowledged: true,
          reason: "Synthetic distinct booking patient",
        },
      },
    }),
  ).patient;
}
async function request(p, token = admin.token) {
  p ??= await patient();
  const input = {
    patientId: p.id,
    patientRevision: p.revision,
    date,
    scopeId: "clinic:synthetic",
    sourceSessionId: "session:synthetic",
  };
  const review = good(await post("review", token, input));
  return {
    ...input,
    sessionVersion: review.session.version,
    idempotencyKey: randomUUID(),
  };
}
async function limit(value) {
  const old = await f.db
    .collection("operational_session_drafts")
    .findOne({ id: "session:synthetic" });
  const { _id, revision, ...record } = old;
  return authority.post("save", {
    type: "sessions",
    record: { ...record, capacity: value },
    expectedRevision: revision,
  });
}
test("Admin and explicitly assigned Receptionist can confirm/cancel; other roles and mixed-role non-grants cannot", async () => {
  for (const [roles, assigned, allowed] of [
    [["Receptionist"], false, false],
    [["Receptionist"], true, true],
    [["Clinic Admin"], true, false],
    [["Lab Admin"], true, false],
    [["Clinic Admin", "Receptionist"], true, true],
    [["Lab Admin", "Receptionist"], false, false],
  ]) {
    const user = await signInSynthetic(f, roles);
    if (assigned)
      await f.db.collection("operational_grants").insertOne({
        _id: user.id,
        id: user.id,
        scopeIds: ["clinic:synthetic"],
        revision: 1,
      });
    const input = await request(await patient(randomUUID().slice(0, 4)));
    const result = await post("confirm", user.token, input);
    assert.equal(result.status, allowed ? 200 : 403);
    if (allowed)
      good(
        await post("cancel", user.token, {
          bookingId: result.body.booking.id,
          reason: "Synthetic cancellation",
        }),
      );
  }
  const input = await request();
  assert.equal((await post("confirm", undefined, input)).status, 401);
  assert.equal(
    (await post("confirm", admin.token, { ...input, capacity: 99 })).status,
    400,
  );
});
test("latest committed publication, immediate nullable/manual limit and no receiver dependency", async () => {
  good(await limit(null));
  const input = await request();
  assert.equal(
    (await post("confirm", admin.token, input)).body.error.code,
    "booking_limit_unset",
  );
  good(await limit(3));
  const fresh = await request();
  good(await post("confirm", admin.token, fresh));
  assert.equal(
    await f.db.collection("public_accepted_publications").countDocuments(),
    0,
  );
  const sessions = good(await post("sessions", admin.token, { date })).sessions;
  assert.equal(sessions[0].capacity, 3);
  assert.equal(sessions[0].remaining, 2);
  assert.equal(
    (
      await post("confirm", admin.token, {
        ...input,
        idempotencyKey: randomUUID(),
      })
    ).body.error.code,
    "booking_stale",
  );
});
test("last-place and same-patient races have one winner; retry and changed-payload conflicts preserve numbering", async () => {
  good(await limit(1));
  const a = await request(await patient(1)),
    b = await request(await patient(2));
  const results = await Promise.all([
    post("confirm", admin.token, a),
    post("confirm", admin.token, b),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? a : b;
  const first = results.find((r) => r.status === 200).body.booking;
  const repeats = await Promise.all([
    post("confirm", admin.token, winner),
    post("confirm", admin.token, winner),
  ]);
  for (const r of repeats)
    assert.equal(good(r).booking.bookingNumber, first.bookingNumber);
  assert.equal(
    (
      await post("confirm", admin.token, {
        ...winner,
        patientId: winner === a ? b.patientId : a.patientId,
      })
    ).body.error.code,
    "booking_idempotency",
  );
  assert.equal(await f.db.collection("bookings").countDocuments(), 1);
  assert.equal(await f.db.collection("booking_changes").countDocuments(), 1);
  good(await limit(3));
  const duplicate = await request({ id: winner.patientId, revision: 1 });
  const raced = await Promise.all([
    post("confirm", admin.token, duplicate),
    post("confirm", admin.token, {
      ...duplicate,
      idempotencyKey: randomUUID(),
    }),
  ]);
  for (const r of raced) assert.equal(r.body.error.code, "booking_duplicate");
});
test("cancellation releases once; retry-safe confirmation after cancellation returns original; rebooking uses a new number", async () => {
  const input = await request(),
    first = good(await post("confirm", admin.token, input)).booking;
  const cancels = await Promise.all([
    post("cancel", admin.token, {
      bookingId: first.id,
      reason: "Patient requested cancellation",
    }),
    post("cancel", admin.token, {
      bookingId: first.id,
      reason: "Repeated cancellation",
    }),
  ]);
  for (const c of cancels) assert.equal(good(c).booking.status, "cancelled");
  assert.equal(
    await f.db
      .collection("booking_changes")
      .countDocuments({ action: "cancelled" }),
    1,
  );
  assert.equal(
    good(await post("confirm", admin.token, input)).booking.status,
    "cancelled",
  );
  const second = good(
    await post("confirm", admin.token, {
      ...input,
      idempotencyKey: randomUUID(),
    }),
  ).booking;
  assert.notEqual(second.bookingNumber, first.bookingNumber);
  assert.equal(
    good(await post("sessions", admin.token, { date })).sessions[0].remaining,
    3,
  );
});
test("limit reduction and confirmation serialize and cannot leave confirmed count above limit", async () => {
  good(await limit(1));
  const input = await request();
  const results = await Promise.all([
    post("confirm", admin.token, input),
    limit(null),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  const count = await f.db
    .collection("bookings")
    .countDocuments({ status: "confirmed" });
  const session = good(await post("sessions", admin.token, { date }))
    .sessions[0];
  assert.ok(count === 0 || session.capacity >= count);
});
test("draft changes remain allowed; incompatible publication blocked, harmless names allowed, affected bookings scoped", async () => {
  const input = await request(),
    booking = good(await post("confirm", admin.token, input)).booking;
  const old = await f.db
    .collection("operational_session_drafts")
    .findOne({ id: "session:synthetic" });
  const { _id, revision, ...record } = old;
  good(
    await authority.post("save", {
      type: "sessions",
      record: { ...record, startTime: "10:00" },
      expectedRevision: revision,
    }),
  );
  assert.equal(
    (await authority.publish(date)).body.error.code,
    "booking_conflict",
  );
  assert.equal(
    await f.db.collection("operational_publications").countDocuments(),
    1,
  );
  const clinicAdmin = await signInSynthetic(f, ["Clinic Admin"]);
  await f.db.collection("operational_grants").insertOne({
    _id: clinicAdmin.id,
    id: clinicAdmin.id,
    scopeIds: ["clinic:synthetic"],
    revision: 1,
  });
  const affected = good(await post("affected", clinicAdmin.token, {}));
  assert.equal(affected.bookings[0].id, booking.id);
  assert.equal(affected.bookings[0].canCancel, false);
  good(
    await authority.post("save", {
      type: "sessions",
      record,
      expectedRevision: revision + 1,
    }),
  );
  const p = await f.db.collection("doctor_profile_drafts").findOne({});
  const { _id: pid, revision: pr, ...profile } = p;
  good(
    await authority.post("save", {
      type: "professionals",
      record: { ...profile, name: "Dr. Synthetic New Display" },
      expectedRevision: pr,
    }),
  );
  good(await authority.publish(date));
  good(
    await post("cancel", admin.token, {
      bookingId: booking.id,
      reason: "Synthetic publication review",
    }),
  );
  good(await limit(null));
});
test("future publication and dated closure reject only affected dates, while new dated session resolves", async () => {
  const input = await request();
  await authority.save("exceptions", {
    id: "date:closed",
    scopeId: "clinic:synthetic",
    date,
    closed: true,
    sessions: [],
  });
  good(await authority.publish(date));
  assert.equal(
    (await post("confirm", admin.token, input)).body.error.code,
    "booking_unavailable",
  );
  assert.equal(
    good(await post("sessions", admin.token, { date })).sessions.length,
    0,
  );
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 7);
  assert.equal(
    good(
      await post("sessions", admin.token, {
        date: next.toISOString().slice(0, 10),
      }),
    ).sessions.length,
    1,
  );
});
test("revoked clinic grants, disabled accounts and stale patient revisions deny writes", async () => {
  const user = await signInSynthetic(f, ["Receptionist"]);
  await f.db.collection("operational_grants").insertOne({
    _id: user.id,
    id: user.id,
    scopeIds: ["clinic:synthetic"],
    revision: 1,
  });
  const input = await request(await patient(), user.token);
  await f.db
    .collection("operational_grants")
    .updateOne({ _id: user.id }, { $set: { scopeIds: [] } });
  assert.equal((await post("confirm", user.token, input)).status, 403);
  await f.db
    .collection("accounts")
    .updateOne({ _id: user.id }, { $set: { status: "disabled" } });
  assert.equal((await post("confirm", user.token, input)).status, 401);
  await f.db
    .collection("patients")
    .updateOne({ _id: input.patientId }, { $inc: { revision: 1 } });
  assert.equal(
    (await post("confirm", admin.token, input)).body.error.code,
    "patient_stale",
  );
});
test("audit failure rolls back number and booking, reconnect preserves confirmed idempotency and data stays out of public delivery", async () => {
  const input = await request();
  await f.restart({ failAudit: true });
  assert.equal((await post("confirm", admin.token, input)).status, 503);
  assert.equal(await f.db.collection("bookings").countDocuments(), 0);
  assert.equal(await f.db.collection("booking_state").countDocuments(), 0);
  await f.restart({ reconnect: true });
  const first = good(await post("confirm", admin.token, input));
  await f.restart({ reconnect: true });
  assert.equal(
    good(await post("confirm", admin.token, input)).booking.id,
    first.booking.id,
  );
  const publication = await f.db
    .collection("operational_publications")
    .findOne({});
  const delivery = JSON.stringify(
    buildDelivery(`stream:${randomUUID()}`, [publication]),
  );
  assert.equal(delivery.includes(first.booking.patientId), false);
  assert.equal(delivery.includes(first.booking.bookingNumber), false);
  const audit = await f.db
    .collection("security_events")
    .findOne({ action: "booking_confirmed" });
  assert.equal(
    JSON.stringify(audit).includes(first.booking.patientName),
    false,
  );
});
test("concurrent first confirmations for one patient only admit once, including cancellation/confirmation races", async () => {
  const input = await request();
  const pair = await Promise.all([
    post("confirm", admin.token, input),
    post("confirm", admin.token, { ...input, idempotencyKey: randomUUID() }),
  ]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 409]);
  const b = pair.find((r) => r.status === 200).body.booking;
  await Promise.all([
    post("cancel", admin.token, {
      bookingId: b.id,
      reason: "Synthetic race cancellation",
    }),
    post("confirm", admin.token, { ...input, idempotencyKey: randomUUID() }),
  ]);
  assert.ok(
    (await f.db
      .collection("bookings")
      .countDocuments({ status: "confirmed", patientId: input.patientId })) <=
      1,
  );
  assert.equal(
    await f.db
      .collection("booking_changes")
      .countDocuments({ action: "cancelled" }),
    1,
  );
});
test("publication versus confirmation serializes; draft deactivation does not alter published availability", async () => {
  const input = await request();
  await authority.save("hours", { id: date, closed: true });
  const result = await Promise.all([
    post("confirm", admin.token, input),
    authority.publish(date),
  ]);
  assert.equal(result.filter((r) => r.status === 200).length, 1);
  const stored = await f.db
    .collection("bookings")
    .findOne({ status: "confirmed" });
  if (stored)
    assert.equal(
      good(await post("sessions", admin.token, { date })).sessions.length,
      1,
    );
  else
    assert.equal(
      good(await post("sessions", admin.token, { date })).sessions.length,
      0,
    );
});
test("same-day API exact end boundary is enforced by server time", async () => {
  const today = beirutClock(f.clock()).date,
    time = beirutClock(f.clock()).time;
  if (time < "01:00" || time > "22:00") {
    // Move this controlled TEST clock to the next Beirut morning, never host time.
    const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    f.advance(((24 * 60 - minute + 10 * 60) % (24 * 60)) * 60000);
  }
  const clock = beirutClock(f.clock());
  date = clock.date;
  const minute =
    Number(clock.time.slice(0, 2)) * 60 + Number(clock.time.slice(3));
  const fmt = (m) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const fresh = await signInSynthetic(f, ["Admin"]);
  admin = fresh;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  // Controlled synthetic committed schedule fixture; no normal records involved.
  await f.db.collection("operational_publications").updateOne(
    { id: "publication:1" },
    {
      $set: {
        sessions: [
          {
            id: "session:synthetic",
            scopeId: "clinic:synthetic",
            professionalId: "doctor:synthetic",
            weekday: day,
            startTime: fmt(minute - 1),
            endTime: fmt(minute + 1),
            capacity: 4,
            status: "active",
            appointmentRequired: false,
          },
        ],
        hours: Array.from({ length: 7 }, (_, d) => ({
          id: String(d),
          closed: false,
          startTime: "00:00",
          endTime: "23:59",
        })),
      },
    },
  );
  const input = await request();
  good(await post("confirm", admin.token, input));
  f.advance(60000);
  assert.equal(
    (await post("confirm", admin.token, await requestForEnded(input))).body
      .error.code,
    "booking_ended",
  );
});
async function requestForEnded(input) {
  return {
    ...input,
    patientId: (await patient("Other")).id,
    idempotencyKey: randomUUID(),
  };
}
test("overlapping patient bookings warn but do not block; service scopes and forged destinations never book", async () => {
  const firstInput = await request(),
    first = good(await post("confirm", admin.token, firstInput)).booking;
  await authority.save("professionals", {
    ...authority.profile,
    id: "doctor:other",
    name: "Dr. Synthetic Other",
  });
  await authority.save("sessions", {
    id: "session:other",
    scopeId: "clinic:synthetic",
    professionalId: "doctor:other",
    weekday: 1,
    startTime: "10:00",
    endTime: "12:00",
    capacity: 3,
    status: "active",
    appointmentRequired: true,
  });
  good(await authority.publish(date));
  const input = {
    patientId: firstInput.patientId,
    patientRevision: 1,
    date,
    scopeId: "clinic:synthetic",
    sourceSessionId: "session:other",
  };
  const review = good(await post("review", admin.token, input));
  assert.equal(review.overlaps[0].id, first.id);
  good(
    await post("confirm", admin.token, {
      ...input,
      sessionVersion: review.session.version,
      idempotencyKey: randomUUID(),
    }),
  );
  await authority.save("scopes", {
    id: "service:lab",
    name: "Synthetic laboratory",
    kind: "service",
    active: true,
  });
  assert.equal(
    (
      await post("confirm", admin.token, {
        ...firstInput,
        scopeId: "service:lab",
        idempotencyKey: randomUUID(),
      })
    ).status,
    403,
  );
  const lab = await signInSynthetic(f, ["Lab Admin"]);
  await f.db.collection("operational_grants").insertOne({
    _id: lab.id,
    id: lab.id,
    scopeIds: ["service:lab", "clinic:synthetic"],
    revision: 1,
  });
  assert.equal((await post("sessions", lab.token, { date })).status, 403);
});
test("explicit dated limit is immediate, null does not inherit, and removing a private replacement cannot resurrect an old limit", async () => {
  const recurring = await f.db
    .collection("operational_session_drafts")
    .findOne({ id: "session:synthetic" });
  const { _id, revision, ...s } = recurring;
  await authority.save("exceptions", {
    id: "date:limit",
    date,
    scopeId: s.scopeId,
    closed: false,
    sessions: [{ ...s, capacity: null }],
  });
  assert.equal(
    good(await post("sessions", admin.token, { date })).sessions[0].capacity,
    null,
  );
  await authority.save(
    "exceptions",
    {
      id: "date:limit",
      date,
      scopeId: s.scopeId,
      closed: false,
      sessions: [{ ...s, capacity: 3 }],
    },
    1,
  );
  good(await authority.publish(date));
  const input = await request();
  good(await post("confirm", admin.token, input));
  await authority.save(
    "exceptions",
    { id: "date:limit", date, scopeId: s.scopeId, closed: true, sessions: [] },
    2,
  );
  assert.equal(
    good(await post("sessions", admin.token, { date })).sessions[0].capacity,
    3,
  );
  assert.equal(
    (await authority.publish(date)).body.error.code,
    "booking_conflict",
  );
  const before = await f.db.collection("booking_limits").findOne({ date });
  const reduction = await authority.post("save", {
    type: "exceptions",
    expectedRevision: 3,
    record: {
      id: "date:limit",
      date,
      scopeId: s.scopeId,
      closed: false,
      sessions: [{ ...s, capacity: null }],
    },
  });
  assert.equal(reduction.body.error.code, "booking_conflict");
  assert.deepEqual(
    await f.db.collection("booking_limits").findOne({ date }),
    before,
  );
});
test("publication rejects removal, closure, restriction changes and professional deactivation but unrelated dates remain publishable", async () => {
  good(await post("confirm", admin.token, await request()));
  const doc = await f.db
    .collection("operational_session_drafts")
    .findOne({ id: "session:synthetic" });
  const { _id, revision, ...original } = doc;
  await authority.save(
    "sessions",
    { ...original, appointmentRequired: true },
    revision,
  );
  assert.equal(
    (await authority.publish(date)).body.error.code,
    "booking_conflict",
  );
  await authority.save("sessions", original, revision + 1);
  await authority.save("exceptions", {
    id: "date:blocked",
    date,
    scopeId: original.scopeId,
    closed: true,
    sessions: [],
  });
  assert.equal(
    (await authority.publish(date)).body.error.code,
    "booking_conflict",
  );
  await authority.save(
    "exceptions",
    {
      id: "date:blocked",
      date,
      scopeId: original.scopeId,
      closed: false,
      sessions: [original],
    },
    1,
  );
  good(await authority.publish(date));
  const other = new Date(`${date}T12:00:00Z`);
  other.setUTCDate(other.getUTCDate() + 7);
  await authority.save("exceptions", {
    id: "date:unrelated",
    date: other.toISOString().slice(0, 10),
    scopeId: original.scopeId,
    closed: true,
    sessions: [],
  });
  good(await authority.publish(date));
  await authority.save("hours", { id: date, closed: true });
  assert.equal(
    (await authority.publish(date)).body.error.code,
    "booking_conflict",
  );
  await authority.save(
    "hours",
    { id: date, closed: false, startTime: "08:00", endTime: "17:00" },
    1,
  );
  await authority.save(
    "professionals",
    { ...authority.profile, active: false },
    1,
  );
  await authority.save(
    "sessions",
    { ...original, status: "cancelled" },
    revision + 2,
  );
  await authority.save(
    "exceptions",
    {
      id: "date:blocked",
      date,
      scopeId: original.scopeId,
      closed: false,
      sessions: [{ ...original, status: "cancelled" }],
    },
    2,
  );
  assert.equal(
    (await authority.publish(date)).body.error.code,
    "booking_conflict",
  );
  assert.equal(
    await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
    1,
  );
});
