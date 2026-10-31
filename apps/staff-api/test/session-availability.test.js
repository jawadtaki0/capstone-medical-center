import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { beirutEnd } from "../../../shared/website-request-contract.mjs";
import { readLauncherConfig } from "../scripts/launcher/configuration.js";
import { connectStaffDatabase } from "../src/db.js";
import { assertIsolatedTestTarget } from "./helpers/security-fixture.js";
import { createBookingService, ensureBookingIndexes } from "../src/bookings.js";
import { createOperationsService } from "../src/operations.js";
import {
  loadBookingAuthority,
  resolveBookingSessions,
} from "../src/booking-model.js";
import { prepareAvailability } from "../src/session-availability.js";
import { createWebsiteRequestService } from "../src/website-requests.js";
import {
  createPublicIntake,
  ensureIntakeIndexes,
} from "../../api/src/website-requests.js";
import {
  availabilityDigest,
  availabilitySignature,
  availabilitySlot,
  publicAvailability,
  validateAvailability,
} from "../../../shared/session-availability.mjs";

const date = "2027-11-01";
test("new submissions bind the displayed window; changed hours reject atomically while exact existing retries recover", async () =>
  fixture(async (f) => {
    const input = f.requestInput();
    input.selection = {
      ...input.selection,
      startTime: "08:30",
      endTime: "10:00",
    };
    await assert.rejects(
      f.intake.submit(input, "synthetic-window-source"),
      (e) => e.code === "session_unavailable",
    );
    assert.equal(
      await f.db.collection("website_requests").countDocuments({}),
      0,
    );
    input.selection.startTime = "09:00";
    const receipt = await f.intake.submit(input, "synthetic-window-source");
    await f.db
      .collection("operational_publications")
      .updateOne(
        { id: "publication:synthetic" },
        { $set: { "sessions.0.startTime": "09:15" } },
      );
    assert.equal(
      (await f.intake.submit(input, "synthetic-window-source")).requestId,
      receipt.requestId,
      "recover the same receipt before rechecking a changed published window",
    );
    input.submissionKey = randomBytes(32).toString("base64url");
    await assert.rejects(
      f.intake.submit(input, "synthetic-window-source"),
      (e) => e.code === "session_unavailable",
    );
    assert.equal(
      await f.db.collection("website_requests").countDocuments({}),
      1,
    );
  }));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
test("server Beirut session list includes upcoming/current windows and excludes exact-ended sessions, Sunday and midnight safely", async () =>
  fixture(async (f) => {
    const read = (d) => f.bookings.sessions("synthetic-token", { date: d });
    assert.equal((await read("2027-10-31")).sessions.length, 0);
    assert.equal((await read(date)).sessions.length, 3);
    for (const [time, expected] of [
      ["08:59", 3],
      ["09:30", 3],
      ["10:00", 2],
      ["12:00", 0],
    ]) {
      f.advance(beirutEnd(date, time) - f.now());
      assert.equal((await read(date)).sessions.length, expected, time);
    }
    assert.equal(
      (await read("2027-11-08")).sessions.length,
      3,
      "future weeks do not inherit today's ended filter",
    );
    f.advance(beirutEnd("2027-11-02", "00:00") - f.now());
    await assert.rejects(read(date), (error) => error.code === "booking_ended");
  }));
