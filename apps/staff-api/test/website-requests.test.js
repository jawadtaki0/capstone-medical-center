import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  seedPublicationAuthority,
  signInSynthetic,
} from "./helpers/publication-authority.js";
import {
  createPublicIntake,
  ensureIntakeIndexes,
} from "../../api/src/website-requests.js";
import { ensureRequestIndexes } from "../src/website-requests.js";
import { beirutClock } from "../src/booking-model.js";
import { randomToken } from "../../../shared/website-request-security.mjs";
let f,
  a,
  admin,
  api,
  date,
  failEvent = false;
const key = randomBytes(32),
  config = {
    key,
    contact: "+961 00 000 000 — SYNTHETIC TEST ONLY",
    publicBase: "http://127.0.0.1:5191",
    transport: {
      pull: (c) => api.pull(c),
      event: (e) => {
        if (failEvent) throw Error("Synthetic outage");
        return api.accept(e);
      },
      rotate: (i) => api.rotate(i),
    },
  };
const good = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const post = (action, body, token = admin.token) =>
  f.request(`/website-requests/${action}`, { method: "POST", token, body });
before(async () => {
  f = await createSecurityFixture({ requestIntegration: config });
  await ensureIntakeIndexes(f.db);
  await ensureRequestIndexes(f.db);
});
beforeEach(async () => {
  await f.reset();
  a = await seedPublicationAuthority(f);
  admin = a.admin;
  good(await a.publish(null));
  const d = new Date(`${beirutClock(f.clock()).date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  date = d.toISOString().slice(0, 10);
  failEvent = false;
  api = createPublicIntake({
    db: f.db,
    client: f.client,
    key,
    clock: f.clock,
    sessionReader: async () => [
      {
        date,
        scopeId: "clinic:synthetic",
        sourceSessionId: "session:synthetic",
        professionalId: "doctor:synthetic",
        professionalName: "Dr. Synthetic Review",
        kind: "doctor",
        specialty: "Dentistry",
        startTime: "09:00",
        endTime: "11:00",
        appointmentRequired: false,
      },
    ],
  });
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});
async function submitted(suffix = "A") {
  const patient = {
    firstName: `Synthetic${suffix}`,
    fatherName: "Father",
    lastName: `Request${suffix}`,
    motherFirstName: "Mother",
    dateOfBirth: "2000-02-29",
    phone: "+96171123456",
    gender: "female",
    preferredLanguage: "ar",
  };
  const receipt = await api.submit(
    {
      submissionKey: randomToken(),
      selection: {
        date,
        professionalId: "doctor:synthetic",
        sourceSessionId: "session:synthetic",
      },
      patient,
      honeypot: "",
    },
    randomUUID(),
  );
  good(await post("refresh", {}));
  return receipt;
}
async function linked(suffix = "A") {
  const receipt = await submitted(suffix),
    d = good(await post("detail", { id: receipt.requestId }));
  const out = good(
    await post("createPatient", {
      id: receipt.requestId,
      revision: d.request.revision,
      reviewDigest: d.matches.reviewDigest,
      duplicateOverride: {
        acknowledged: true,
        reason: "Synthetic distinct request patient",
      },
    }),
  );
  return { receipt, request: out.request };
}
async function confirmation(r) {
  const v = good(await post("review", { id: r.id }));
  return {
    id: r.id,
    revision: r.revision,
    booking: {
      patientId: v.patient.id,
      patientRevision: v.patient.revision,
      date,
      scopeId: r.scopeId,
      sourceSessionId: r.selection.sourceSessionId,
      sessionVersion: v.session.version,
      idempotencyKey: randomUUID(),
    },
  };
}
test("only Admin and explicitly granted Receptionist process private requests; mixed roles do not confer grants", async () => {
  const r = await submitted();
  for (const [roles, grant, ok] of [
    [["Receptionist"], false, false],
    [["Receptionist"], true, true],
    [["Clinic Admin"], true, false],
    [["Lab Admin"], true, false],
    [["Lab Admin", "Receptionist"], false, false],
    [["Clinic Admin", "Receptionist"], true, true],
  ]) {
    const u = await signInSynthetic(f, roles);
    if (grant)
      await f.db.collection("operational_grants").insertOne({
        _id: u.id,
        id: u.id,
        scopeIds: ["clinic:synthetic"],
        revision: 1,
      });
    const result = await post("detail", { id: r.requestId }, u.token);
    assert.equal(result.status, ok ? 200 : 403);
    if (grant) {
      await f.db.collection("operational_grants").deleteOne({ _id: u.id });
      assert.equal(
        (await post("detail", { id: r.requestId }, u.token)).status,
        403,
      );
    }
  }
});
test("decision and booking/outbox commit once, public outage never undoes confirmation; notes never project", async () => {
  let { receipt, request: r } = await linked();
  r = good(
    await post("notes", {
      id: r.id,
      revision: r.revision,
      notes: "PRIVATE CLINICAL FREE TEXT MUST NOT LEAK",
    }),
  ).request;
  const input = await confirmation(r);
  failEvent = true;
  const confirmed = good(await post("confirm", input));
  assert.equal(confirmed.request.status, "confirmed");
  good(await post("confirm", input));
  assert.equal(await f.db.collection("bookings").countDocuments({}), 1);
  good(await post("refresh", {}));
  assert.equal(
    (await api.track(receipt.trackingToken, "read")).status,
    "awaiting",
  );
  failEvent = false;
  f.advance(31000);
  good(await post("refresh", {}));
  const track = await api.track(receipt.trackingToken, "read");
  assert.equal(track.status, "confirmed");
  for (const s of [
    "PRIVATE",
    r.patient.phone,
    r.patient.motherFirstName,
    r.patient.dateOfBirth,
  ])
    assert.equal(JSON.stringify(track).includes(s), false);
  const payload = await f.db.collection("website_request_events").findOne({});
  assert.equal(JSON.stringify(payload).includes("PRIVATE"), false);
  assert.equal(
    (
      await post("reject", {
        id: r.id,
        revision: r.revision,
        reason: "session_unavailable",
      })
    ).status,
    409,
  );
});
test("concurrent phone/website confirmations contend for the same final place", async () => {
  const old = await f.db
    .collection("operational_session_drafts")
    .findOne({ id: "session:synthetic" });
  const { _id, revision, ...record } = old;
  good(
    await a.post("save", {
      type: "sessions",
      record: { ...record, capacity: 1 },
      expectedRevision: revision,
    }),
  );
  const first = await linked("A"),
    second = await linked("B");
  const web = await confirmation(first.request),
    phone = await confirmation(second.request);
  const results = await Promise.all([
    post("confirm", web),
    f.request("/bookings/confirm", {
      method: "POST",
      token: admin.token,
      body: phone.booking,
    }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  assert.equal(
    await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
    1,
  );
});
test("rejection races have one winner, fixed reasons only and no partial mixed writes", async () => {
  const { request: r } = await linked();
  assert.equal(
    (
      await post("reject", {
        id: r.id,
        revision: r.revision,
        reason: "session full",
      })
    ).status,
    400,
  );
  const results = await Promise.all([
    post("reject", {
      id: r.id,
      revision: r.revision,
      reason: "session_unavailable",
    }),
    post("reject", { id: r.id, revision: r.revision, reason: "other" }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(
    await f.db.collection("website_request_events").countDocuments({}),
    1,
  );
});
test("lost link original-destination rotation is retry-safe; notifications recheck stale generations and private notes", async () => {
  const { request: r, receipt } = await linked();
  const rotation = {
    id: r.id,
    revision: r.revision,
    key: randomToken(),
    reason: "Caller lost the original link; original unverified phone only",
    confirmed: true,
  };
  good(await post("rotate", rotation));
  good(await post("rotate", rotation));
  await assert.rejects(api.track(receipt.trackingToken, "read"));
  let d = good(await post("detail", { id: r.id }));
  assert.equal(d.request.generation, 2);
  const n = d.notices[0];
  const prepared = good(
    await post("notification", {
      noticeId: n.id,
      action: "prepare",
      language: "ar",
      contactAcknowledged: true,
    }),
  );
  assert.equal(prepared.phone, r.patient.phone);
  for (const field of [
    r.patient.dateOfBirth,
    r.patient.motherFirstName,
    "P-000",
  ])
    assert.equal(prepared.message.includes(field), false);
  assert.equal(prepared.localReviewOnly, true);
  assert.equal(
    (
      await post("rotate", {
        ...rotation,
        key: randomToken(),
        revision: d.request.revision,
      })
    ).status,
    429,
  );
  assert.equal(
    (await post("notification", { noticeId: n.id, action: "sent" })).status,
    400,
  );
  const failedOpening = randomUUID();
  good(
    await post("notification", {
      noticeId: n.id,
      action: "opening",
      key: failedOpening,
    }),
  );
  good(
    await post("notification", {
      noticeId: n.id,
      action: "open_failed",
      key: failedOpening,
    }),
  );
  d = good(await post("detail", { id: r.id }));
  assert.equal(d.notices[0].state, "pending");
  const opening = randomUUID();
  good(
    await post("notification", {
      noticeId: n.id,
      action: "opening",
      key: opening,
    }),
  );
  good(
    await post("notification", {
      noticeId: n.id,
      action: "opened",
      key: opening,
    }),
  );
  good(await post("notification", { noticeId: n.id, action: "sent" }));
});
test("session end reconciles undecided requests but never overwrites a committed delayed confirmation", async () => {
  const first = await linked("A"),
    second = await linked("B");
  const input = await confirmation(first.request);
  good(await post("confirm", input));
  const ends = (
    await f.db
      .collection("website_request_inbox")
      .findOne({ _id: first.request.id })
  ).endsAt;
  f.advance(ends - f.clock());
  assert.equal(
    (await api.track(first.receipt.trackingToken, "read")).windowEnded,
    true,
  );
  await f.db.collection("staff_sessions").updateMany(
    {},
    {
      $set: {
        lastActivityAt: f.clock(),
        createdAt: f.clock(),
        absoluteExpiresAt: new Date(f.clock().getTime() + 3600000),
        expiresAt: new Date(f.clock().getTime() + 3600000),
      },
    },
  ); // fixture-only direct service worker below does not need an employee session
  const { createAuthService } = await import("../src/auth.js");
  const service = createAuthService({
    db: f.db,
    client: f.client,
    vault: f.vault,
    clock: f.clock,
    requestIntegration: config,
  });
  await service.websiteRequests.pump();
  assert.equal(
    (await api.track(first.receipt.trackingToken, "read")).status,
    "confirmed",
  );
  assert.equal(
    (await api.track(second.receipt.trackingToken, "read")).status,
    "rejected",
  );
});

test("transaction failure after booking insertion rolls back booking, decision and notice", async () => {
  const { request: r } = await linked();
  const v = await confirmation(r);
  await f.db.collection("website_request_events").insertOne({
    _id: `${r.id}:1`,
    requestId: "synthetic-conflict",
    sequence: 1,
    state: "accepted",
  });
  const result = await post("confirm", v);
  assert.equal(result.status, 503);
  assert.equal(await f.db.collection("bookings").countDocuments({}), 0);
  assert.equal(
    (await f.db.collection("website_request_inbox").findOne({ _id: r.id }))
      .status,
    "awaiting",
  );
  assert.equal(
    await f.db.collection("website_request_notices").countDocuments({}),
    0,
  );
});
test("phone booking creates manual notice and cancellation requires fixed reason", async () => {
  const { request: r } = await linked();
  const v = await confirmation(r);
  const booked = good(
    await f.request("/bookings/confirm", {
      method: "POST",
      token: admin.token,
      body: { ...v.booking, noticeLanguage: "ar" },
    }),
  );
  const list = good(await post("notices", {}));
  assert.equal(list.notices.length, 1);
  const n = list.notices[0],
    message = good(
      await post("notification", { noticeId: n.id, action: "prepare" }),
    );
  assert.ok(message.message.includes("مؤكد"));
  assert.equal(message.message.includes("/track#"), false);
  assert.equal(
    (
      await f.request("/bookings/cancel", {
        method: "POST",
        token: admin.token,
        body: { bookingId: booked.booking.id, reason: "PRIVATE REASON" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.db.collection("bookings").findOne({ _id: booked.booking.id }))
      .status,
    "confirmed",
  );
  good(
    await f.request("/bookings/cancel", {
      method: "POST",
      token: admin.token,
      body: {
        bookingId: booked.booking.id,
        reason: "PRIVATE REASON",
        publicReason: "other",
      },
    }),
  );
  assert.equal(
    (await f.db.collection("bookings").findOne({ _id: booked.booking.id }))
      .status,
    "cancelled",
  );
});
test("cleanup strips separable request data while preserving booking and rejects stale pull resurrection", async () => {
  const { request: r } = await linked();
  const batch = await api.pull(0);
  good(await post("confirm", await confirmation(r)));
  const { createAuthService } = await import("../src/auth.js");
  const service = createAuthService({
    db: f.db,
    client: f.client,
    vault: f.vault,
    clock: f.clock,
    requestIntegration: config,
  }).websiteRequests;
  const old = await f.db
    .collection("website_request_inbox")
    .findOne({ _id: r.id });
  f.advance(old.expiresAt - f.clock());
  assert.equal((await service.cleanup()).eligible, 1);
  await service.cleanup({ apply: true });
  await api.cleanup({ apply: true });
  assert.equal(
    (await f.db.collection("website_request_inbox").findOne({ _id: r.id }))
      .patient,
    undefined,
  );
  assert.equal(
    await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
    1,
  );
  assert.equal(await f.db.collection("patients").countDocuments({}), 1);
  assert.equal(
    await f.db.collection("website_request_notices").countDocuments({}),
    0,
  );
  await service.pump();
  assert.equal(
    (await f.db.collection("website_request_inbox").findOne({ _id: r.id }))
      .patient,
    undefined,
  );
});

test("owned separate API-service processes recover pending delivery without duplicate bookings", async () => {
  const { request: r } = await linked();
  good(await post("confirm", await confirmation(r)));
  const { createApp } = await import("../../api/src/app.js"),
    { createRequestTransport } = await import("../src/request-integration.js"),
    { fork } = await import("node:child_process"),
    { once } = await import("node:events"),
    { fileURLToPath } = await import("node:url");
  const credential = randomToken();
  const server = createApp({
    websiteRequests: { service: api, credential },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (let i = 0; i < 2; i++) {
      const child = fork(
        fileURLToPath(
          new URL("./helpers/website-request-child.js", import.meta.url),
        ),
        ["--guarded-request-test"],
        {
          execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
        },
      );
      try {
        const result = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("Owned TEST child timed out")),
            15000,
          );
          child.once("message", (m) => {
            clearTimeout(timer);
            resolve(m);
          });
          child.once("error", reject);
        });
        child.send({
          type: "run",
          token: admin.token,
          now: f.clock(),
          config: {
            key: key.toString("base64url"),
            credential,
            mode: "test",
            contact: "SYNTHETIC TEST",
            publicBase: "http://127.0.0.1:5191",
            target: `http://127.0.0.1:${server.address().port}/api/requests/integration`,
          },
        });
        const got = await result;
        assert.equal(got.ok, true);
        assert.equal(got.bookings, 1);
        assert.equal(got.pending, 0);
        assert.deepEqual(got.status, ["confirmed"]);
      } finally {
        child.send({ type: "stop" });
        await once(child, "exit");
      }
    }
  } finally {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("uncertain external opening persists, blocks duplicate opening, and needs explicit staff resolution", async () => {
  const { request: r } = await linked();
  good(await post("confirm", await confirmation(r)));
  const d = good(await post("detail", { id: r.id })),
    noticeId = d.notices[0].id;
  good(
    await post("notification", {
      noticeId,
      action: "opening",
      key: randomUUID(),
    }),
  );
  const pending = good(
    await post("notification", { noticeId, action: "preview" }),
  );
  assert.equal(pending.openingUncertain, true);
  assert.equal(
    (
      await post("notification", {
        noticeId,
        action: "opening",
        key: randomUUID(),
      })
    ).status,
    409,
  );
  good(await post("notification", { noticeId, action: "resolve_uncertain" }));
  assert.equal(
    good(await post("notification", { noticeId, action: "preview" }))
      .openingUncertain,
    false,
  );
  assert.equal(
    await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
    1,
  );
});

test("explicit existing-booking reconciliation lists real references and cancellation updates phone and guest notices together", async () => {
  const { request: r } = await linked();
  const request = await confirmation(r);
  const booked = good(
    await f.request("/bookings/confirm", {
      method: "POST",
      token: admin.token,
      body: request.booking,
    }),
  ).booking;
  const detail = good(await post("detail", { id: r.id }));
  assert.equal(detail.existingBookings.length, 1);
  assert.equal(detail.existingBookings[0].bookingNumber, booked.bookingNumber);
  const reconciled = good(
    await post("reconcileBooking", {
      id: r.id,
      revision: r.revision,
      bookingId: booked.id,
      acknowledged: true,
      reason: "Checked exact patient/session and existing reference",
    }),
  ).request;
  assert.equal(reconciled.bookingReference, booked.bookingNumber);
  assert.equal(await f.db.collection("bookings").countDocuments({}), 1);
  good(
    await post("cancel", {
      id: r.id,
      revision: reconciled.revision,
      reason: "other",
      privateReason: "Synthetic cancellation",
    }),
  );
  const phone = await f.db
    .collection("website_request_inbox")
    .findOne({ _id: `phone:${booked.id}` });
  assert.equal(phone.status, "cancelled");
  assert.equal(
    await f.db
      .collection("website_request_events")
      .countDocuments({ requestId: { $regex: "^phone:" } }),
    0,
  );
  assert.equal(
    await f.db.collection("website_request_notices").countDocuments({
      requestId: `phone:${booked.id}`,
      kind: "confirmed",
      state: "superseded",
    }),
    1,
  );
});

test("revoked sessions, disabled accounts and inactive scopes cannot read request identities", async () => {
  const receipt = await submitted();
  const user = await signInSynthetic(f, ["Receptionist"]);
  await f.db.collection("operational_grants").insertOne({
    _id: user.id,
    id: user.id,
    scopeIds: ["clinic:synthetic"],
    revision: 1,
  });
  good(await post("detail", { id: receipt.requestId }, user.token));
  await f.db
    .collection("operational_scopes")
    .updateOne({ id: "clinic:synthetic" }, { $set: { active: false } });
  const inactive = await post("detail", { id: receipt.requestId }, user.token);
  assert.equal(inactive.status, 403);
  assert.equal(JSON.stringify(inactive.body).includes("Patientmother"), false);
  await f.db
    .collection("operational_scopes")
    .updateOne({ id: "clinic:synthetic" }, { $set: { active: true } });
  await f.db
    .collection("accounts")
    .updateOne(
      { _id: user.id },
      { $set: { status: "disabled" }, $inc: { version: 1 } },
    );
  const disabled = await post("detail", { id: receipt.requestId }, user.token);
  assert.ok([401, 403].includes(disabled.status));
  assert.equal(JSON.stringify(disabled.body).includes("Patientmother"), false);
});
test("patient intake, notes and booking references never enter public snapshot delivery", async () => {
  const { request: r } = await linked();
  good(
    await post("notes", {
      id: r.id,
      revision: r.revision,
      notes: "PRIVATE REQUEST NOTE",
    }),
  );
  const { buildDelivery } =
    await import("../../../shared/publication-contract.mjs");
  const state = await f.db
    .collection("operational_state")
    .findOne({ _id: "working" });
  const history = await f.db
    .collection("operational_publications")
    .find({})
    .sort({ sequence: 1 })
    .toArray();
  const json = JSON.stringify(buildDelivery(state.streamId, history));
  for (const value of [
    r.patient.phone,
    r.patient.motherFirstName,
    r.patient.dateOfBirth,
    r.reference,
    "PRIVATE REQUEST NOTE",
  ])
    assert.equal(json.includes(value), false);
});
