import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readLauncherConfig } from "../scripts/launcher/configuration.js";
import { connectStaffDatabase } from "../src/db.js";
import { assertIsolatedTestTarget } from "./helpers/security-fixture.js";
import { createPatientService, ensurePatientIndexes } from "../src/patients.js";
import { ensureBookingIndexes } from "../src/bookings.js";
import {
  createWebsiteRequestService,
  ensureRequestIndexes,
} from "../src/website-requests.js";
import { beirutEnd } from "../../../shared/website-request-contract.mjs";
import {
  createOperationalSummaryService,
  ensureOperationalSummaryIndexes,
} from "../src/operational-summary.js";

// Every test owns a unique logical namespace. Never reset either the ordinary
// TEST fixture collections or hosted_review_ collections with ongoing edits.
async function fixture({
  capacity = 3,
  roles = ["Admin"],
  granted = true,
} = {}) {
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
  const prefix = `request_confirm_${randomBytes(8).toString("hex")}_`;
  const names = new Set();
  let failEvent = false;
  const db = {
    collection(name) {
      assertIsolatedTestTarget(connection);
      assert.match(name, /^[a-z][a-z0-9_]{0,95}$/);
      names.add(name);
      const target = connection.db.collection(prefix + name);
      if (name !== "website_request_events") return target;
      return new Proxy(target, {
        get(value, property) {
          if (property === "insertOne")
            return async (...args) => {
              if (failEvent) throw Error("Synthetic event failure");
              return value.insertOne(...args);
            };
          const member = Reflect.get(value, property);
          return typeof member === "function" ? member.bind(value) : member;
        },
      });
    },
  };
  const date = "2027-11-01",
    at = new Date("2027-10-31T12:00:00Z");
  const actor = { account: { _id: "synthetic-actor", roles } };
  const sessionRecord = {
    id: "session:synthetic",
    scopeId: "clinic:synthetic",
    professionalId: "doctor:synthetic",
    weekday: 1,
    startTime: "09:00",
    endTime: "11:00",
    status: "active",
    capacity,
    appointmentRequired: false,
  };
  await ensurePatientIndexes(db);
  await ensureBookingIndexes(db);
  await ensureRequestIndexes(db);
  await ensureOperationalSummaryIndexes(db);
  await db
    .collection("confirmation_guard")
    .insertOne({ _id: "shared", revision: 0 });
  await db.collection("operational_scopes").insertOne({
    id: "clinic:synthetic",
    name: "Synthetic Clinic",
    kind: "clinic",
    active: true,
  });
  if (granted)
    await db.collection("operational_grants").insertOne({
      _id: actor.account._id,
      id: actor.account._id,
      scopeIds: ["clinic:synthetic"],
    });
  await db.collection("operational_session_drafts").insertOne(sessionRecord);
  await db.collection("operational_publications").insertOne({
    id: "published:synthetic",
    sequence: 1,
    effectiveFrom: null,
    publishedAt: at.toISOString(),
    scopeIds: ["clinic:synthetic"],
    publishesHours: true,
    scopes: [
      {
        id: "clinic:synthetic",
        name: "Synthetic Clinic",
        kind: "clinic",
        active: true,
      },
    ],
    professionals: [
      {
        id: "doctor:synthetic",
        name: "Dr. Synthetic",
        kind: "doctor",
        specialty: "Synthetic specialty",
        active: true,
        avatarVariant: "female",
        scopeIds: ["clinic:synthetic"],
      },
    ],
    sessions: [sessionRecord],
    exceptions: [],
    hours: Array.from({ length: 7 }, (_, day) => ({
      id: String(day),
      closed: false,
      startTime: "08:00",
      endTime: "18:00",
    })),
  });
  const transaction = async (action) => {
    const session = connection.client.startSession();
    try {
      return await session.withTransaction(() => action(session), {
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
  const base = {
    db,
    transaction,
    guard,
    authenticated: async () => actor,
    now: () => at,
  };
  const service = createWebsiteRequestService({
    ...base,
    config: { key: Buffer.alloc(32, 5) },
  });
  const patients = createPatientService(base);
  const seedRequest = async (suffix = "Alpha") => {
    const record = {
      firstName: `Synthetic${suffix}`,
      fatherName: "Father",
      lastName: `Review${suffix}`,
      motherFirstName: "Mother",
      dateOfBirth: "2000-02-29",
      phone: "+12025550123",
      gender: "female",
    };
    const request = {
      _id: randomBytes(32).toString("hex"),
      scopeId: "clinic:synthetic",
      source: "website",
      status: "awaiting",
      revision: 1,
      sequence: 1,
      generation: 1,
      language: "en",
      createdAt: at,
      endsAt: beirutEnd(date, "11:00"),
      expiresAt: new Date(+beirutEnd(date, "11:00") + 30 * 86400000),
      patient: { ...record, preferredLanguage: "en" },
      selection: {
        date,
        scopeId: "clinic:synthetic",
        sourceSessionId: "session:synthetic",
        professionalId: "doctor:synthetic",
        professionalName: "Dr. Synthetic",
        startTime: "09:00",
        endTime: "11:00",
        appointmentRequired: false,
      },
    };
    await db.collection("website_request_inbox").insertOne(request);
    return { request, record };
  };
  const autoInput = async (request) => {
    const review = await service.review("synthetic-token", { id: request._id });
    return {
      id: request._id,
      revision: request.revision,
      patientMode: "create_if_unmatched",
      booking: {
        date,
        scopeId: request.scopeId,
        sourceSessionId: request.selection.sourceSessionId,
        sessionVersion: review.session.version,
        idempotencyKey: randomUUID(),
      },
    };
  };
  return {
    db,
    service,
    patients,
    summary: createOperationalSummaryService(base),
    actor,
    seedRequest,
    autoInput,
    failEvents: (value) => {
      failEvent = value;
    },
    close: async () => {
      for (const name of names) {
        assertIsolatedTestTarget(connection);
        await connection.db.collection(prefix + name).deleteMany({});
      }
      await connection.client.close();
    },
  };
}
async function withFixture(options, action) {
  const f = await fixture(options);
  try {
    await action(f);
  } finally {
    await f.close();
  }
}

test("opening/reviewing an unmatched request creates nothing; confirmation atomically creates patient, booking and event", async () =>
  withFixture({}, async (f) => {
    const { request } = await f.seedRequest();
    await f.service.detail("synthetic-token", { id: request._id });
    const input = await f.autoInput(request);
    assert.equal(await f.db.collection("patients").countDocuments({}), 0);
    const result = await f.service.confirm("synthetic-token", input);
    assert.equal(result.request.status, "confirmed");
    assert.equal(
      (
        await f.db
          .collection("bookings")
          .findOne({ _id: result.request.bookingId })
      ).source,
      "website",
    );
    assert.equal(await f.db.collection("patients").countDocuments({}), 1);
    assert.equal(await f.db.collection("bookings").countDocuments({}), 1);
    assert.equal(
      await f.db.collection("website_request_events").countDocuments({}),
      1,
    );
    const replay = await f.service.confirm("synthetic-token", input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.request.bookingId, result.request.bookingId);
    assert.equal(await f.db.collection("patients").countDocuments({}), 1);
  }));
test("linked website cancellation cannot release an arrived booking or publish a cancellation", async () =>
  withFixture({}, async (f) => {
    const { request } = await f.seedRequest();
    const saved = (
      await f.service.confirm("synthetic-token", await f.autoInput(request))
    ).request;
    await f.db.collection("bookings").updateOne(
      { _id: saved.bookingId },
      {
        $set: {
          queue: { status: "waiting", number: 1, position: 1, revision: 1 },
        },
      },
    );
    await assert.rejects(
      f.service.cancel("synthetic-token", {
        id: saved.id,
        revision: saved.revision,
        reason: "other",
        privateReason: "Synthetic arrived cancellation refusal",
      }),
      { code: "booking_checked_in" },
    );
    assert.equal(
      (await f.db.collection("bookings").findOne({ _id: saved.bookingId }))
        .status,
      "confirmed",
    );
    assert.equal(
      (
        await f.db
          .collection("website_request_inbox")
          .findOne({ _id: request._id })
      ).status,
      "confirmed",
    );
    assert.equal(
      await f.db.collection("website_request_events").countDocuments({}),
      1,
    );
  }));

test("candidate appearing after review blocks automatic patient creation without partial booking", async () =>
  withFixture({}, async (f) => {
    const { request, record } = await f.seedRequest();
    const input = await f.autoInput(request);
    const checked = await f.patients.check("synthetic-token", { record });
    await f.patients.create("synthetic-token", {
      record,
      reviewDigest: checked.reviewDigest,
    });
    await assert.rejects(
      f.service.confirm("synthetic-token", input),
      (error) => error.code === "request_patient_review",
    );
    assert.equal(await f.db.collection("patients").countDocuments({}), 1);
    assert.equal(await f.db.collection("bookings").countDocuments({}), 0);
    assert.equal(
      await f.db.collection("website_request_events").countDocuments({}),
      0,
    );
    assert.equal(
      (
        await f.db
          .collection("website_request_inbox")
          .findOne({ _id: request._id })
      ).status,
      "awaiting",
    );
  }));
test("failed outbound-event transaction rolls back patient/link/booking/audit and permits safe retry", async () =>
  withFixture({}, async (f) => {
    const { request } = await f.seedRequest();
    const input = await f.autoInput(request);
    let notifications = 0;
    f.service.subscribePendingWork(() => {
      notifications++;
    });
    f.failEvents(true);
    await assert.rejects(
      f.service.confirm("synthetic-token", input),
      /Synthetic event failure/,
    );
    for (const name of [
      "patients",
      "patient_changes",
      "bookings",
      "booking_changes",
      "website_request_events",
      "security_events",
      "patient_registry_state",
      "booking_state",
    ])
      assert.equal(await f.db.collection(name).countDocuments({}), 0, name);
    const unchanged = await f.db
      .collection("website_request_inbox")
      .findOne({ _id: request._id });
    assert.equal(unchanged.status, "awaiting");
    assert.equal(unchanged.linkedPatientId, undefined);
    assert.equal(notifications, 0);
    f.failEvents(false);
    assert.equal(
      (await f.service.confirm("synthetic-token", input)).request.status,
      "confirmed",
    );
    assert.equal(notifications, 1);
  }));
test("concurrent confirmations for matching submitted identities create only one patient and require human review for the other", async () =>
  withFixture({}, async (f) => {
    const one = await f.seedRequest(),
      two = await f.seedRequest();
    const first = await f.autoInput(one.request),
      second = await f.autoInput(two.request);
    const results = await Promise.allSettled([
      f.service.confirm("synthetic-token", first),
      f.service.confirm("synthetic-token", second),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.find((r) => r.status === "rejected").reason.code,
      "request_patient_review",
    );
    assert.equal(await f.db.collection("patients").countDocuments({}), 1);
    assert.equal(await f.db.collection("bookings").countDocuments({}), 1);
  }));
test("last-place race rolls back the losing unmatched patient creation", async () =>
  withFixture({ capacity: 1 }, async (f) => {
    const one = await f.seedRequest("Alpha"),
      two = await f.seedRequest("Omega");
    const inputs = [
      await f.autoInput(one.request),
      await f.autoInput(two.request),
    ];
    const results = await Promise.allSettled(
      inputs.map((input) => f.service.confirm("synthetic-token", input)),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.find((r) => r.status === "rejected").reason.code,
      "booking_full",
    );
    assert.equal(await f.db.collection("patients").countDocuments({}), 1);
    assert.equal(await f.db.collection("bookings").countDocuments({}), 1);
  }));
test("straight existing patient selection requires no arbitrary reason; actual discrepancies require acknowledgement/reason and never overwrite", async () =>
  withFixture({}, async (f) => {
    const { request, record } = await f.seedRequest();
    const checked = await f.patients.check("synthetic-token", { record });
    const p = (
      await f.patients.create("synthetic-token", {
        record,
        reviewDigest: checked.reviewDigest,
      })
    ).patient;
    const linked = await f.service.link("synthetic-token", {
      id: request._id,
      revision: 1,
      patientId: p.id,
      patientRevision: p.revision,
    });
    assert.equal(linked.request.linkedPatientId, p.id);
    const second = await f.seedRequest();
    await f.db
      .collection("website_request_inbox")
      .updateOne(
        { _id: second.request._id },
        { $set: { "patient.dateOfBirth": "2000-03-01" } },
      );
    const input = {
      id: second.request._id,
      revision: 1,
      patientId: p.id,
      patientRevision: p.revision,
    };
    await assert.rejects(
      f.service.link("synthetic-token", input),
      (error) => error.code === "request_patient_discrepancy",
    );
    await f.service.link("synthetic-token", {
      ...input,
      acknowledged: true,
      reason: "Synthetic discrepancy reviewed",
    });
    assert.equal(
      (await f.patients.read("synthetic-token", { patientId: p.id })).patient
        .dateOfBirth,
      "2000-02-29",
    );
  }));
test("current role/scope loss denies automatic creation", async () =>
  withFixture({ roles: ["Receptionist"], granted: false }, async (f) => {
    const { request } = await f.seedRequest();
    await assert.rejects(
      f.service.confirm("synthetic-token", {
        id: request._id,
        revision: 1,
        patientMode: "create_if_unmatched",
        booking: {},
      }),
      (error) => error.code === "request_forbidden",
    );
    assert.equal(await f.db.collection("patients").countDocuments({}), 0);
  }));

test("legacy linked confirmation and its original digest retain retry compatibility", async () =>
  withFixture({}, async (f) => {
    const { request, record } = await f.seedRequest();
    const checked = await f.patients.check("synthetic-token", { record });
    const patient = (
      await f.patients.create("synthetic-token", {
        record,
        reviewDigest: checked.reviewDigest,
      })
    ).patient;
    const linked = await f.service.link("synthetic-token", {
      id: request._id,
      revision: 1,
      patientId: patient.id,
      patientRevision: patient.revision,
    });
    const review = await f.service.review("synthetic-token", {
      id: request._id,
    });
    const input = {
      id: request._id,
      revision: linked.request.revision,
      booking: {
        patientId: patient.id,
        patientRevision: patient.revision,
        date: request.selection.date,
        scopeId: request.scopeId,
        sourceSessionId: request.selection.sourceSessionId,
        sessionVersion: review.session.version,
        idempotencyKey: randomUUID(),
      },
    };
    const original = await f.service.confirm("synthetic-token", input);
    const replay = await f.service.confirm("synthetic-token", input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.request.bookingId, original.request.bookingId);
    await assert.rejects(
      f.service.confirm("synthetic-token", {
        ...input,
        booking: { ...input.booking, sourceSessionId: "different" },
      }),
      (error) => error.status === 409,
    );
    assert.equal(await f.db.collection("bookings").countDocuments({}), 1);
  }));
test("display case/spacing is not an identity discrepancy and never overwrites saved names", async () =>
  withFixture({}, async (f) => {
    const { request, record } = await f.seedRequest();
    const checked = await f.patients.check("synthetic-token", { record });
    const patient = (
      await f.patients.create("synthetic-token", {
        record,
        reviewDigest: checked.reviewDigest,
      })
    ).patient;
    await f.db.collection("website_request_inbox").updateOne(
      { _id: request._id },
      {
        $set: {
          "patient.firstName": `  ${record.firstName.toUpperCase()}  `,
        },
      },
    );
    const result = await f.service.link("synthetic-token", {
      id: request._id,
      revision: 1,
      patientId: patient.id,
      patientRevision: patient.revision,
    });
    assert.equal(result.request.linkedPatientId, patient.id);
    assert.equal(
      (await f.patients.read("synthetic-token", { patientId: patient.id }))
        .patient.firstName,
      record.firstName,
    );
  }));

test("automatic creation cannot accept forged patient fields, a substituted link or another scope", async () =>
  withFixture({}, async (f) => {
    const { request } = await f.seedRequest();
    const input = await f.autoInput(request);
    for (const forged of [
      { ...input, record: { firstName: "Injected" } },
      { ...input, patientMode: "force_create" },
      {
        ...input,
        booking: {
          ...input.booking,
          patientId: randomUUID(),
          patientRevision: 1,
        },
      },
      { ...input, booking: { ...input.booking, scopeId: "clinic:other" } },
    ])
      await assert.rejects(
        f.service.confirm("synthetic-token", forged),
        (error) => error.code === "request_input",
      );
    assert.equal(await f.db.collection("patients").countDocuments({}), 0);
    assert.equal(await f.db.collection("bookings").countDocuments({}), 0);
  }));
test("real Mongo summary counts current unresolved requests/notices and keeps viewing separate from resolution", async () =>
  withFixture({ roles: ["Receptionist"] }, async (f) => {
    const { request } = await f.seedRequest();
    const before = await f.summary.read("synthetic-token");
    assert.equal(before.counts.requestsAwaitingDecision, 1);
    assert.equal(before.counts.messagesToSend, 0);
    assert.equal(before.activity.length, 1);
    await f.summary.viewed("synthetic-token", {
      eventId: before.activity[0].id,
    });
    assert.equal(
      (await f.summary.read("synthetic-token")).counts.requestsAwaitingDecision,
      1,
    );
    await f.service.confirm("synthetic-token", await f.autoInput(request));
    const after = await f.summary.read("synthetic-token");
    assert.equal(after.counts.requestsAwaitingDecision, 0);
    assert.equal(after.counts.messagesToSend, 1);
    const currentNotices = await f.service.notices("synthetic-token");
    assert.equal(currentNotices.notices.length, 1);
    await f.db
      .collection("website_request_notices")
      .updateOne(
        { _id: currentNotices.notices[0].id },
        { $set: { version: 0 } },
      );
    assert.equal(
      (await f.service.notices("synthetic-token")).notices.length,
      0,
    );
    assert.equal(
      (await f.service.notices("synthetic-token", { state: "all" })).notices
        .length,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(after),
      /SyntheticAlpha|Mother|2025550123/,
    );
    await f.db.collection("operational_grants").deleteMany({});
    const revoked = await f.summary.read("synthetic-token");
    assert.equal(revoked.capabilities.requests, false);
    assert.equal(revoked.counts.messagesToSend, undefined);
    assert.deepEqual(revoked.activity, []);
  }));

test("booking message lookup returns only the current notice ID without patient details or writes", async () =>
  withFixture({}, async (f) => {
    const { request } = await f.seedRequest();
    const result = await f.service.confirm(
      "synthetic-token",
      await f.autoInput(request),
    );
    const saved = await f.db
      .collection("website_request_inbox")
      .findOne({ _id: request._id });
    const lookup = await f.service.bookingNoticeLookup("synthetic-token", {
      bookingId: saved.bookingId,
    });
    assert.deepEqual(Object.keys(lookup), ["noticeId"]);
    assert.equal(typeof lookup.noticeId, "string");
    assert.deepEqual(
      await f.db
        .collection("website_request_inbox")
        .findOne({ _id: request._id }),
      saved,
    );
    await f.db
      .collection("website_request_notices")
      .updateOne({ _id: lookup.noticeId }, { $set: { state: "superseded" } });
    await assert.rejects(
      f.service.bookingNoticeLookup("synthetic-token", {
        bookingId: saved.bookingId,
      }),
      { code: "request_notice" },
    );
    assert.equal(result.request.status, "confirmed");
  }));

test("booking message lookup rechecks current scope and rejects injected destinations", async () =>
  withFixture({ roles: ["Receptionist"] }, async (f) => {
    const { request } = await f.seedRequest();
    await f.service.confirm("synthetic-token", await f.autoInput(request));
    const saved = await f.db
      .collection("website_request_inbox")
      .findOne({ _id: request._id });
    await assert.rejects(
      f.service.bookingNoticeLookup("synthetic-token", {
        bookingId: saved.bookingId,
        phone: "+12025550123",
      }),
      { code: "request_input" },
    );
    await f.db.collection("operational_grants").deleteMany({});
    await assert.rejects(
      f.service.bookingNoticeLookup("synthetic-token", {
        bookingId: saved.bookingId,
      }),
      { code: "request_forbidden" },
    );
  }));

test("all booking-role combinations retain current explicit scope enforcement", async (t) => {
  for (const [roles, granted, permitted] of [
    [["Admin"], false, true],
    [["Receptionist"], true, true],
    [["Clinic Admin"], true, false],
    [["Lab Admin"], true, false],
    [["Clinic Admin", "Receptionist"], true, true],
    [["Lab Admin", "Receptionist"], false, false],
  ])
    await t.test(`${roles.join(" + ")} / grant ${granted}`, async () =>
      withFixture({ roles, granted }, async (f) => {
        const { request } = await f.seedRequest();
        if (permitted) {
          const result = await f.service.confirm(
            "synthetic-token",
            await f.autoInput(request),
          );
          assert.equal(result.request.status, "confirmed");
        } else {
          await assert.rejects(
            f.service.review("synthetic-token", { id: request._id }),
            (error) => error.code === "request_forbidden",
          );
          assert.equal(await f.db.collection("patients").countDocuments({}), 0);
        }
      }),
    );
});