// Unique collections avoid the ordinary TEST fixture namespace and preserve the
// ongoing hosted-review records. Every destructive cleanup rechecks its target.
async function fixture(action) {
  process.env.CAPSTONE_STAFF_RUNTIME_DIR = (
    await readLauncherConfig()
  ).runtimeDirectory;
  delete process.env.STAFF_SETUP_TEST_MEMORY;
  const connection = await connectStaffDatabase({
    database: "capstone_staff_test",
    demoMode: true,
    initializeIndexes: false,
  });
  assertIsolatedTestTarget(connection);
  const prefix = `availability_${randomBytes(8).toString("hex")}_`,
    names = new Set();
  const db = {
    collection(name) {
      assertIsolatedTestTarget(connection);
      assert.match(name, /^[a-z][a-z0-9_]{0,95}$/);
      names.add(name);
      return connection.db.collection(prefix + name);
    },
  };
  let time = new Date("2027-10-31T12:00:00Z");
  const now = () => new Date(time);
  const transaction = async (work) => {
    const session = connection.client.startSession();
    try {
      return await session.withTransaction(() => work(session), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      });
    } finally {
      await session.endSession();
    }
  };
  const guard = (session) =>
    db
      .collection("confirmation_guard")
      .updateOne({ _id: "shared" }, { $inc: { revision: 1 } }, { session });
  const scope = {
    id: "clinic:synthetic",
    name: "Synthetic Clinic",
    kind: "clinic",
    active: true,
  };
  const professional = {
    id: "doctor:synthetic",
    name: "Dr. Synthetic",
    kind: "doctor",
    specialty: "Synthetic specialty",
    gender: "female",
    avatarVariant: "female",
    active: true,
    scopeIds: [scope.id],
  };
  const sessions = [1, null, 3].map((capacity, n) => ({
    id: `session:synthetic:${n}`,
    professionalId: professional.id,
    scopeId: scope.id,
    weekday: 1,
    startTime: `${9 + n}`.padStart(2, "0") + ":00",
    endTime: `${10 + n}`.padStart(2, "0") + ":00",
    status: "active",
    capacity,
    appointmentRequired: false,
  }));
  const hours = Array.from({ length: 7 }, (_, day) => ({
    id: String(day),
    closed: false,
    startTime: "08:00",
    endTime: "18:00",
  }));
  const actor = {
    account: { _id: "synthetic-actor", roles: ["Admin"] },
    record: {},
  };
  const base = {
    db,
    transaction,
    guard,
    authenticated: async () => actor,
    now,
  };
  try {
    await ensureBookingIndexes(db);
    await ensureIntakeIndexes(db);
    await db
      .collection("confirmation_guard")
      .insertOne({ _id: "shared", revision: 0 });
    await db.collection("operational_scopes").insertOne(scope);
    await db.collection("doctor_profile_drafts").insertOne(professional);
    await db
      .collection("operational_session_drafts")
      .insertMany(sessions.map((s) => ({ ...s, _id: s.id, revision: 1 })));
    await db.collection("operational_hours_drafts").insertMany(hours);
    await db.collection("operational_publications").insertOne({
      id: "publication:synthetic",
      sequence: 1,
      effectiveFrom: null,
      publishedAt: now().toISOString(),
      scopeIds: [scope.id],
      publishesHours: true,
      scopes: [scope],
      professionals: [professional],
      sessions,
      exceptions: [],
      hours,
    });
    const authority = async () => {
      const a = await loadBookingAuthority(db);
      return resolveBookingSessions(a.events, a, date);
    };
    const publicReader = async (value) =>
      (await authority())
        .filter((s) => s.date === value)
        .map((s) => ({
          date: s.date,
          sourceSessionId: s.sourceSessionId,
          scopeId: s.scopeId,
          professionalId: s.professionalId,
          professionalName: s.professionalName,
          kind: "doctor",
          startTime: s.startTime,
          endTime: s.endTime,
          appointmentRequired: s.appointmentRequired,
        }));
    const intake = createPublicIntake({
      db,
      client: connection.client,
      key: Buffer.alloc(32, 11),
      sessionReader: publicReader,
      clock: now,
    });
    const bookings = createBookingService(base);
    const operations = createOperationsService({
      ...base,
      recentVerificationExpiry: () => new Date(+now() + 300000),
    });
    const readOutbox = () =>
      db
        .collection("website_request_sync")
        .findOne({ _id: `availability:${availabilitySlot(date)}` });
    const prepare = () =>
      transaction(async (session) => {
        await guard(session);
        await prepareAvailability(db, session, [date], now());
        return (
          await db
            .collection("website_request_sync")
            .findOne(
              { _id: `availability:${availabilitySlot(date)}` },
              { session },
            )
        ).payload;
      });
    const book = async (sessionIndex = 0) => {
      const p = {
        _id: randomUUID(),
        revision: 1,
        patientNumber: `P-${randomBytes(8).toString("hex")}`,
        firstName: "Synthetic",
        fatherName: "Father",
        lastName: "Patient",
      };
      await db.collection("patients").insertOne(p);
      const selected = (await authority()).find(
        (s) => s.sourceSessionId === sessions[sessionIndex].id,
      );
      const input = {
        patientId: p._id,
        patientRevision: p.revision,
        date,
        scopeId: scope.id,
        sourceSessionId: selected.sourceSessionId,
        sessionVersion: selected.version,
        idempotencyKey: randomUUID(),
      };
      return bookings.confirm("synthetic-token", input);
    };
    const requestInput = () => ({
      submissionKey: randomBytes(32).toString("base64url"),
      honeypot: "",
      selection: {
        date,
        professionalId: professional.id,
        sourceSessionId: sessions[0].id,
      },
      patient: {
        firstName: "Synthetic",
        fatherName: "Father",
        lastName: "Review",
        motherFirstName: "Mother",
        dateOfBirth: "2000-02-29",
        phone: "+12025550123",
        gender: "female",
        preferredLanguage: "en",
      },
    });
    await action({
      db,
      base,
      now,
      advance: (ms) => {
        time = new Date(+time + ms);
      },
      authority,
      intake,
      bookings,
      operations,
      sessions,
      prepare,
      book,
      readOutbox,
      requestInput,
    });
  } finally {
    for (const name of names) {
      assertIsolatedTestTarget(connection);
      await connection.db.collection(prefix + name).deleteMany({});
    }
    await connection.client.close();
  }
}

