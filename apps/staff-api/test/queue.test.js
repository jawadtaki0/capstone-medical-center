import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  seedPublicationAuthority,
  signInSynthetic,
} from "./helpers/publication-authority.js";
import { beirutClock } from "../src/booking-model.js";

let f, authority, admin, date, selected;
const good = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const post = (action, body, token = admin.token) =>
  f.request(`/queue/${action}`, { method: "POST", token, body });
const bookingPost = (action, body, token = admin.token) =>
  f.request(`/bookings/${action}`, { method: "POST", token, body });
const selection = () => ({
  date,
  scopeId: selected.scopeId,
  sourceSessionId: selected.sourceSessionId,
  sessionVersion: selected.scheduleSignature,
});
before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
  const monday = new Date(`${beirutClock(f.clock()).date}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));
  date = monday.toISOString().slice(0, 10);
  // The next Monday's known winter offset; all business decisions still use the injected server clock.
  const start = new Date(`${date}T08:29:59+02:00`);
  f.advance(start - f.clock());
  authority = await seedPublicationAuthority(f);
  admin = authority.admin;
  good(await authority.publish(null));
  selected = good(await bookingPost("sessions", { date })).sessions[0];
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});
async function reserve(label = "One") {
  const record = {
    firstName: `Synthetic${label}`,
    fatherName: "Father",
    lastName: "Queue",
    motherFirstName: "Mother",
    dateOfBirth: "2000-02-29",
    phone: "+96171123456",
    gender: "female",
  };
  const review = good(
    await f.request("/patients/check", {
      method: "POST",
      token: admin.token,
      body: { record },
    }),
  );
  const p = good(
    await f.request("/patients/create", {
      method: "POST",
      token: admin.token,
      body: {
        record,
        reviewDigest: review.reviewDigest,
        duplicateOverride: {
          acknowledged: true,
          reason: "Distinct synthetic queue patient",
        },
      },
    }),
  ).patient;
  const input = {
    patientId: p.id,
    patientRevision: p.revision,
    date,
    scopeId: selected.scopeId,
    sourceSessionId: selected.sourceSessionId,
  };
  const s = good(await bookingPost("review", input)).session;
  return good(
    await bookingPost("confirm", {
      ...input,
      sessionVersion: s.version,
      idempotencyKey: randomUUID(),
    }),
  ).booking;
}
const checkin = (b, extra = {}) => ({
  ...selection(),
  bookingId: b.id,
  expectedRevision: 0,
  idempotencyKey: randomUUID(),
  ...extra,
});
async function assign(user, scopeIds = ["clinic:synthetic"]) {
  await f.db
    .collection("operational_grants")
    .insertOne({ _id: user.id, id: user.id, scopeIds, revision: 1 });
}

test("only current Admin, assigned Clinic Admin and clinic Receptionist can view/check in; ordinary booking permissions stay unchanged", async () => {
  const b = await reserve();
  f.advance(1000);
  for (const [roles, ids, allowed] of [
    [["Admin"], [], true],
    [["Clinic Admin"], ["clinic:synthetic"], true],
    [["Receptionist"], ["clinic:synthetic"], true],
    [["Clinic Admin"], [], false],
    [["Receptionist"], ["laboratory"], false],
    [["Lab Admin"], ["clinic:synthetic"], false],
    [["Lab Admin", "Receptionist"], [], false],
  ]) {
    const u = await signInSynthetic(f, roles);
    await assign(u, ids);
    for (const [action, input] of [
      ["sessions", { date }],
      ["list", selection()],
      ["checkIn", checkin(b)],
    ]) {
      assert.equal(
        (await post(action, input, u.token)).status,
        allowed ? 200 : 403,
        `${roles} ${action}`,
      );
    }
    if (roles.includes("Clinic Admin")) {
      assert.equal(
        (
          await bookingPost(
            "cancel",
            { bookingId: b.id, reason: "Not ordinary booking authority" },
            u.token,
          )
        ).status,
        403,
      );
    }
  }
  assert.equal(
    (await f.request("/queue/list", { method: "POST", body: selection() }))
      .status,
    401,
  );
  const r = await signInSynthetic(f, ["Receptionist"]);
  await assign(r);
  await f.db
    .collection("operational_grants")
    .updateOne({ _id: r.id }, { $set: { scopeIds: [] } });
  assert.equal((await post("checkIn", checkin(b), r.token)).status, 403);
  await f.db
    .collection("accounts")
    .updateOne(
      { _id: admin.id },
      { $set: { status: "disabled" }, $inc: { version: 1 } },
    );
  assert.equal((await post("checkIn", checkin(b))).status, 401);
});

test("server arrival order differs from booking order; same-key/cross-actor duplicates allocate once and bind the payload", async () => {
  const a = await reserve("First"),
    b = await reserve("Second"),
    c = await reserve("Third");
  await f.db
    .collection("bookings")
    .updateOne({ _id: b.id }, { $set: { source: "website" } });
  f.advance(1000);
  const u = await signInSynthetic(f, ["Receptionist"]);
  await assign(u);
  const input = checkin(b);
  const results = await Promise.all([
    post("checkIn", input),
    post("checkIn", input),
    post("checkIn", checkin(b), u.token),
  ]);
  for (const r of results) assert.equal(good(r).booking.queue.number, 1);
  f.advance(1);
  assert.equal(good(await post("checkIn", checkin(a))).booking.queue.number, 2);
  const list = good(await post("list", selection()));
  assert.deepEqual(
    list.bookings.filter((v) => v.queue).map((v) => v.id),
    [b.id, a.id],
  );
  assert.equal(list.bookings.find((v) => v.id === c.id).queue, null);
  assert.equal(list.bookings[0].status, "confirmed");
  assert.equal(list.bookings[0].type, "Website booking");
  assert.equal(list.bookings[1].type, "Phone booking");
  await f.db
    .collection("bookings")
    .updateOne({ _id: a.id }, { $unset: { source: "" } });
  assert.equal(
    good(await post("list", selection())).bookings.find((v) => v.id === a.id)
      .type,
    "Booking",
  );
  assert.equal(
    list.bookings[0].queue.checkedInAt,
    new Date(`${date}T08:30:00+02:00`).toISOString(),
  );
  assert.equal(list.bookings[1].queue.position, 2);
  assert.equal(
    (await post("checkIn", { ...input, bookingId: a.id })).body.error.code,
    "queue_idempotency",
  );
  assert.equal(await f.db.collection("queue_changes").countDocuments(), 2);
  assert.equal(
    good(await bookingPost("sessions", { date })).sessions[0].remaining,
    1,
  );
  assert.equal(
    (
      await bookingPost("cancel", {
        bookingId: b.id,
        reason: "Must not release arrival",
      })
    ).body.error.code,
    "booking_checked_in",
  );
  good(
    await bookingPost("cancel", { bookingId: c.id, reason: "Before arrival" }),
  );
  assert.equal(
    (await post("checkIn", checkin(c))).body.error.code,
    "queue_booking_ineligible",
  );
  assert.equal(
    good(await bookingPost("sessions", { date })).sessions[0].remaining,
    2,
  );
  await f.restart({ reconnect: true });
  assert.equal(good(await post("checkIn", input)).booking.queue.number, 1);
});

test("exact opening/closing and cross-midnight opening use server Beirut time; old sessions remain readable", async () => {
  const a = await reserve("Early"),
    b = await reserve("Late"),
    c = await reserve("Ended");
  assert.equal(
    (await post("checkIn", checkin(a))).body.error.code,
    "queue_closed",
  );
  f.advance(1000);
  const input = checkin(a);
  good(await post("checkIn", input));
  f.advance(new Date(`${date}T10:59:59.999+02:00`) - f.clock());
  const fresh = await signInSynthetic(f);
  good(await post("checkIn", checkin(b), fresh.token));
  f.advance(1);
  assert.equal(
    (await post("checkIn", checkin(c), fresh.token)).body.error.code,
    "queue_closed",
  );
  assert.equal(
    good(await post("checkIn", input, fresh.token)).booking.queue.number,
    1,
  );
  assert.equal(
    good(await post("sessions", { date }, fresh.token)).sessions[0]
      .checkInState,
    "ended",
  );
  assert.equal(
    good(await post("list", selection(), fresh.token)).bookings.filter(
      (v) => v.queue?.status === "waiting",
    ).length,
    2,
  );
});

test("strict/wrong/stale identity and revisions refuse writes; queue numbers and audit roll back on failure", async () => {
  const b = await reserve();
  f.advance(1000);
  const input = checkin(b);
  for (const change of [
    { date: "2026-02-30" },
    { sourceSessionId: "session:wrong" },
    { sessionVersion: "0".repeat(64) },
    { expectedRevision: 1 },
    { checkedInAt: f.clock().toISOString() },
  ]) {
    assert.ok((await post("checkIn", { ...input, ...change })).status >= 400);
  }
  const other = {
    ...b,
    _id: randomUUID(),
    id: randomUUID(),
    datedSessionId: "other",
    sourceSessionId: "session:other",
    bookingNumber: "B-99999999",
    patientId: randomUUID(),
    actorId: "synthetic:other",
    idempotencyKey: randomUUID(),
  };
  other.id = other._id;
  await f.db.collection("bookings").insertOne(other);
  assert.equal(
    (await post("checkIn", checkin(other))).body.error.code,
    "queue_booking_ineligible",
  );
  // Simulate a legacy booking whose captured schedule disagrees with current authority.
  await f.db
    .collection("bookings")
    .updateOne({ _id: b.id }, { $set: { scheduleSignature: "old" } });
  assert.equal(
    (await post("checkIn", input)).body.error.code,
    "queue_booking_ineligible",
  );
  await f.db
    .collection("bookings")
    .updateOne(
      { _id: b.id },
      { $set: { scheduleSignature: selected.scheduleSignature } },
    );
  await f.restart({ failAudit: true });
  assert.equal((await post("checkIn", input)).status, 503);
  assert.equal(
    (await f.db.collection("bookings").findOne({ _id: b.id })).queue,
    undefined,
  );
  assert.equal(await f.db.collection("queue_state").countDocuments(), 0);
  assert.equal(await f.db.collection("queue_receipts").countDocuments(), 0);
  assert.equal(await f.db.collection("queue_changes").countDocuments(), 0);
  await f.restart();
  assert.equal(good(await post("checkIn", input)).booking.queue.number, 1);
});

test("check-in/cancellation race has one winner and cannot free an arrived reservation", async () => {
  const b = await reserve();
  f.advance(1000);
  const results = await Promise.all([
    post("checkIn", checkin(b)),
    bookingPost("cancel", {
      bookingId: b.id,
      reason: "Concurrent cancellation",
    }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const current = await f.db.collection("bookings").findOne({ _id: b.id });
  assert.equal(Boolean(current.queue), current.status === "confirmed");
  assert.equal(
    await f.db.collection("queue_changes").countDocuments(),
    current.queue ? 1 : 0,
  );
});

test("different arrivals racing share one session counter; a missing counter never reuses a number", async () => {
  const a = await reserve("First"),
    b = await reserve("Second");
  f.advance(1000);
  const results = await Promise.all([
    post("checkIn", checkin(a)),
    post("checkIn", checkin(b)),
  ]);
  assert.deepEqual(
    results.map((r) => good(r).booking.queue.number).sort(),
    [1, 2],
  );
  const c = await reserve("Third");
  await f.db.collection("queue_state").deleteMany({});
  assert.equal(
    (await post("checkIn", checkin(c))).body.error.code,
    "queue_number_unavailable",
  );
  assert.equal(await f.db.collection("queue_changes").countDocuments(), 2);
});

test("calling is atomic; transitions/retries preserve numbers and capacity after end", async () => {
  const a = await reserve("First"),
    b = await reserve("Second");
  f.advance(1000);
  good(await post("checkIn", checkin(a)));
  good(await post("checkIn", checkin(b)));
  const input = (booking, action, revision) => ({
    ...selection(),
    bookingId: booking.id,
    action,
    expectedRevision: revision,
    idempotencyKey: randomUUID(),
  });
  const call = input(a, "callNext", 1);
  const race = await Promise.all([
    post("transition", call),
    post("transition", input(b, "callNext", 1)),
  ]);
  assert.equal(race.filter((r) => r.status === 200).length, 1);
  assert.equal(
    good(await post("transition", call)).booking.queue.status,
    "called",
  );
  assert.equal(
    (await post("transition", input(a, "complete", 2))).body.error.code,
    "queue_stale",
  );
  const start = input(a, "start", 2);
  good(await post("transition", start));
  assert.equal(
    (await post("transition", input(b, "callNext", 1))).body.error.code,
    "queue_occupied",
  );
  const outsider = await signInSynthetic(f, ["Receptionist"]);
  assert.equal(
    (await post("transition", input(a, "complete", 3), outsider.token)).status,
    403,
  );
  f.advance(new Date(`${date}T11:00:00+02:00`) - f.clock());
  const fresh = await signInSynthetic(f);
  const complete = input(a, "complete", 3);
  good(await post("transition", complete, fresh.token));
  const replay = good(await post("transition", complete, fresh.token));
  assert.equal(replay.booking.queue.number, 1);
  const list = good(await post("list", selection(), fresh.token));
  assert.equal(list.activeSlotOccupied, false);
  assert.equal(list.bookings.find((v) => v.id === a.id).status, "confirmed");
  assert.equal(
    list.bookings.find((v) => v.id === a.id).queue.status,
    "completed",
  );
  assert.equal(
    good(await post("transition", input(b, "callNext", 1), fresh.token)).booking
      .queue.number,
    2,
  );
  assert.equal(
    await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
    2,
  );
  assert.equal(
    await f.db.collection("bookings").countDocuments({
      "queue.status": { $in: ["called", "in_consultation"] },
    }),
    1,
  );
});

test("professional slot spans dated sessions and failed audit rolls back a call", async () => {
  const a = await reserve("First");
  f.advance(1000);
  good(await post("checkIn", checkin(a)));
  const input = {
    ...selection(),
    bookingId: a.id,
    expectedRevision: 1,
    action: "callNext",
    idempotencyKey: randomUUID(),
  };
  await f.restart({ failAudit: true });
  assert.equal((await post("transition", input)).status, 503);
  assert.equal(
    (await f.db.collection("bookings").findOne({ _id: a.id })).queue.status,
    "waiting",
  );
  await f.restart();
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 7);
  const nextDate = next.toISOString().slice(0, 10);
  const otherSession = good(await post("sessions", { date: nextDate }))
    .sessions[0];
  const original = await f.db.collection("bookings").findOne({ _id: a.id });
  const id = randomUUID();
  await f.db.collection("bookings").insertOne({
    ...original,
    _id: id,
    id,
    bookingNumber: "B-99999991",
    patientId: randomUUID(),
    idempotencyKey: randomUUID(),
    date: nextDate,
    datedSessionId: otherSession.id,
    scheduleSignature: otherSession.scheduleSignature,
  });
  const otherInput = {
    ...input,
    bookingId: id,
    date: nextDate,
    sessionVersion: otherSession.scheduleSignature,
    idempotencyKey: randomUUID(),
  };
  const race = await Promise.all([
    post("transition", input),
    post("transition", otherInput),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    await f.db
      .collection("bookings")
      .countDocuments({ "queue.status": "called" }),
    1,
  );
  assert.equal(good(await post("list", selection())).activeSlotOccupied, true);
});

test("absence/return/Left retain allowance and numbers; instructed out-of-order and safe corrections are audited", async () => {
  const a = await reserve("First"),
    b = await reserve("Second"),
    c = await reserve("Third");
  f.advance(1000);
  for (const v of [a, b, c]) good(await post("checkIn", checkin(v)));
  const act = async (v, action, extra = {}) => {
    const saved = await f.db.collection("bookings").findOne({ _id: v.id });
    return post("transition", {
      ...selection(),
      bookingId: v.id,
      expectedRevision: saved.queue.revision,
      action,
      idempotencyKey: randomUUID(),
      ...extra,
    });
  };
  good(await act(a, "absent"));
  const returned = good(await act(a, "return")).booking;
  assert.equal(returned.queue.number, 1);
  assert.equal(returned.queue.position, 4);
  assert.deepEqual(
    good(await post("list", selection()))
      .bookings.filter((v) => v.queue.status === "waiting")
      .map((v) => v.id),
    [b.id, c.id, a.id],
  );
  assert.equal((await act(a, "outOfOrder")).status, 400);
  assert.equal(
    (
      await act(a, "outOfOrder", {
        reason: "Instruction",
        professionalInstructed: false,
      })
    ).status,
    400,
  );
  good(
    await act(a, "outOfOrder", {
      reason: "Professional requested this patient",
      professionalInstructed: true,
    }),
  );
  good(await act(a, "correct", { reason: "Wrong selection" }));
  assert.equal(
    (await act(a, "correct", { reason: "No recursive undo" })).body.error.code,
    "queue_correction_conflict",
  );
  good(await act(b, "left"));
  good(await act(c, "absent"));
  good(
    await act(b, "correct", {
      reason: "Independent waiting edit does not affect this correction",
    }),
  );
  good(await act(c, "correct", { reason: "Patient was present" }));
  good(await act(b, "callNext"));
  good(await act(b, "start"));
  for (const action of ["absent", "left"])
    assert.equal((await act(b, action)).body.error.code, "queue_stale");
  good(await act(b, "complete"));
  good(
    await act(a, "outOfOrder", {
      reason: "Professional instruction",
      professionalInstructed: true,
    }),
  );
  assert.equal(
    (
      await act(b, "correct", {
        reason: "Cannot undo consultation after another call",
      })
    ).body.error.code,
    "queue_correction_conflict",
  );
  assert.equal(
    await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
    3,
  );
  assert.equal(
    await f.db
      .collection("queue_changes")
      .countDocuments({ action: "correct" }),
    3,
  );
  const event = await f.db
    .collection("queue_changes")
    .findOne({ action: "outOfOrder" });
  assert.equal(event.professionalInstructed, true);
  assert.ok(event.reason);
  assert.ok(event.before);
  assert.ok(event.after);
});

test("called absence releases only its slot; return retry, audit rollback and competing out-of-order calls are safe", async () => {
  const a = await reserve("First"),
    b = await reserve("Second"),
    c = await reserve("Third");
  f.advance(1000);
  for (const v of [a, b, c]) good(await post("checkIn", checkin(v)));
  const input = async (v, action, extra = {}) => ({
    ...selection(),
    bookingId: v.id,
    expectedRevision: (await f.db.collection("bookings").findOne({ _id: v.id }))
      .queue.revision,
    action,
    idempotencyKey: randomUUID(),
    ...extra,
  });
  good(await post("transition", await input(a, "callNext")));
  const absent = await input(a, "absent");
  await f.restart({ failAudit: true });
  assert.equal((await post("transition", absent)).status, 503);
  assert.equal(good(await post("list", selection())).activeSlotOccupied, true);
  await f.restart();
  good(await post("transition", absent));
  assert.equal(good(await post("list", selection())).activeSlotOccupied, false);
  const returning = await input(a, "return");
  for (const r of await Promise.all([
    post("transition", returning),
    post("transition", returning),
  ]))
    assert.equal(good(r).booking.queue.position, 4);
  assert.equal(
    (await post("transition", { ...returning, reason: "Changed payload" })).body
      .error.code,
    "queue_idempotency",
  );
  const race = await Promise.all([
    post("transition", await input(b, "callNext")),
    post(
      "transition",
      await input(c, "outOfOrder", {
        reason: "Professional instruction",
        professionalInstructed: true,
      }),
    ),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const user = await signInSynthetic(f, ["Receptionist"]);
  assert.equal(
    (await post("transition", await input(a, "left"), user.token)).status,
    403,
  );
  const saved = await f.db.collection("bookings").findOne({ _id: a.id });
  assert.equal(saved.queue.number, 1);
  assert.equal(
    saved.queue.checkedInAt.getTime(),
    new Date(`${date}T08:30:00+02:00`).getTime(),
  );
  assert.equal(
    await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
    3,
  );
});

async function arrivalInput(label, kind = "walk_in") {
  const record = {
    firstName: `Synthetic${label}`,
    fatherName: "Father",
    lastName: "Admission",
    motherFirstName: "Mother",
    dateOfBirth: "2000-02-29",
    phone: "+96171123456",
    gender: "female",
  };
  const review = good(
    await f.request("/patients/check", {
      method: "POST",
      token: admin.token,
      body: { record },
    }),
  );
  return {
    ...selection(),
    kind,
    idempotencyKey: randomUUID(),
    patientCreate: {
      record,
      reviewDigest: review.reviewDigest,
      duplicateOverride: {
        acknowledged: true,
        reason: "Distinct synthetic arrival",
      },
    },
    ...(kind === "extra"
      ? { reason: "Professional agreed to one extra", professionalAgreed: true }
      : {}),
  };
}
async function admissionLimit(capacity) {
  const { _id, revision, ...record } = await f.db
    .collection("operational_session_drafts")
    .findOne({ id: selected.sourceSessionId });
  await authority.save("sessions", { ...record, capacity }, revision);
}
test("arrival admissions share last ordinary place atomically; extras keep ordinary/public capacity and configured limits unchanged", async () => {
  await admissionLimit(1);
  f.advance(1000);
  const a = await arrivalInput("One"),
    b = await arrivalInput("Two");
  const race = await Promise.all([post("admit", a), post("admit", b)]);
  assert.equal(race.filter((r) => r.status === 200).length, 1);
  assert.equal(
    await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
    1,
  );
  assert.equal(await f.db.collection("patients").countDocuments(), 1);
  const winner = race[0].status === 200 ? a : b;
  const saved = good(await post("admit", winner));
  assert.equal(saved.booking.queue.number, 1);
  assert.equal(saved.booking.type, "Walk-in");
  assert.equal(
    (
      await post("admit", {
        ...winner,
        kind: "extra",
        reason: "Changed",
        professionalAgreed: true,
      })
    ).body.error.code,
    "queue_idempotency",
  );
  const full = await arrivalInput("Full");
  assert.equal((await post("admit", full)).body.error.code, "booking_full");
  assert.equal(await f.db.collection("patients").countDocuments(), 1);
  const extra = await arrivalInput("Extra", "extra");
  const { prepareAvailability } =
    await import("../src/session-availability.js");
  await prepareAvailability(f.db, undefined, [date], f.clock());
  const beforeExtra = (
    await f.db
      .collection("website_request_sync")
      .findOne({ kind: "availability", date })
  ).payload.sessions;
  assert.equal(
    (await post("admit", { ...extra, professionalAgreed: false })).body.error
      .code,
    "queue_agreement",
  );
  const admitted = good(await post("admit", extra));
  await prepareAvailability(f.db, undefined, [date], f.clock());
  assert.deepEqual(
    (
      await f.db
        .collection("website_request_sync")
        .findOne({ kind: "availability", date })
    ).payload.sessions,
    beforeExtra,
  );
  assert.equal(admitted.booking.type, "Extra today");
  assert.equal(admitted.booking.queue.number, 2);
  for (const r of await Promise.all([
    post("admit", extra),
    post("admit", extra),
  ]))
    assert.equal(good(r).booking.id, admitted.booking.id);
  assert.equal(await f.db.collection("patients").countDocuments(), 2);
  assert.equal(
    good(await bookingPost("sessions", { date })).sessions[0].remaining,
    0,
  );
  assert.equal(
    good(await bookingPost("sessions", { date })).sessions[0].capacity,
    1,
  );
  await admissionLimit(1);
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 7);
  assert.equal(
    good(
      await bookingPost("sessions", { date: next.toISOString().slice(0, 10) }),
    ).sessions[0].remaining,
    1,
  );
});

test("admission roles, restrictions, unset limits, duplicate identity and audit rollback fail without orphan records", async () => {
  f.advance(1000);
  const clinic = await signInSynthetic(f, ["Clinic Admin"]);
  await assign(clinic);
  const input = await arrivalInput("One");
  assert.equal((await post("admit", input, clinic.token)).status, 403);
  await admissionLimit(null);
  assert.equal(
    (await post("admit", input)).body.error.code,
    "booking_limit_unset",
  );
  assert.equal(
    (await post("admit", await arrivalInput("Extra", "extra"))).body.error.code,
    "booking_limit_unset",
  );
  assert.equal(await f.db.collection("patients").countDocuments(), 0);
  await admissionLimit(4);
  await f.restart({ failAudit: true });
  assert.equal((await post("admit", input)).status, 503);
  assert.equal(await f.db.collection("patients").countDocuments(), 0);
  assert.equal(await f.db.collection("bookings").countDocuments(), 0);
  assert.equal(await f.db.collection("queue_receipts").countDocuments(), 0);
  await f.restart();
  const saved = good(await post("admit", input));
  assert.equal(
    (
      await post("admit", {
        ...selection(),
        kind: "walk_in",
        patientId: saved.patient.id,
        patientRevision: saved.patient.revision,
        idempotencyKey: randomUUID(),
      })
    ).body.error.code,
    "booking_duplicate",
  );
});

test("appointment-required and server arrival boundaries refuse ordinary and extra walk-ins", async () => {
  const input = await arrivalInput("One");
  assert.equal((await post("admit", input)).body.error.code, "queue_closed");
  const { _id, revision, ...record } = await f.db
    .collection("operational_session_drafts")
    .findOne({ id: selected.sourceSessionId });
  await authority.save(
    "sessions",
    { ...record, appointmentRequired: true },
    revision,
  );
  good(await authority.publish(date));
  selected = good(await post("sessions", { date })).sessions[0];
  f.advance(1000);
  for (const kind of ["walk_in", "extra"])
    assert.equal(
      (
        await post(
          "admit",
          await arrivalInput(kind === "extra" ? "Extra" : "Walkin", kind),
        )
      ).body.error.code,
      "queue_appointment_required",
    );
  assert.equal(await f.db.collection("patients").countDocuments(), 0);
});

test("walk-in admission closes exactly at end with no patient or number left behind", async () => {
  f.advance(1000);
  const early = good(await post("admit", await arrivalInput("Early")));
  assert.equal(early.booking.queue.number, 1);
  f.advance(new Date(`${date}T10:59:59.999+02:00`) - f.clock());
  admin = await signInSynthetic(f);
  good(await post("admit", await arrivalInput("Last")));
  f.advance(1);
  const late = await arrivalInput("Late");
  assert.equal((await post("admit", late)).body.error.code, "queue_closed");
  assert.equal(
    (
      await post("admit", {
        ...late,
        kind: "extra",
        professionalAgreed: true,
        reason: "No late bypass",
      })
    ).body.error.code,
    "queue_closed",
  );
  assert.equal(await f.db.collection("patients").countDocuments(), 2);
  assert.equal(await f.db.collection("bookings").countDocuments(), 2);
  assert.equal(
    (await f.db.collection("queue_state").findOne({ _id: selected.id }))
      .nextNumber,
    3,
  );
});
const transitionInput = (booking, action, revision, extra = {}) => ({
  ...selection(),
  bookingId: booking.id,
  action,
  expectedRevision: revision,
  idempotencyKey: randomUUID(),
  ...extra,
});
async function nearEnd() {
  f.advance(new Date(`${date}T10:59:59+02:00`) - f.clock());
  admin = await signInSynthetic(f);
}

test("exact end marks only unarrived confirmed bookings once without numbers or allowance release; arrivals finish after end", async () => {
  const a = await reserve("Arrived"),
    b = await reserve("Missing"),
    c = await reserve("Cancelled");
  f.advance(1000);
  good(await post("checkIn", checkin(a)));
  good(
    await bookingPost("cancel", {
      bookingId: c.id,
      reason: "Synthetic cancellation before end",
    }),
  );
  await nearEnd();
  assert.equal((await f.reconcileQueue()).marked, 0);
  f.advance(1000);
  const results = await Promise.all([
    f.reconcileQueue(),
    f.reconcileQueue(),
    post("list", selection()),
  ]);
  results.forEach((r) => {
    if (r.status) good(r);
  });
  const docs = await f.db.collection("bookings").find({}).toArray();
  const missing = docs.find((x) => x.id === b.id);
  assert.deepEqual(missing.queue, {
    status: "no_show",
    revision: 1,
    reconciledAt: f.clock(),
  });
  assert.equal(missing.status, "confirmed");
  assert.equal(docs.find((x) => x.id === c.id).queue, undefined);
  assert.equal(docs.find((x) => x.id === c.id).status, "cancelled");
  assert.equal(docs.find((x) => x.id === a.id).queue.status, "waiting");
  assert.equal(
    await f.db
      .collection("queue_changes")
      .countDocuments({ action: "no_show" }),
    1,
  );
  const event = await f.db
    .collection("queue_changes")
    .findOne({ action: "no_show" });
  assert.equal(event.actorType, "system");
  assert.equal(event.actorId, null);
  assert.deepEqual(event.occurredAt, f.clock());
  assert.equal(
    (await post("checkIn", checkin(b))).body.error.code,
    "queue_closed",
  );
  assert.equal(
    (
      await bookingPost("cancel", {
        bookingId: b.id,
        reason: "Cannot free expired reservation",
      })
    ).body.error.code,
    "booking_ended",
  );
  for (const [action, rev] of [
    ["callNext", 1],
    ["start", 2],
    ["complete", 3],
  ])
    good(await post("transition", transitionInput(a, action, rev)));
  f.advance(1000);
  assert.equal((await f.reconcileQueue()).marked, 0);
  assert.equal(
    await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
    2,
  );
  assert.equal(
    (await f.db.collection("bookings").findOne({ _id: a.id })).queue.status,
    "completed",
  );
});

test("No-show correction requires scoped current evidence, appends Waiting, preserves active slot and immutable history", async () => {
  const a = await reserve("Active"),
    b = await reserve("Missing");
  f.advance(1000);
  good(await post("checkIn", checkin(a)));
  good(await post("transition", transitionInput(a, "callNext", 1)));
  await nearEnd();
  f.advance(1000);
  await f.reconcileQueue();
  const original = await f.db
    .collection("queue_changes")
    .findOne({ bookingId: b.id, action: "no_show" });
  const input = transitionInput(b, "restoreArrival", 1, {
    reason: "Staff missed an earlier arrival",
    arrivedBeforeEnd: true,
  });
  for (const [change, code] of [
    [{ reason: "" }, "queue_reason"],
    [{ arrivedBeforeEnd: false }, "queue_arrival_evidence"],
    [{ expectedRevision: 2 }, "queue_stale"],
    [{ checkedInAt: "2026-01-01" }, "invalid_input"],
  ]) {
    const result = await post("transition", { ...input, ...change });
    assert.ok(result.status >= 400, JSON.stringify(result.body));
    if (code !== "invalid_input") assert.equal(result.body.error.code, code);
  }
  const outsider = await signInSynthetic(f, ["Receptionist"]);
  assert.equal((await post("transition", input, outsider.token)).status, 403);
  await f.db
    .collection("bookings")
    .updateOne(
      { _id: b.id },
      { $set: { scheduleSignature: "stale-authority" } },
    );
  assert.equal(
    (await post("transition", input)).body.error.code,
    "queue_stale",
  );
  await f.db
    .collection("bookings")
    .updateOne(
      { _id: b.id },
      { $set: { scheduleSignature: selected.scheduleSignature } },
    );
  const restored = good(await post("transition", input)).booking;
  assert.equal(restored.queue.status, "waiting");
  assert.equal(restored.queue.number, 2);
  assert.equal(restored.queue.checkedInAt, undefined);
  assert.equal(restored.queue.earlierArrivalReported, true);
  assert.equal(restored.queue.correctedAt, f.clock().toISOString());
  assert.equal(
    (await f.db.collection("bookings").findOne({ _id: a.id })).queue.status,
    "called",
  );
  assert.equal(good(await post("transition", input)).replayed, true);
  assert.equal(
    (await post("transition", { ...input, idempotencyKey: randomUUID() })).body
      .error.code,
    "queue_stale",
  );
  assert.equal(
    (
      await post(
        "transition",
        transitionInput(b, "correct", 2, { reason: "No generic undo" }),
      )
    ).body.error.code,
    "queue_correction_conflict",
  );
  assert.deepEqual(
    await f.db.collection("queue_changes").findOne({ _id: original._id }),
    original,
  );
  assert.equal(
    await f.db
      .collection("queue_changes")
      .countDocuments({ bookingId: b.id, action: "restoreArrival" }),
    1,
  );
});

test("server lifecycle catches downtime across dated sessions without a queue screen; repeated refresh is idempotent", async () => {
  const { createAuthorityLifecycle } = await import("../src/server.js");
  const { createApp } = await import("../src/app.js");
  const a = await reserve("Earlier");
  date = new Date(new Date(`${date}T12:00:00Z`).getTime() + 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  selected = good(await bookingPost("sessions", { date })).sessions[0];
  const b = await reserve("Later");
  f.advance(new Date(`${date}T10:59:00+02:00`) - f.clock());
  const lifecycle = createAuthorityLifecycle({
    database: "capstone_staff_test",
    makeApp: (options) => createApp({ ...options, clock: f.clock }),
  });
  try {
    await lifecycle.refresh();
    assert.equal(
      (await f.db.collection("bookings").findOne({ _id: a.id })).queue.status,
      "no_show",
    );
    assert.equal(
      (await f.db.collection("bookings").findOne({ _id: b.id })).queue,
      undefined,
    );
    f.advance(60000);
    await lifecycle.refresh();
    for (const booking of [a, b])
      assert.equal(
        (await f.db.collection("bookings").findOne({ _id: booking.id })).queue
          .status,
        "no_show",
      );
    await lifecycle.refresh();
    assert.equal(
      await f.db
        .collection("queue_changes")
        .countDocuments({ action: "no_show" }),
      2,
    );
  } finally {
    await lifecycle.stop();
  }
});

test("end races and audit failure cannot create partial outcomes, late arrivals or released allowance", async () => {
  const b = await reserve("Race");
  await nearEnd();
  good(
    await bookingPost("cancel", { bookingId: b.id, reason: "Just before end" }),
  );
  const c = await reserve("Unarrived");
  f.advance(1000);
  await f.restart({ failAudit: true });
  await assert.rejects(f.reconcileQueue());
  assert.equal(
    (await f.db.collection("bookings").findOne({ _id: c.id })).queue,
    undefined,
  );
  assert.equal(
    await f.db
      .collection("queue_changes")
      .countDocuments({ action: "no_show" }),
    0,
  );
  await f.restart();
  const race = await Promise.all([
    f.reconcileQueue(),
    post("checkIn", checkin(c)),
    bookingPost("cancel", { bookingId: c.id, reason: "Too late" }),
  ]);
  assert.equal(race[1].status, 409);
  assert.equal(race[2].status, 409);
  assert.equal(
    (await f.db.collection("bookings").findOne({ _id: c.id })).queue.status,
    "no_show",
  );
  assert.equal(
    (await f.db.collection("bookings").findOne({ _id: b.id })).status,
    "cancelled",
  );
  assert.equal(await f.db.collection("queue_state").countDocuments(), 0);
});

test("reconciliation preserves every arrived outcome and extras and respects authority across professionals", async () => {
  await authority.save("professionals", {
    ...authority.profile,
    id: "doctor:second",
    name: "Dr. Synthetic Second",
  });
  await authority.save("sessions", {
    id: "session:second",
    scopeId: "clinic:synthetic",
    professionalId: "doctor:second",
    weekday: 1,
    startTime: "09:00",
    endTime: "11:00",
    capacity: 4,
    status: "active",
    appointmentRequired: false,
  });
  good(await authority.publish(date));
  selected = good(await bookingPost("sessions", { date })).sessions.find(
    (s) => s.sourceSessionId === "session:synthetic",
  );
  const a = await reserve("First");
  const original = await f.db.collection("bookings").findOne({ _id: a.id });
  const states = [
    "waiting",
    "called",
    "in_consultation",
    "temporarily_absent",
    "completed",
    "left",
  ];
  // Persisted valid outcome shapes exercise the reconciliation filter; transition paths are covered above.
  const saved = [];
  for (let i = 0; i < states.length; i++) {
    const id = randomUUID();
    const row = {
      ...original,
      _id: id,
      id,
      bookingNumber: `B-TEST-${i}`,
      idempotencyKey: randomUUID(),
      ordinal: 20 + i,
      patientId: randomUUID(),
      professionalId: i === 2 ? "doctor:second" : original.professionalId,
      queue: {
        status: states[i],
        number: 20 + i,
        position: 20 + i,
        revision: 2,
        checkedInAt: f.clock(),
      },
      ...(i === 0 ? { admissionKind: "extra" } : {}),
    };
    await f.db.collection("bookings").insertOne(row);
    saved.push(row);
  }
  selected = good(await bookingPost("sessions", { date })).sessions.find(
    (s) => s.sourceSessionId === "session:second",
  );
  const b = await reserve("Second");
  const count = await f.db
    .collection("bookings")
    .countDocuments({ status: "confirmed", admissionKind: { $ne: "extra" } });
  await nearEnd();
  f.advance(1000);
  assert.equal((await f.reconcileQueue()).marked, 2);
  for (const row of saved)
    assert.deepEqual(
      await f.db.collection("bookings").findOne({ _id: row.id }),
      row,
    );
  for (const row of [a, b])
    assert.equal(
      (await f.db.collection("bookings").findOne({ _id: row.id })).queue.status,
      "no_show",
    );
  assert.equal(
    await f.db
      .collection("bookings")
      .countDocuments({ status: "confirmed", admissionKind: { $ne: "extra" } }),
    count,
  );
  await f.db
    .collection("bookings")
    .updateOne(
      { _id: b.id },
      { $unset: { queue: "" }, $set: { scheduleSignature: "stale-authority" } },
    );
  assert.deepEqual(await f.reconcileQueue(), { marked: 0, blocked: 1 });
  assert.equal(
    (await f.db.collection("bookings").findOne({ _id: b.id })).queue,
    undefined,
  );
});
