import { randomUUID } from "node:crypto";
import { StaffError } from "./errors.js";
import { validRoles } from "./permissions.js";
import { createBookingService } from "./bookings.js";
import { createPatientService } from "./patients.js";
import {
  loadBookingAuthority,
  bookingAccess,
  assertBookableTime,
  resolveBookingSessions,
} from "./booking-model.js";
import {
  exact,
  text,
  secret,
  beirutEnd,
  REQUEST_REASONS,
  requestFail,
} from "../../../shared/website-request-contract.mjs";
import {
  digest,
  requestCrypto,
  consumeCounter,
} from "../../../shared/website-request-security.mjs";
import { websiteNoticeText } from "../../../shared/website-notice.mjs";
import { phoneNumber } from "../../staff/shared/contact-input.js";
export const CEDAR_REQUEST_COLLECTIONS = [
  "website_request_inbox",
  "website_request_sync",
  "website_request_events",
  "website_request_notices",
  "website_request_audit",
  "website_request_counters",
];
export async function ensureRequestIndexes(db) {
  await db
    .collection("website_request_inbox")
    .createIndex({ scopeId: 1, status: 1, "selection.date": 1, ordinal: 1 });
  await db
    .collection("website_request_inbox")
    .createIndex({ scopeId: 1, searchKeys: 1 });
  await db.collection("website_request_inbox").createIndex({ bookingId: 1 });
  await db
    .collection("website_request_events")
    .createIndex({ requestId: 1, sequence: 1 }, { unique: true });
  await db
    .collection("website_request_events")
    .createIndex({ state: 1, nextAttemptAt: 1 });
  await db
    .collection("website_request_notices")
    .createIndex({ scopeId: 1, state: 1, createdAt: 1 });
  await db
    .collection("website_request_audit")
    .createIndex({ requestId: 1, at: 1 });
  await db
    .collection("website_request_counters")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
export function createWebsiteRequestService({
  db,
  transaction,
  guard,
  authenticated,
  now,
  config,
  pumpClock = () => performance.now(),
}) {
  const rows = db.collection("website_request_inbox"),
    notices = db.collection("website_request_notices"),
    events = db.collection("website_request_events"),
    crypto = requestCrypto(config.key);
  const fail = (code, msg, status = 409) => new StaffError(code, msg, status);
  const allowed = (ctx, a, scopeId) =>
    bookingAccess(
      ctx.account.roles,
      a.grants.find((g) => g.id === ctx.account._id)?.scopeIds ?? [],
      a.scopes.find((s) => s.id === scopeId),
    );
  const scopes = (ctx, a) =>
    a.scopes.filter((s) => allowed(ctx, a, s.id)).map((s) => s.id);
  const dto = (r) => {
    const {
      _id,
      tokenEnvelope,
      rotation,
      rotationKeys,
      payloadDigest,
      confirmKey,
      confirmDigest,
      searchKeys,
      ...rest
    } = r;
    return {
      id: _id,
      ...rest,
      rotationPending: Boolean(rotation),
      trackingExpired: new Date(r.expiresAt) <= now(),
      originalPhoneUnverified: true,
    };
  };
  async function run(token, write, action) {
    try {
      return await transaction(async (session) => {
        if (write) await guard(session);
        const at = now(),
          ctx = await authenticated(session, token, at);
        if (ctx.failure) return ctx;
        if (!validRoles(ctx.account.roles))
          throw fail(
            "request_forbidden",
            "Request access is not permitted.",
            403,
          );
        const a = await loadBookingAuthority(db, session);
        if (!scopes(ctx, a).length)
          throw fail(
            "request_forbidden",
            "Your current role and clinic assignment do not permit website requests.",
            403,
          );
        return action(session, ctx, a, at);
      });
    } catch (e) {
      if (e instanceof StaffError) throw e;
      if (e.code && e.status) throw fail(e.code, e.message, e.status);
      throw e;
    }
  }
  async function target(session, ctx, a, input) {
    const r = await rows.findOne({ _id: text(input.id, 64) }, { session });
    if (!r || r.purgedAt || !allowed(ctx, a, r.scopeId))
      throw fail(
        "request_forbidden",
        "This request is unavailable for your current clinic assignment.",
        403,
      );
    if (input.revision !== undefined && r.revision !== input.revision)
      throw fail(
        "request_stale",
        "This request changed. Reload it before acting.",
      );
    return r;
  }
  async function audit(session, r, ctx, action, at, details = {}) {
    await db.collection("website_request_audit").insertOne(
      {
        _id: randomUUID(),
        requestId: r._id,
        actorId: ctx.system ? null : ctx.account._id,
        actorType: ctx.system ? "system" : "staff",
        purgeAfter: new Date(r.endsAt.getTime() + 90 * 86400000),
        action,
        at,
        ...details,
      },
      { session },
    );
  }
  const inner = (session) => ({
    db,
    transaction: (action) => action(session),
    guard,
    authenticated,
    now,
  });
  const patientService = (session) => createPatientService(inner(session));
  const bookingService = (session) => createBookingService(inner(session));
  async function notice(session, r, kind, at) {
    await notices.updateMany(
      { requestId: r._id, state: { $in: ["pending", "call_required"] } },
      { $set: { supersededAt: at, state: "superseded" } },
      { session },
    );
    await notices.insertOne(
      {
        _id: randomUUID(),
        requestId: r._id,
        scopeId: r.scopeId,
        kind,
        version: r.sequence,
        generation: r.generation,
        state: "pending",
        history: [],
        createdAt: at,
      },
      { session },
    );
  }
  async function decide(session, r, ctx, status, reason, booking, at) {
    r.status = status;
    r.reason = reason;
    r.sequence++;
    r.revision++;
    if (booking) {
      r.bookingId = booking.id;
      r.bookingReference = booking.bookingNumber;
    }
    const payload = {
      requestId: r._id,
      sequence: r.sequence,
      status,
      reason,
      bookingReference: r.bookingReference ?? null,
      at: at.toISOString(),
    };
    const event = { ...payload, digest: digest(payload) };
    await rows.replaceOne({ _id: r._id }, r, { session });
    await events.insertOne(
      {
        _id: `${r._id}:${r.sequence}`,
        requestId: r._id,
        sequence: r.sequence,
        payload: event,
        state: "pending",
        attempts: 0,
        nextAttemptAt: at,
      },
      { session },
    );
    await notice(session, r, status, at);
    await audit(session, r, ctx, status, at);
    return { request: dto(r) };
  }
  async function ingest(batch) {
    exact(batch, ["schemaVersion", "requests", "cursor"]);
    if (
      batch.schemaVersion !== 1 ||
      !Array.isArray(batch.requests) ||
      batch.requests.length > 25 ||
      !Number.isSafeInteger(batch.cursor)
    )
      throw Error("Invalid intake batch.");
    for (const item of batch.requests) {
      if (
        item.payloadVersion !== 1 ||
        !Number.isSafeInteger(item.ordinal) ||
        typeof item._id !== "string" ||
        !/^[a-f0-9]{64}$/.test(item._id) ||
        typeof item.selection?.scopeId !== "string" ||
        !/^WR-[A-F0-9]{16}$/.test(item.reference) ||
        !["doctor", "specialist"].includes(item.selection?.kind) ||
        !Number.isFinite(Date.parse(item.createdAt)) ||
        !Number.isFinite(Date.parse(item.endsAt)) ||
        !Number.isFinite(Date.parse(item.expiresAt)) ||
        new Date(item.endsAt).getTime() !==
          beirutEnd(item.selection.date, item.selection.endTime).getTime() ||
        new Date(item.expiresAt) - new Date(item.endsAt) !== 30 * 86400000
      )
        throw Error("Invalid intake identity.");
      const selected = {
        date: item.selection.date,
        professionalId: item.selection.professionalId,
        sourceSessionId: item.selection.sourceSessionId,
      };
      if (
        crypto.source(
          digest(
            Object.fromEntries(
              [
                "payloadVersion",
                "reference",
                "ordinal",
                "selection",
                "patient",
                "createdAt",
                "endsAt",
                "expiresAt",
              ].map((k) => [k, item[k]]),
            ),
          ),
        ) !== item.payloadDigest
      )
        throw Error("Intake content mismatch.");
      await transaction(async (session) => {
        await guard(session);
        const previous = await rows.findOne({ _id: item._id }, { session });
        if (previous) {
          if (previous.payloadDigest !== item.payloadDigest)
            throw Error("Intake reconciliation conflict.");
        } else {
          const r = {
            _id: item._id,
            reference: item.reference,
            ordinal: item.ordinal,
            payloadDigest: item.payloadDigest,
            patient: item.patient,
            language: item.patient.preferredLanguage,
            selection: item.selection,
            scopeId: item.selection.scopeId,
            createdAt: new Date(item.createdAt),
            endsAt: new Date(item.endsAt),
            expiresAt: new Date(item.expiresAt),
            generation: item.generation,
            tokenEnvelope: item.tokenEnvelope,
            phoneReview: item.phoneReview,
            status: "awaiting",
            searchKeys: [
              item.reference,
              ...[
                item.patient.firstName,
                item.patient.fatherName,
                item.patient.lastName,
              ],
            ].map((x) => x.trim().toLowerCase()),
            revision: 1,
            sequence: 0,
            syncedSequence: 0,
            notes: "",
          };
          if (r.expiresAt > now()) await rows.insertOne(r, { session });
        }
        await db
          .collection("website_request_sync")
          .updateOne(
            { _id: "cursor" },
            { $max: { value: item.ordinal } },
            { upsert: true, session },
          );
      });
    }
  }
  async function completeRotation(session, r, result, ctx, at) {
    if (
      !r.rotation ||
      result.requestId !== r._id ||
      result.generation !== r.rotation.generation + 1
    )
      throw fail("request_stale", "Link replacement requires reconciliation.");
    r.generation = result.generation;
    r.tokenEnvelope = result.tokenEnvelope;
    r.rotationKeys = [...(r.rotationKeys ?? []), digest(r.rotation.key)];
    delete r.rotation;
    r.revision++;
    await rows.replaceOne({ _id: r._id }, r, { session });
    await notice(session, r, "link_replaced", at);
    await audit(session, r, ctx, "link_rotated", at);
  }
  async function pump() {
    const started = Date.now();
    const hosted = config.mode === "hosted-review";
    const deadline = hosted ? pumpClock() + 75000 : null;
    const remaining = () => Math.max(0, Math.ceil(deadline - pumpClock()));
    const exhausted = () => hosted && remaining() === 0;
    const options = () => (hosted ? { remainingMs: remaining() } : undefined);
    const summary = async () => ({
      pending: await events.countDocuments({ state: "pending" }),
      ...(exhausted() ? { partial: true, budgetExhausted: true } : {}),
    });
    if (exhausted()) return summary();
    const rotations = await rows
      .find({
        rotation: { $exists: true },
        purgedAt: { $exists: false },
        expiresAt: { $gt: now() },
      })
      .limit(10)
      .toArray();
    for (const pending of rotations) {
      if (exhausted()) return summary();
      try {
        const intent = pending.rotation,
          result = await config.transport.rotate(
            {
              requestId: pending._id,
              generation: intent.generation,
              key: intent.key,
            },
            options(),
          );
        await transaction(async (session) => {
          await guard(session);
          const r = await rows.findOne({ _id: pending._id }, { session });
          if (r?.rotation?.key === intent.key)
            await completeRotation(
              session,
              r,
              result,
              { account: { _id: intent.actorId } },
              now(),
            );
        });
      } catch {
        /* Pending intent persists for bounded retry, without exposing a link. */
      }
    }

    if (exhausted()) return summary();
    const cursor =
      (await db.collection("website_request_sync").findOne({ _id: "cursor" }))
        ?.value ?? 0;
    if (exhausted()) return summary();
    await ingest(await config.transport.pull(cursor, options()));
    if (exhausted()) return summary();
    // Background reconciliation is a system action, not an employee impersonation.
    const ended = await rows
      .find({
        status: "awaiting",
        endsAt: { $lte: now() },
        purgedAt: { $exists: false },
      })
      .sort({ ordinal: 1 })
      .limit(25)
      .toArray();
    for (const entry of ended) {
      if (exhausted()) return summary();
      await transaction(async (session) => {
        await guard(session);
        const r = await rows.findOne({ _id: entry._id }, { session });
        if (r?.status === "awaiting" && !r.purgedAt)
          await decide(
            session,
            r,
            { system: true },
            "rejected",
            "session_unavailable",
            null,
            now(),
          );
      });
    }
    if (exhausted()) return summary();
    const pending = await events
      .find({ state: "pending", nextAttemptAt: { $lte: now() } })
      .sort({ requestId: 1, sequence: 1 })
      .limit(25)
      .toArray();
    for (const e of pending) {
      if (hosted ? exhausted() : Date.now() - started > 10000) break;
      try {
        const ack = await config.transport.event(e.payload, options());
        const acknowledged =
          ack.obsolete &&
          Number.isSafeInteger(ack.sequence) &&
          ack.sequence > e.sequence
            ? await events.findOne({
                requestId: e.requestId,
                sequence: ack.sequence,
              })
            : e;
        if (
          !ack.accepted ||
          !acknowledged?.payload ||
          ack.sequence !== acknowledged.sequence ||
          ack.digest !== acknowledged.payload.digest
        )
          throw Error("Invalid request acknowledgement.");
        await transaction(async (session) => {
          await guard(session);
          await events.updateOne(
            { _id: e._id, state: "pending" },
            {
              $set: { state: "accepted", acceptedAt: now() },
              $inc: { attempts: 1 },
            },
            { session },
          );
          await rows.updateOne(
            { _id: e.requestId },
            { $max: { syncedSequence: e.sequence } },
            { session },
          );
        });
      } catch (error) {
        await events.updateOne(
          { _id: e._id, state: "pending" },
          {
            $set: {
              lastError:
                error.status === 410
                  ? "tracking_expired"
                  : "public_unavailable",
              nextAttemptAt: new Date(now().getTime() + 30000),
              ...(error.status === 410 ? { state: "expired" } : {}),
            },
            $inc: { attempts: 1 },
          },
        );
      }
    }
    return summary();
  }
  async function cancelLinked(
    session,
    bookingId,
    scopeId,
    ctx,
    reason,
    at,
    except,
  ) {
    const cursor = rows
      .find(
        {
          bookingId,
          status: "confirmed",
          purgedAt: { $exists: false },
          ...(except ? { _id: { $ne: except } } : {}),
        },
        { session },
      )
      .batchSize(50);
    for await (const r of cursor) {
      if (r.scopeId !== scopeId)
        throw fail(
          "request_integrity",
          "Booking/request scope linkage requires reconciliation.",
          503,
        );
      if (r.source === "phone") {
        r.status = "cancelled";
        r.reason = reason;
        r.sequence++;
        r.revision++;
        await rows.replaceOne({ _id: r._id }, r, { session });
        await notice(session, r, "cancelled", at);
        await audit(session, r, ctx, "cancelled", at);
      } else await decide(session, r, ctx, "cancelled", reason, null, at);
    }
  }
  return {
    async bookingNotice(session, ctx, b, action, at, input) {
      const linked = await rows.findOne(
        { bookingId: b._id, status: "confirmed", purgedAt: { $exists: false } },
        { session, projection: { _id: 1 } },
      );
      if (action === "cancelled" && linked) {
        if (!Object.hasOwn(REQUEST_REASONS, input.publicReason))
          throw fail(
            "request_public_reason",
            "Choose a fixed patient-facing cancellation reason.",
            400,
          );
        await cancelLinked(
          session,
          b._id,
          b.scopeId,
          ctx,
          input.publicReason,
          at,
        );
        return;
      }
      const id = `phone:${b._id}`;
      let r = await rows.findOne({ _id: id }, { session });
      if (action === "confirmed") {
        const p = await db
          .collection("patients")
          .findOne({ _id: b.patientId }, { session });
        const endsAt = beirutEnd(b.date, b.endTime);
        r = {
          _id: id,
          source: "phone",
          reference: b.bookingNumber,
          bookingId: b._id,
          bookingReference: b.bookingNumber,
          scopeId: b.scopeId,
          patient: {
            firstName: p.firstName,
            fatherName: p.fatherName,
            lastName: p.lastName,
            phone: p.phone,
          },
          linkedPatientId: p._id,
          language: input.noticeLanguage ?? "en",
          selection: {
            date: b.date,
            startTime: b.startTime,
            endTime: b.endTime,
            professionalName: b.professionalName,
            professionalId: b.professionalId,
            kind: b.professionalId.startsWith("doctor:")
              ? "doctor"
              : "specialist",
          },
          endsAt,
          expiresAt: new Date(endsAt.getTime() + 30 * 86400000),
          generation: 0,
          status: "confirmed",
          revision: 1,
          sequence: 1,
          createdAt: at,
        };
        if (!["en", "ar"].includes(r.language))
          throw fail("request_input", "Choose notification language.", 400);
        await rows.insertOne(r, { session });
      } else if (r) {
        if (!Object.hasOwn(REQUEST_REASONS, input.publicReason))
          throw fail(
            "request_public_reason",
            "Choose a fixed patient-facing cancellation reason.",
            400,
          );
        r.status = "cancelled";
        r.reason = input.publicReason;
        r.sequence++;
        r.revision++;
        await rows.replaceOne({ _id: id }, r, { session });
      }
      if (r) await notice(session, r, action, at);
    },
    notices: (token, input = {}) =>
      run(token, false, async (session, ctx, a) => {
        exact(input, ["cursor", "state"], []);
        const q = { scopeId: { $in: scopes(ctx, a) } };
        if (input.state && input.state !== "all") {
          if (
            ![
              "pending",
              "opened",
              "sent",
              "call_required",
              "call_recorded",
              "superseded",
            ].includes(input.state)
          )
            throw fail("request_input", "Choose a notice status.", 400);
          q.state = input.state;
        } else if (input.state !== "all")
          q.state = { $in: ["pending", "opened", "call_required"] };
        if (input.cursor) q._id = { $gt: text(input.cursor, 80) };
        const found = await notices
          .find(q, { session })
          .sort({ _id: 1 })
          .limit(21)
          .toArray();
        return {
          notices: found.slice(0, 20).map((n) => ({ ...n, id: n._id })),
          nextCursor: found.length > 20 ? found[19]._id : null,
        };
      }),
    pump,
    list: (token, input = {}) =>
      run(token, false, async (session, ctx, a) => {
        exact(input, ["status", "date", "cursor", "query"], []);
        const query = {
          scopeId: { $in: scopes(ctx, a) },
          purgedAt: { $exists: false },
          source: { $ne: "phone" },
        };
        if (input.query) {
          const q = text(input.query, 80).toLowerCase();
          query.searchKeys = { $elemMatch: { $gte: q, $lt: `${q}\uffff` } };
        }
        if (input.status) {
          if (
            !["awaiting", "confirmed", "rejected", "cancelled"].includes(
              input.status,
            )
          )
            throw fail("request_input", "Choose a valid status.", 400);
          query.status = input.status;
        }
        if (input.date) query["selection.date"] = text(input.date, 10);
        if (input.cursor !== undefined) {
          if (!Number.isSafeInteger(input.cursor) || input.cursor < 0)
            throw fail("request_input", "Invalid cursor.", 400);
          query.ordinal = { $gt: input.cursor };
        }
        const found = await rows
          .find(query, {
            session,
            projection: {
              tokenEnvelope: 0,
              rotation: 0,
              rotationKeys: 0,
              notes: 0,
            },
          })
          .sort({ ordinal: 1 })
          .limit(21)
          .toArray();
        return {
          requests: found.slice(0, 20).map(dto),
          nextCursor: found.length > 20 ? found[19].ordinal : null,
        };
      }),
    refresh: async (token, input = {}) => {
      await run(token, false, async () => true);
      const result = await pump();
      return { ...result, refreshed: !result.partial };
    },
    detail: (token, input) =>
      run(token, false, async (session, ctx, a) => {
        exact(input, ["id"]);
        const r = await target(session, ctx, a, input),
          patient = { ...r.patient };
        delete patient.preferredLanguage;
        const matches = await patientService(session).check(token, {
          record: patient,
        });
        const ns = await notices
          .find({ requestId: r._id }, { session })
          .sort({ createdAt: -1 })
          .limit(25)
          .toArray();
        return {
          request: dto(r),
          matches,
          existingBookings: r.linkedPatientId
            ? await db
                .collection("bookings")
                .find(
                  {
                    patientId: r.linkedPatientId,
                    scopeId: r.scopeId,
                    date: r.selection.date,
                    sourceSessionId: r.selection.sourceSessionId,
                    status: "confirmed",
                  },
                  {
                    session,
                    projection: {
                      _id: 1,
                      bookingNumber: 1,
                      professionalName: 1,
                      date: 1,
                      startTime: 1,
                      endTime: 1,
                    },
                  },
                )
                .limit(2)
                .toArray()
            : [],
          notices: ns.map((n) => ({ id: n._id, ...n, _id: undefined })),
          audit: await db
            .collection("website_request_audit")
            .find({ requestId: r._id }, { session })
            .sort({ at: -1 })
            .limit(25)
            .toArray(),
        };
      }),
    link: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        exact(input, [
          "id",
          "revision",
          "patientId",
          "patientRevision",
          "acknowledged",
          "reason",
        ]);
        const r = await target(session, ctx, a, input);
        if (r.status !== "awaiting" || input.acknowledged !== true)
          throw fail(
            "request_input",
            "Review the patient discrepancies before linking.",
            400,
          );
        const p = (
          await patientService(session).read(token, {
            patientId: input.patientId,
          })
        ).patient;
        if (p.revision !== input.patientRevision)
          throw fail("request_stale", "The patient changed. Review again.");
        text(input.reason, 500);
        r.linkedPatientId = p.id;
        r.matchAcknowledged = true;
        r.revision++;
        await rows.replaceOne({ _id: r._id }, r, { session });
        await audit(session, r, ctx, "patient_linked", at, {
          reason: input.reason.trim(),
        });
        return { request: dto(r) };
      }),
    createPatient: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        exact(input, ["id", "revision", "reviewDigest", "duplicateOverride"]);
        const r = await target(session, ctx, a, input);
        if (r.linkedPatientId) return { request: dto(r), replayed: true };
        if (r.status !== "awaiting")
          throw fail("request_decided", "This request is already decided.");
        const record = { ...r.patient };
        delete record.preferredLanguage;
        const result = await patientService(session).create(token, {
          record,
          reviewDigest: input.reviewDigest,
          duplicateOverride: input.duplicateOverride,
        });
        if (!result.patient) return result;
        r.linkedPatientId = result.patient.id;
        r.matchAcknowledged = true;
        r.revision++;
        await rows.replaceOne({ _id: r._id }, r, { session });
        await audit(session, r, ctx, "patient_created", at);
        return { request: dto(r) };
      }),
    notes: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        exact(input, ["id", "revision", "notes"]);
        const r = await target(session, ctx, a, input);
        if (typeof input.notes !== "string" || input.notes.length > 2000)
          throw fail("request_input", "Notes are too long.", 400);
        r.notes = input.notes;
        r.revision++;
        await rows.replaceOne({ _id: r._id }, r, { session });
        await audit(session, r, ctx, "notes_updated", at);
        return { request: dto(r) };
      }),
    review: (token, input) =>
      run(token, false, async (session, ctx, a) => {
        exact(input, ["id"]);
        const r = await target(session, ctx, a, input);
        if (!r.linkedPatientId)
          throw fail("request_patient", "Link a reviewed patient first.");
        const p = (
          await patientService(session).read(token, {
            patientId: r.linkedPatientId,
          })
        ).patient;
        const result = await bookingService(session).review(token, {
          patientId: p.id,
          patientRevision: p.revision,
          date: r.selection.date,
          scopeId: r.scopeId,
          sourceSessionId: r.selection.sourceSessionId,
        });
        if (
          ["professionalId", "startTime", "endTime"].some(
            (k) => result.session[k] !== r.selection[k],
          )
        )
          throw fail(
            "request_session_changed",
            "This requested window is no longer available. Do not reschedule silently.",
          );
        return result;
      }),
    confirm: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        exact(input, ["id", "revision", "booking"]);
        const r = await target(session, ctx, a, { id: input.id });
        if (
          r.status === "confirmed" &&
          r.confirmKey === input.booking?.idempotencyKey &&
          r.confirmDigest === digest(input.booking)
        )
          return { request: dto(r), replayed: true };
        if (r.revision !== input.revision || r.status !== "awaiting")
          throw fail("request_stale", "This request changed. Review again.");
        if (
          !r.matchAcknowledged ||
          r.linkedPatientId !== input.booking?.patientId ||
          r.selection.date !== input.booking.date ||
          r.scopeId !== input.booking.scopeId ||
          r.selection.sourceSessionId !== input.booking.sourceSessionId
        )
          throw fail(
            "request_input",
            "Review this request's selected session and patient.",
            400,
          );
        assertBookableTime(r.selection, at);
        const current = resolveBookingSessions(
          a.events,
          a,
          r.selection.date,
        ).find(
          (s) =>
            s.scopeId === r.scopeId &&
            s.sourceSessionId === r.selection.sourceSessionId,
        );
        if (
          !current ||
          [
            "professionalId",
            "startTime",
            "endTime",
            "appointmentRequired",
          ].some((k) => current[k] !== r.selection[k])
        )
          throw fail(
            "request_session_changed",
            "This requested session changed. It cannot be silently rescheduled.",
          );
        const result = await bookingService(session).confirm(
          token,
          input.booking,
        );
        if (!result.booking) return result;
        r.confirmKey = input.booking.idempotencyKey;
        r.confirmDigest = digest(input.booking);
        return decide(session, r, ctx, "confirmed", null, result.booking, at);
      }),
    reconcileBooking: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        exact(input, ["id", "revision", "bookingId", "acknowledged", "reason"]);
        const r = await target(session, ctx, a, input);
        if (r.status !== "awaiting" || input.acknowledged !== true)
          throw fail(
            "request_input",
            "Explicitly review the existing booking.",
            400,
          );
        text(input.reason, 500);
        const b = await db
          .collection("bookings")
          .findOne({ _id: text(input.bookingId, 80) }, { session });
        if (
          !b ||
          b.status !== "confirmed" ||
          b.patientId !== r.linkedPatientId ||
          b.scopeId !== r.scopeId ||
          b.date !== r.selection.date ||
          b.sourceSessionId !== r.selection.sourceSessionId ||
          b.startTime !== r.selection.startTime ||
          b.endTime !== r.selection.endTime ||
          b.professionalId !== r.selection.professionalId
        )
          throw fail(
            "request_booking",
            "The existing booking does not match this request.",
          );
        await audit(session, r, ctx, "existing_booking_reconciled", at, {
          reason: input.reason,
        });
        return decide(
          session,
          r,
          ctx,
          "confirmed",
          null,
          { ...b, id: b._id },
          at,
        );
      }),
    reject: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        exact(input, ["id", "revision", "reason"]);
        const r = await target(session, ctx, a, input);
        if (r.status !== "awaiting")
          throw fail("request_decided", "This request is already decided.");
        if (!Object.hasOwn(REQUEST_REASONS, input.reason))
          throw fail(
            "request_input",
            "Choose a fixed patient-facing reason.",
            400,
          );
        return decide(session, r, ctx, "rejected", input.reason, null, at);
      }),
    cancel: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        exact(input, ["id", "revision", "reason", "privateReason"]);
        const r = await target(session, ctx, a, { id: input.id });
        if (r.status === "cancelled" && r.reason === input.reason)
          return { request: dto(r), replayed: true };
        if (
          r.revision !== input.revision ||
          r.status !== "confirmed" ||
          !Object.hasOwn(REQUEST_REASONS, input.reason)
        )
          throw fail(
            "request_stale",
            "Review the current booking and fixed reason.",
          );
        await bookingService(session).cancel(token, {
          bookingId: r.bookingId,
          reason: text(input.privateReason, 240),
        });
        await cancelLinked(
          session,
          r.bookingId,
          r.scopeId,
          ctx,
          input.reason,
          at,
          r._id,
        );
        return decide(session, r, ctx, "cancelled", input.reason, null, at);
      }),
    async rotate(token, input) {
      exact(input, ["id", "revision", "key", "reason", "confirmed"]);
      secret(input.key);
      text(input.reason, 240);
      if (input.confirmed !== true)
        throw fail(
          "request_input",
          "Confirm replacement to the original unverified submitted phone.",
          400,
        );
      const reserved = await run(token, true, async (session, ctx, a, at) => {
        const r = await target(session, ctx, a, { id: input.id });
        if (r.source === "phone" || !r.tokenEnvelope)
          throw fail(
            "request_no_tracking",
            "Phone bookings do not have a guest tracking link.",
            400,
          );
        if (r.rotationKeys?.includes(digest(input.key))) return { done: true };
        if (r.rotation && r.rotation.key !== input.key)
          throw fail(
            "request_rotation_busy",
            "A replacement is pending. Retry that request first.",
          );
        if (r.expiresAt <= at)
          throw fail("request_expired", "This tracking link has expired.");
        if (!r.rotation) {
          if (r.revision !== input.revision)
            throw fail("request_stale", "Reload this request.");
          await consumeCounter(
            db,
            `rotation-minute:${r._id}`,
            config.rotationMinute ?? 1,
            60000,
            at,
            { session },
          );
          await consumeCounter(
            db,
            `rotation-day:${r._id}`,
            config.rotationDay ?? 3,
            86400000,
            at,
            { session },
          );
          r.rotation = {
            key: input.key,
            reason: input.reason,
            actorId: ctx.account._id,
            generation: r.generation,
          };
          r.revision++;
          await rows.replaceOne({ _id: r._id }, r, { session });
          await audit(session, r, ctx, "link_rotation_requested", at, {
            reason: input.reason,
          });
        }
        return {
          requestId: r._id,
          generation: r.rotation.generation,
          key: input.key,
        };
      });
      if (reserved.done) return { rotated: true, replayed: true };
      const result = await config.transport.rotate(reserved);
      return run(token, true, async (session, ctx, a, at) => {
        const r = await target(session, ctx, a, { id: input.id });
        if (r.rotationKeys?.includes(digest(input.key)))
          return { rotated: true, replayed: true };
        if (
          r.rotation?.key !== input.key ||
          result.requestId !== r._id ||
          result.generation !== r.rotation.generation + 1
        )
          throw fail("request_stale", "Link rotation needs reconciliation.");
        await completeRotation(session, r, result, ctx, at);
        return {
          rotated: true,
          delivery:
            "Manual WhatsApp pending — replacement goes only to the original unverified submitted phone.",
        };
      });
    },
    notification: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        exact(
          input,
          [
            "noticeId",
            "action",
            "language",
            "contactAcknowledged",
            "outcome",
            "key",
          ],
          ["noticeId", "action"],
        );
        const n = await notices.findOne(
          { _id: text(input.noticeId, 80) },
          { session },
        );
        if (!n) throw fail("request_notice", "Notice unavailable.", 404);
        const r = await target(session, ctx, a, { id: n.requestId });
        const stale =
          n.version !== r.sequence ||
          n.generation !== r.generation ||
          n.state === "superseded";
        if (input.action === "preview") {
          const language = input.language ?? n.language ?? r.language;
          if (!["ar", "en"].includes(language))
            throw fail("request_input", "Choose a language.", 400);
          const phone = phoneNumber(r.patient.phone, "LB");
          return {
            phoneWarning:
              phone?.isValid() &&
              ["MOBILE", "FIXED_LINE_OR_MOBILE"].includes(phone.getType())
                ? null
                : "Phone metadata does not establish mobile/WhatsApp availability. A call alternative may be needed.",
            notice: n,
            openingUncertain: Boolean(n.openAttempt),
            stale,
            message: websiteNoticeText(
              {
                name: [
                  r.patient.firstName,
                  r.patient.fatherName,
                  r.patient.lastName,
                ].join(" "),
                reference: r.reference,
                bookingReference: r.bookingReference,
                status: n.kind,
                professional: r.selection.professionalName,
                kind: r.selection.kind,
                ...r.selection,
                reason: r.reason,
                trackingLink:
                  r.source === "phone"
                    ? null
                    : "[Private tracking link — local review only]",
                contact: config.contact,
              },
              language,
            ),
            originalPhoneUnverified: true,
          };
        }
        if (stale || r.expiresAt <= at || r.rotation)
          throw fail(
            "request_notice_stale",
            "This notice is outdated or a link replacement is pending. Review the current notice.",
          );
        const language = input.language ?? n.language ?? r.language;
        if (!["ar", "en"].includes(language))
          throw fail("request_input", "Choose Arabic or English.", 400);
        if (input.action === "configure") {
          const p = r.linkedPatientId
            ? await db
                .collection("patients")
                .findOne(
                  { _id: r.linkedPatientId },
                  { session, projection: { phone: 1, revision: 1 } },
                )
            : null;
          if (
            p &&
            p.phone !== r.patient.phone &&
            input.contactAcknowledged !== true
          )
            throw fail(
              "request_contact_review",
              "Acknowledge checking the original unverified request phone, which differs from the registry.",
            );
          n.language = language;
          n.contactReview = digest([
            r.patient.phone,
            p?.phone ?? null,
            p?.revision ?? null,
          ]);
          await notices.replaceOne({ _id: n._id }, n, { session });
          return { configured: true };
        }
        if (input.action === "opening") {
          if (
            typeof input.key !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(input.key)
          )
            throw fail("request_input", "Invalid opening request.", 400);
          if (n.state === "sent" || n.openAttempt)
            throw fail(
              "request_notice_uncertain",
              "An opening attempt is already recorded. Check WhatsApp before allowing another opening.",
            );
          n.openAttempt = { key: input.key, at, actorId: ctx.account._id };
          n.history.push({
            actorId: ctx.account._id,
            action: "opening_started",
            at,
          });
          await notices.replaceOne({ _id: n._id }, n, { session });
          return { ready: true };
        }
        if (input.action === "resolve_uncertain") {
          if (n.openAttempt) {
            delete n.openAttempt;
            n.history.push({
              actorId: ctx.account._id,
              action: "opening_checked_by_staff",
              at,
            });
            await notices.replaceOne({ _id: n._id }, n, { session });
          }
          return { resolved: true };
        }
        if (input.action === "prepare") {
          const p = r.linkedPatientId
            ? await db
                .collection("patients")
                .findOne(
                  { _id: r.linkedPatientId },
                  { session, projection: { phone: 1, revision: 1 } },
                )
            : null;
          if (
            p &&
            p.phone !== r.patient.phone &&
            input.contactAcknowledged !== true &&
            n.contactReview !== digest([r.patient.phone, p.phone, p.revision])
          )
            throw fail(
              "request_contact_review",
              "The request phone differs from the saved patient phone. Acknowledge checking the intended unverified destination.",
            );
          if (n.state === "sent")
            throw fail(
              "request_notice_sent",
              "Staff already marked this notice sent.",
            );
          const number = phoneNumber(r.patient.phone, "LB");
          if (!number?.isValid())
            throw fail(
              "request_phone",
              "This phone format cannot be used. Record a call alternative.",
            );
          let trackingLink = null;
          if (r.tokenEnvelope) {
            const raw = crypto.open(
              r.tokenEnvelope,
              `${r._id}:${r.generation}`,
            ).token;
            trackingLink = `${config.publicBase}/track#${raw}`;
          }
          const message = websiteNoticeText(
            {
              name: [
                r.patient.firstName,
                r.patient.fatherName,
                r.patient.lastName,
              ].join(" "),
              reference: r.reference,
              bookingReference: r.bookingReference,
              status: n.kind,
              professional: r.selection.professionalName,
              kind: r.selection.kind,
              ...r.selection,
              reason: r.reason,
              trackingLink,
              contact: config.contact,
            },
            language,
          );
          return {
            noticeId: n._id,
            version: n.version,
            generation: n.generation,
            phone: number.number,
            message,
            phoneWarning: ["MOBILE", "FIXED_LINE_OR_MOBILE"].includes(
              number.getType(),
            )
              ? null
              : "Phone metadata does not establish WhatsApp availability. Consider calling.",
            localReviewOnly: true,
          };
        }
        if (
          ![
            "opened",
            "open_failed",
            "uncertain",
            "sent",
            "call_required",
            "call_recorded",
          ].includes(input.action)
        )
          throw fail(
            "request_input",
            "Choose a manual notification outcome.",
            400,
          );
        if (["opened", "open_failed"].includes(input.action)) {
          if (typeof input.key !== "string")
            throw fail(
              "request_input",
              "Opening acknowledgement requires its attempt.",
              400,
            );
          if (
            n.lastOpeningKey === digest(input.key) &&
            n.lastOpeningOutcome === input.action
          )
            return { notice: n, replayed: true };
          if (!n.openAttempt || n.openAttempt.key !== input.key)
            throw fail(
              "request_notice_stale",
              "Opening acknowledgement requires its current attempt.",
            );
          delete n.openAttempt;
          n.lastOpeningKey = digest(input.key);
          n.lastOpeningOutcome = input.action;
        }
        if (
          input.action === n.state &&
          (input.action !== "call_recorded" ||
            n.history.at(-1)?.outcome === input.outcome)
        )
          return { notice: n, replayed: true };
        if (input.action === "sent" && n.state !== "opened")
          throw fail(
            "request_input",
            "Open the link first, then explicitly mark the message sent.",
            400,
          );
        if (input.action === "call_recorded") text(input.outcome, 240);
        if (input.action !== "open_failed") n.state = input.action;
        n.history.push({
          actorId: ctx.account._id,
          action: input.action,
          at,
          ...(input.action === "call_recorded"
            ? { outcome: input.outcome }
            : {}),
        });
        await notices.replaceOne({ _id: n._id }, n, { session });
        await audit(session, r, ctx, `notification_${input.action}`, at);
        return { notice: n };
      }),
    async cleanup({ apply = false } = {}) {
      const eligible = await rows.countDocuments({
        expiresAt: { $lte: now() },
        purgedAt: { $exists: false },
      });
      if (apply)
        await transaction(async (session) => {
          await guard(session);
          const targets = await rows
            .find(
              { expiresAt: { $lte: now() }, purgedAt: { $exists: false } },
              { session },
            )
            .limit(100)
            .toArray();
          for (const r of targets) {
            await rows.updateOne(
              { _id: r._id },
              {
                $unset: {
                  patient: "",
                  notes: "",
                  tokenEnvelope: "",
                  rotation: "",
                  rotationKeys: "",
                  selection: "",
                  searchKeys: "",
                },
                $set: { purgedAt: now() },
              },
              { session },
            );
            await notices.deleteMany({ requestId: r._id }, { session });
            await events.updateMany(
              { requestId: r._id },
              { $unset: { payload: "" }, $set: { state: "expired" } },
              { session },
            );
            await db
              .collection("website_request_audit")
              .updateMany(
                { requestId: r._id },
                { $unset: { reason: "", outcome: "" } },
                { session },
              );
          }
        });
      if (apply) {
        const cutoff = new Date(now() - 90 * 86400000);
        await db
          .collection("website_request_audit")
          .deleteMany({ purgeAfter: { $lte: now() } });
        await events.deleteMany({
          state: "expired",
          requestId: {
            $in: (
              await rows
                .find(
                  { purgedAt: { $exists: true }, endsAt: { $lte: cutoff } },
                  { projection: { _id: 1 } },
                )
                .limit(100)
                .toArray()
            ).map((r) => r._id),
          },
        });
      }
      if (apply) {
        const cutoff = new Date(now() - 90 * 86400000);
        await rows.deleteMany({
          purgedAt: { $exists: true },
          endsAt: { $lte: cutoff },
          bookingId: { $exists: false },
        });
        await rows.updateMany(
          { purgedAt: { $exists: true }, endsAt: { $lte: cutoff } },
          {
            $unset: {
              linkedPatientId: "",
              patient: "",
              notes: "",
              searchKeys: "",
              confirmKey: "",
              confirmDigest: "",
            },
          },
        );
      }
      return { eligible, apply };
    },
  };
}