test("availability snapshot is a minimal projection of live booking authority; pending guest requests reserve nothing", async () =>
  fixture(async (f) => {
    const first = await f.prepare();
    validateAvailability(first);
    assert.deepEqual(Object.keys(first).sort(), [
      "date",
      "digest",
      "generatedAt",
      "sequence",
      "sessions",
    ]);
    for (const entry of first.sessions)
      assert.deepEqual(Object.keys(entry).sort(), ["signature", "state"]);
    assert.deepEqual(
      first.sessions.map((s) => s.state),
      ["available", "blocked", "available"],
    );
    assert.doesNotMatch(
      JSON.stringify(first),
      /capacity|remaining|patient|phone|Synthetic|privateNotes/,
    );
    await f.intake.acceptAvailability(first);
    const requests = await Promise.all([
      f.intake.submit(f.requestInput(), "synthetic-source-one"),
      f.intake.submit(f.requestInput(), "synthetic-source-two"),
    ]);
    assert.notEqual(requests[0].requestId, requests[1].requestId);
    assert.equal(await f.db.collection("bookings").countDocuments({}), 0);
    assert.equal((await f.prepare()).sessions[0].state, "available");
    assert.equal((await f.intake.sessions(date))[0].availability, "available");
  }));

test("confirmed booking, cancellation and immediate manual limit saves invalidate and recompute the same authority", async () =>
  fixture(async (f) => {
    await f.prepare();
    const result = await f.book();
    assert.equal((await f.readOutbox()).dirty, true);
    const full = await f.prepare();
    assert.equal(full.sessions[0].state, "full");
    await f.intake.acceptAvailability(full);
    await assert.rejects(
      f.intake.submit(f.requestInput(), "synthetic-source"),
      (error) => error.code === "session_unavailable",
    );
    assert.equal(
      await f.db.collection("website_requests").countDocuments({}),
      0,
    );
    await f.bookings.cancel("synthetic-token", {
      bookingId: result.booking.id,
      reason: "Synthetic cancellation",
    });
    assert.equal((await f.readOutbox()).dirty, true);
    assert.equal((await f.prepare()).sessions[0].state, "available");
    await f.operations.save("synthetic-token", {
      type: "sessions",
      record: { ...f.sessions[0], capacity: null },
      expectedRevision: 1,
    });
    assert.equal((await f.readOutbox()).dirty, true);
    assert.equal((await f.prepare()).sessions[0].state, "blocked");
    await f.operations.save("synthetic-token", {
      type: "sessions",
      record: { ...f.sessions[0], capacity: 3 },
      expectedRevision: 2,
    });
    assert.equal((await f.prepare()).sessions[0].state, "available");
  }));

test("public receiver accepts exact replay, rejects same-version tampering, and cannot regress on delayed delivery", async () =>
  fixture(async (f) => {
    const first = await f.prepare();
    const ack = await f.intake.acceptAvailability(first);
    assert.deepEqual(await f.intake.acceptAvailability(first), ack);
    const { digest, ...body } = first;
    const changed = {
      ...body,
      sessions: body.sessions.map((s, n) =>
        n === 0 ? { ...s, state: "full" } : s,
      ),
    };
    await assert.rejects(
      f.intake.acceptAvailability({
        ...changed,
        digest: availabilityDigest(changed),
      }),
      (error) => error.code === "request_conflict",
    );
    await f.book();
    const second = await f.prepare();
    assert.ok(second.sequence > first.sequence);
    const newAck = await f.intake.acceptAvailability(second);
    assert.deepEqual(await f.intake.acceptAvailability(first), {
      ...newAck,
      obsolete: true,
    });
    assert.equal((await f.intake.sessions(date))[0].availability, "full");
    f.advance(120001);
    assert.equal((await f.intake.sessions(date))[0].availability, "unknown");
    const received = await f.intake.submit(
      f.requestInput(),
      "synthetic-source",
    );
    assert.ok(
      received.requestId,
      "stale advisory state allows only an ordinary pending request",
    );
    assert.equal(
      await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
      1,
    );
  }));

test("old availability acknowledgement cannot mark a newer local payload accepted", async () =>
  fixture(async (f) => {
    await f.prepare();
    const sent = deferred(),
      release = deferred();
    let waiting = true;
    const service = createWebsiteRequestService({
      ...f.base,
      config: {
        key: Buffer.alloc(32, 5),
        transport: {
          pull: async () => ({ schemaVersion: 1, requests: [], cursor: 0 }),
          availability: async (payload) => {
            if (waiting) {
              sent.resolve(payload);
              await release.promise;
            }
            return f.intake.acceptAvailability(payload);
          },
        },
      },
    });
    const pending = service.pump();
    const oldPayload = await sent.promise;
    await f.book();
    const replacement = await f.prepare();
    assert.ok(replacement.sequence > oldPayload.sequence);
    release.resolve();
    await pending;
    assert.equal((await f.readOutbox()).state, "pending");
    assert.equal((await f.readOutbox()).payload.sequence, replacement.sequence);
    waiting = false;
    await service.pump();
    assert.equal((await f.readOutbox()).state, "accepted");
    assert.equal((await f.intake.sessions(date))[0].availability, "full");
  }));

test("availability preparation and last-place confirmation share the guarded snapshot boundary", async () =>
  fixture(async (f) => {
    await f.prepare();
    await Promise.all([f.prepare(), f.book()]);
    const saved = await f.readOutbox();
    assert.ok(
      saved.dirty === true || saved.payload.sessions[0].state === "full",
      "a projection prepared before the confirmation must remain invalidated",
    );
    const reconciled = await f.prepare();
    assert.equal(reconciled.sessions[0].state, "full");
    assert.equal(
      await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
      1,
    );
  }));

test("failed guarded availability preparation rolls back its payload and monotonic sequence", async () =>
  fixture(async (f) => {
    const before = await f.prepare();
    await assert.rejects(
      f.base.transaction(async (session) => {
        await f.base.guard(session);
        await prepareAvailability(f.db, session, [date], f.now());
        throw new Error("Synthetic rollback");
      }),
      /Synthetic rollback/,
    );
    assert.deepEqual((await f.readOutbox()).payload, before);
    const next = await f.prepare();
    assert.equal(next.sequence, before.sequence + 1);
  }));

test("unknown/missing/stale or mismatched signatures never become available; schema rejects numeric/private data", () => {
  const session = {
    date,
    scopeId: "clinic:synthetic",
    sourceSessionId: "session:synthetic",
    professionalId: "doctor:synthetic",
    startTime: "09:00",
    endTime: "10:00",
  };
  const at = new Date("2027-10-31T12:00:00Z");
  const body = {
    date,
    sequence: 1,
    generatedAt: at.toISOString(),
    sessions: [{ signature: availabilitySignature(session), state: "full" }],
  };
  const value = { ...body, digest: availabilityDigest(body) };
  assert.equal(publicAvailability(session, null, at), "unknown");
  assert.equal(publicAvailability(session, value, at), "full");
  assert.equal(
    publicAvailability(session, value, new Date(+at + 120000)),
    "full",
  );
  assert.equal(
    publicAvailability(session, value, new Date(+at + 120001)),
    "unknown",
  );
  assert.equal(
    publicAvailability({ ...session, endTime: "11:00" }, value, at),
    "unknown",
  );
  for (const extra of [
    { capacity: 3 },
    { remaining: 1 },
    { patientName: "Synthetic" },
  ]) {
    const changed = { ...body, sessions: [{ ...body.sessions[0], ...extra }] };
    assert.throws(() =>
      validateAvailability({ ...changed, digest: availabilityDigest(changed) }),
    );
  }
  assert.ok(availabilitySlot(date) >= 0 && availabilitySlot(date) < 64);
});
