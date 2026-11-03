import { randomUUID } from "node:crypto";
import { StaffError } from "./errors.js";
import { allowFields } from "./management-validation.js";
import {
  dateOnly,
  identifier,
  operationalAccess,
} from "./operational-model.js";
import { validRoles } from "./permissions.js";
import { createBookingService } from "./bookings.js";
import { createPatientService } from "./patients.js";
import {
  beirutClock,
  bookingAccess,
  bookingDigest,
  loadBookingAuthority,
  resolveBookingSessions,
} from "./booking-model.js";

const fail = (code, message, status = 409) =>
  new StaffError(code, message, status);
const selectionFields = [
  "date",
  "scopeId",
  "sourceSessionId",
  "sessionVersion",
];
const checkInFields = [
  ...selectionFields,
  "bookingId",
  "expectedRevision",
  "idempotencyKey",
];
const uuid = (value) =>
  typeof value === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);

export function queueAccess(roles, grants, scope) {
  return Boolean(
    scope?.kind === "clinic" &&
    scope.active &&
    validRoles(roles) &&
    operationalAccess(roles, grants, scope).view,
  );
}
export function checkInState(s, at) {
  const clock = beirutClock(at);
  // Interpret both wall clocks on the same date axis, including opening on the preceding day.
  const minute = (date, time) => Date.parse(`${date}T${time}:00Z`) / 60000;
  const current = minute(clock.date, clock.time);
  return current < minute(s.date, s.startTime) - 30
    ? "not_open"
    : current >= minute(s.date, s.endTime)
      ? "ended"
      : "open";
}
export async function ensureQueueIndexes(db) {
  await db.collection("bookings").createIndex(
    { professionalId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        "queue.status": { $in: ["called", "in_consultation"] },
      },
      name: "queue_one_active_professional",
    },
  );
  await db.collection("bookings").createIndex(
    { datedSessionId: 1, "queue.number": 1 },
    {
      unique: true,
      partialFilterExpression: { "queue.number": { $exists: true } },
    },
  );
}
const dto = (b) => ({
  id: b.id,
  bookingNumber: b.bookingNumber,
  patientName: b.patientName,
  patientNumber: b.patientNumber,
  status: b.status,
  type:
    b.admissionKind === "extra"
      ? "Extra today"
      : b.source === "walk_in"
        ? "Walk-in"
        : b.source === "website"
          ? "Website booking"
          : b.source === "phone"
            ? "Phone booking"
            : "Booking",
  queue: b.queue ?? null,
});

export function createQueueService({
  db,
  transaction,
  guard,
  authenticated,
  now,
}) {
  const bookings = db.collection("bookings");
  function permitted(ctx, a, scopeId) {
    return queueAccess(
      ctx.account.roles,
      a.grants.find((g) => g.id === ctx.account._id)?.scopeIds ?? [],
      a.scopes.find((s) => s.id === scopeId),
    );
  }
  function authorize(ctx, a, scopeId) {
    if (!permitted(ctx, a, scopeId))
      throw fail(
        "queue_forbidden",
        "Your current role and explicit clinic assignment do not permit queue access.",
        403,
      );
  }
  function selected(a, input, at) {
    const date = dateOnly(input.date),
      scopeId = identifier(input.scopeId),
      sourceId = identifier(input.sourceSessionId);
    const s = resolveBookingSessions(a.events, a, date).find(
      (v) => v.scopeId === scopeId && v.sourceSessionId === sourceId,
    );
    if (!s || input.sessionVersion !== s.scheduleSignature)
      throw fail(
        "queue_stale",
        "The selected session changed or is no longer published. Reload sessions.",
      );
    return { ...s, checkInState: checkInState(s, at) };
  }
  async function run(token, write, action) {
    return transaction(async (session) => {
      if (write) await guard(session);
      const at = now(),
        ctx = await authenticated(session, token, at);
      if (ctx.failure) return ctx;
      if (!validRoles(ctx.account.roles))
        throw fail("queue_forbidden", "Queue access is not permitted.", 403);
      return action(session, ctx, await loadBookingAuthority(db, session), at);
    });
  }
  async function reconcileWithin(session, authority, at, datedId) {
    const clock = beirutClock(at);
    const candidates = await bookings
      .find(
        {
          status: "confirmed",
          queue: { $exists: false },
          ...(datedId ? { datedSessionId: datedId } : {}),
          $or: [
            { date: { $lt: clock.date } },
            { date: clock.date, endTime: { $lte: clock.time } },
          ],
        },
        { session },
      )
      .sort({ date: 1, ordinal: 1 })
      .limit(100)
      .maxTimeMS(2000)
      .toArray();
    let marked = 0,
      blocked = 0;
    for (const b of candidates) {
      const current = resolveBookingSessions(
        authority.events,
        authority,
        b.date,
      ).find(
        (s) =>
          s.id === b.datedSessionId &&
          s.scopeId === b.scopeId &&
          s.professionalId === b.professionalId,
      );
      if (!current || current.scheduleSignature !== b.scheduleSignature) {
        blocked++;
        continue;
      }
      if (checkInState(current, at) !== "ended") continue;
      const result = await bookings.updateOne(
        { _id: b._id, status: "confirmed", queue: { $exists: false } },
        {
          $set: { queue: { status: "no_show", revision: 1, reconciledAt: at } },
        },
        { session },
      );
      if (result.modifiedCount !== 1)
        throw fail(
          "queue_stale",
          "Session outcomes changed. Retry reconciliation.",
        );
      await db.collection("queue_changes").insertOne(
        {
          _id: randomUUID(),
          bookingId: b.id,
          datedSessionId: b.datedSessionId,
          professionalId: b.professionalId,
          action: "no_show",
          actorId: null,
          actorType: "system",
          revision: 1,
          occurredAt: at,
          before: { status: "booked" },
          after: { status: "no_show" },
        },
        { session },
      );
      await db.collection("security_events").insertOne(
        {
          _id: randomUUID(),
          targetId: b.id,
          actorId: null,
          actorType: "system",
          action: "queue_no_show",
          occurredAt: at,
          outcome: "success",
        },
        { session },
      );
      marked++;
    }
    return { marked, blocked };
  }
  const service = {
    reconcile: () =>
      transaction(async (session) => {
        await guard(session);
        return reconcileWithin(
          session,
          await loadBookingAuthority(db, session),
          now(),
        );
      }),
    sessions: (token, input) =>
      run(token, false, async (_session, ctx, a, at) => {
        allowFields(input, ["date"]);
        const date = dateOnly(input.date);
        if (!a.scopes.some((s) => permitted(ctx, a, s.id)))
          authorize(ctx, a, "");
        return {
          date,
          serverNow: at,
          sessions: resolveBookingSessions(a.events, a, date)
            .filter((s) => permitted(ctx, a, s.scopeId))
            .map((s) => ({ ...s, checkInState: checkInState(s, at) })),
        };
      }),
    list: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        allowFields(input, selectionFields);
        authorize(ctx, a, input.scopeId);
        const s = selected(a, input, at);
        await reconcileWithin(session, a, at, s.id);
        // ponytail: bounded whole-session snapshot; use cursor pages if a session exceeds 2,000 records.
        const found = await bookings
          .find(
            {
              datedSessionId: s.id,
              scopeId: s.scopeId,
              professionalId: s.professionalId,
            },
            { session },
          )
          .sort({ "queue.position": 1, ordinal: 1 })
          .limit(2001)
          .maxTimeMS(2000)
          .toArray();
        if (found.length > 2000)
          throw fail(
            "queue_unavailable",
            "This session is too large to display safely. Operator review is required.",
            503,
          );
        found.sort(
          (a, b) =>
            (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity) ||
            a.ordinal - b.ordinal,
        );
        return {
          session: s,
          serverNow: at,
          activeSlotOccupied: Boolean(
            await bookings.findOne(
              {
                professionalId: s.professionalId,
                "queue.status": { $in: ["called", "in_consultation"] },
              },
              { session, projection: { _id: 1 } },
            ),
          ),
          canAdmit: bookingAccess(
            ctx.account.roles,
            a.grants.find((g) => g.id === ctx.account._id)?.scopeIds ?? [],
            a.scopes.find((v) => v.id === s.scopeId),
          ),
          bookings: found.map(dto),
        };
      }),
    admit: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        const fields = [
          ...selectionFields,
          "patientId",
          "patientRevision",
          "patientCreate",
          "kind",
          "reason",
          "professionalAgreed",
          "idempotencyKey",
        ];
        allowFields(input, fields);
        authorize(ctx, a, input.scopeId);
        if (
          !bookingAccess(
            ctx.account.roles,
            a.grants.find((g) => g.id === ctx.account._id)?.scopeIds ?? [],
            a.scopes.find((v) => v.id === input.scopeId),
          )
        )
          throw fail(
            "queue_admission_forbidden",
            "Only an Admin or clinic-authorized Receptionist can admit patients.",
            403,
          );
        if (
          !["walk_in", "extra"].includes(input.kind) ||
          !uuid(input.idempotencyKey) ||
          Boolean(input.patientCreate) === Boolean(input.patientId)
        )
          throw fail(
            "queue_input",
            "Choose an existing patient or review a new patient.",
            400,
          );
        if (
          input.kind === "extra" &&
          (input.professionalAgreed !== true ||
            typeof input.reason !== "string" ||
            !input.reason.trim() ||
            input.reason.trim().length > 240)
        )
          throw fail(
            "queue_agreement",
            "Confirm professional agreement and enter the reason for this extra admission.",
            400,
          );
        const s = selected(a, input, at);
        const receipts = db.collection("queue_receipts"),
          key = bookingDigest([ctx.account._id, input.idempotencyKey]);
        const digest = bookingDigest([
          "admission",
          ...fields.filter((k) => k !== "idempotencyKey").map((k) => input[k]),
        ]);
        const prior = await receipts.findOne({ _id: key }, { session });
        if (prior) {
          if (prior.digest !== digest)
            throw fail(
              "queue_idempotency",
              "This admission key was used for different details.",
            );
          const b = await bookings.findOne(
            { _id: prior.bookingId, scopeId: s.scopeId, datedSessionId: s.id },
            { session },
          );
          if (!b?.queue)
            throw fail(
              "queue_unavailable",
              "The saved admission needs operator review.",
              503,
            );
          const p = await createPatientService({
            db,
            transaction: (action) => action(session),
            guard,
            authenticated,
            now,
          }).read(token, { patientId: b.patientId });
          return { booking: dto(b), patient: p.patient, replayed: true };
        }
        if (s.appointmentRequired)
          throw fail(
            "queue_appointment_required",
            "This session requires an appointment; walk-ins and extra walk-ins cannot be admitted.",
          );
        if (
          s.checkInState !== "open" ||
          (input.kind === "extra" && s.date !== beirutClock(at).date)
        )
          throw fail(
            "queue_closed",
            "Arrivals must be within the session check-in window; extra admissions are for today only.",
          );
        const inner = {
          db,
          transaction: (action) => action(session),
          guard,
          authenticated,
          now,
        };
        const patients = createPatientService(inner);
        const p = input.patientCreate
          ? (await patients.create(token, input.patientCreate)).patient
          : (await patients.read(token, { patientId: input.patientId }))
              .patient;
        if (!p)
          throw fail(
            "queue_stale",
            "Patient authorization changed. Review the patient again.",
          );
        if (!input.patientCreate && p.revision !== input.patientRevision)
          throw fail(
            "patient_stale",
            "The patient changed. Search and select them again.",
          );
        const result = await createBookingService({
          ...inner,
          source: "walk_in",
          extraAdmission: input.kind === "extra",
        }).confirm(token, {
          patientId: p.id,
          patientRevision: p.revision,
          date: s.date,
          scopeId: s.scopeId,
          sourceSessionId: s.sourceSessionId,
          sessionVersion: s.version,
          idempotencyKey:
            bookingDigest(["booking", key]).slice(0, 8) +
            "-" +
            key.slice(8, 12) +
            "-" +
            key.slice(12, 16) +
            "-" +
            key.slice(16, 20) +
            "-" +
            key.slice(20, 32),
        });
        if (!result.booking)
          throw fail(
            "queue_stale",
            "Admission authorization changed. No patient was saved.",
          );
        const arrival = await createQueueService(inner).checkIn(token, {
          ...Object.fromEntries(selectionFields.map((k) => [k, input[k]])),
          bookingId: result.booking.id,
          expectedRevision: 0,
          idempotencyKey:
            bookingDigest(["arrival", key]).slice(0, 8) +
            "-" +
            key.slice(8, 12) +
            "-" +
            key.slice(12, 16) +
            "-" +
            key.slice(16, 20) +
            "-" +
            key.slice(20, 32),
        });
        if (!arrival.booking)
          throw fail(
            "queue_stale",
            "Arrival authorization changed. Nothing was saved.",
          );
        await db.collection("queue_changes").insertOne(
          {
            _id: randomUUID(),
            bookingId: result.booking.id,
            datedSessionId: s.id,
            actorId: ctx.account._id,
            action:
              input.kind === "extra" ? "extra_admitted" : "walk_in_admitted",
            occurredAt: at,
            ...(input.kind === "extra"
              ? { reason: input.reason.trim(), professionalAgreed: true }
              : {}),
          },
          { session },
        );
        await receipts.insertOne(
          { _id: key, digest, bookingId: result.booking.id, occurredAt: at },
          { session },
        );
        return { booking: arrival.booking, patient: p };
      }),
    transition: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        const actionFields = [
          ...checkInFields,
          "action",
          "reason",
          "professionalInstructed",
          "arrivedBeforeEnd",
        ];
        allowFields(input, actionFields);
        authorize(ctx, a, input.scopeId);
        if (
          ![
            "callNext",
            "start",
            "complete",
            "absent",
            "return",
            "left",
            "outOfOrder",
            "correct",
            "restoreArrival",
          ].includes(input.action) ||
          !uuid(input.bookingId) ||
          !uuid(input.idempotencyKey) ||
          !Number.isSafeInteger(input.expectedRevision) ||
          input.expectedRevision < 1
        )
          throw fail(
            "queue_input",
            "Review the current patient and action.",
            400,
          );
        const s = selected(a, input, at);
        const key = bookingDigest([ctx.account._id, input.idempotencyKey]);
        const digest = bookingDigest([
          "transition",
          ...actionFields
            .filter((k) => k !== "idempotencyKey")
            .map((k) => input[k]),
        ]);
        const receipts = db.collection("queue_receipts");
        const prior = await receipts.findOne({ _id: key }, { session });
        if (prior && prior.digest !== digest)
          throw fail(
            "queue_idempotency",
            "This action key was used for different details.",
          );
        const b = await bookings.findOne(
          {
            _id: input.bookingId,
            datedSessionId: s.id,
            scopeId: s.scopeId,
            professionalId: s.professionalId,
          },
          { session },
        );
        if (!b || b.status !== "confirmed" || !b.queue)
          throw fail("queue_stale", "Reload the current patient.");
        if (prior) return { booking: dto(b), replayed: true };
        if (
          ["outOfOrder", "correct", "restoreArrival"].includes(input.action) &&
          (typeof input.reason !== "string" ||
            !input.reason.trim() ||
            input.reason.trim().length > 240)
        )
          throw fail(
            "queue_reason",
            "Enter a reason (up to 240 characters).",
            400,
          );
        if (
          input.action === "outOfOrder" &&
          input.professionalInstructed !== true
        )
          throw fail(
            "queue_instruction",
            "Confirm the professional instructed this out-of-order call.",
            400,
          );
        if (
          input.action === "restoreArrival" &&
          input.arrivedBeforeEnd !== true
        )
          throw fail(
            "queue_arrival_evidence",
            "Confirm this patient arrived before the session ended.",
            400,
          );
        const from = {
          callNext: ["waiting"],
          start: ["called"],
          complete: ["in_consultation"],
          absent: ["waiting", "called"],
          return: ["temporarily_absent"],
          left: ["waiting", "called", "temporarily_absent"],
          outOfOrder: ["waiting"],
          correct: [
            "waiting",
            "called",
            "in_consultation",
            "completed",
            "temporarily_absent",
            "left",
          ],
          restoreArrival: ["no_show"],
        }[input.action];
        if (
          !from.includes(b.queue.status) ||
          b.queue.revision !== input.expectedRevision
        )
          throw fail(
            "queue_stale",
            "The patient state changed. Refresh the queue.",
          );
        const active = await bookings.findOne(
          {
            professionalId: s.professionalId,
            "queue.status": { $in: ["called", "in_consultation"] },
          },
          { session },
        );
        if (["callNext", "outOfOrder"].includes(input.action)) {
          if (active)
            throw fail(
              "queue_occupied",
              "This professional already has an active patient. Refresh the queue.",
            );
          const first = await bookings
            .find(
              {
                datedSessionId: s.id,
                status: "confirmed",
                "queue.status": "waiting",
              },
              { session },
            )
            .sort({ "queue.position": 1, _id: 1 })
            .limit(1)
            .next();
          if (input.action === "callNext" && first?._id !== b._id)
            throw fail(
              "queue_stale",
              "The first waiting patient changed. Refresh the queue.",
            );
        } else if (
          ["start", "complete"].includes(input.action) &&
          active?._id !== b._id
        )
          throw fail(
            "queue_stale",
            "This patient no longer occupies the active slot.",
          );
        const state = db.collection("queue_state"),
          professionalKey = `professional:${s.professionalId}`;
        const professionalState = await state.findOne(
          { _id: professionalKey },
          { session },
        );
        const professionalRevision = professionalState?.revision ?? 0;
        const slotRevision = professionalState?.slotRevision ?? 0;
        if (
          !Number.isSafeInteger(slotRevision) ||
          slotRevision < 0 ||
          slotRevision >= Number.MAX_SAFE_INTEGER ||
          !Number.isSafeInteger(professionalRevision) ||
          professionalRevision < 0 ||
          professionalRevision >= Number.MAX_SAFE_INTEGER
        )
          throw fail(
            "queue_unavailable",
            "Professional action history requires reconciliation.",
            503,
          );
        const { lastTransition, ...before } = b.queue;
        if (input.action === "restoreArrival") {
          if (b.scheduleSignature !== s.scheduleSignature)
            throw fail(
              "queue_stale",
              "This booking no longer matches the published session.",
            );
          if (checkInState(s, at) !== "ended")
            throw fail("queue_stale", "This session has not ended.");
          const counter = await state.findOne({ _id: s.id }, { session });
          if (
            (!counter &&
              (await bookings.findOne(
                { datedSessionId: s.id, "queue.number": { $exists: true } },
                { session, projection: { _id: 1 } },
              ))) ||
            (counter &&
              ![counter.nextNumber, counter.nextPosition].every(
                (n) =>
                  Number.isSafeInteger(n) &&
                  n >= 1 &&
                  n < Number.MAX_SAFE_INTEGER,
              ))
          )
            throw fail(
              "queue_unavailable",
              "Queue numbering requires operator reconciliation.",
              503,
            );
          const number = counter?.nextNumber ?? 1,
            position = counter?.nextPosition ?? 1;
          await state.updateOne(
            { _id: s.id },
            { $set: { nextNumber: number + 1, nextPosition: position + 1 } },
            { session, upsert: true },
          );
          b.queue = {
            status: "waiting",
            revision: before.revision + 1,
            number,
            position,
            earlierArrivalReported: true,
            correctedAt: at,
            correctedBy: ctx.account._id,
          };
        } else if (input.action === "correct") {
          if (
            !lastTransition?.before ||
            lastTransition.slotRevision !== slotRevision
          )
            throw fail(
              "queue_correction_conflict",
              "Another patient has already been called; this change cannot be undone.",
            );
          if (
            ["called", "in_consultation"].includes(
              lastTransition.before.status,
            ) &&
            active &&
            active._id !== b._id
          )
            throw fail(
              "queue_occupied",
              "Another patient occupies the active slot.",
            );
          b.queue = {
            ...lastTransition.before,
            revision: before.revision + 1,
            correctedAt: at,
          };
        } else {
          b.queue.status = {
            callNext: "called",
            outOfOrder: "called",
            start: "in_consultation",
            complete: "completed",
            absent: "temporarily_absent",
            return: "waiting",
            left: "left",
          }[input.action];
          b.queue[
            {
              callNext: "calledAt",
              outOfOrder: "calledAt",
              start: "startedAt",
              complete: "completedAt",
              absent: "absentAt",
              return: "returnedAt",
              left: "leftAt",
            }[input.action]
          ] = at;
          if (input.action === "return") {
            const counter = await state.findOne({ _id: s.id }, { session });
            if (
              !Number.isSafeInteger(counter?.nextPosition) ||
              counter.nextPosition < 1 ||
              counter.nextPosition >= Number.MAX_SAFE_INTEGER
            )
              throw fail(
                "queue_unavailable",
                "Waiting order requires operator reconciliation.",
                503,
              );
            b.queue.position = counter.nextPosition;
            await state.updateOne(
              { _id: s.id },
              { $inc: { nextPosition: 1 } },
              { session },
            );
          }
          b.queue.revision++;
          b.queue.lastTransition = {
            before,
            professionalRevision: professionalRevision + 1,
            slotRevision:
              slotRevision +
              ([before.status, b.queue.status].some((status) =>
                ["called", "in_consultation"].includes(status),
              )
                ? 1
                : 0),
            action: input.action,
          };
        }
        await state.updateOne(
          { _id: professionalKey },
          {
            $set: {
              revision: professionalRevision + 1,
              slotRevision:
                slotRevision +
                ([before.status, b.queue.status].some((status) =>
                  ["called", "in_consultation"].includes(status),
                )
                  ? 1
                  : 0),
            },
          },
          { session, upsert: true },
        );
        await bookings.updateOne(
          { _id: b._id },
          { $set: { queue: b.queue } },
          { session },
        );
        await db.collection("queue_changes").insertOne(
          {
            _id: randomUUID(),
            bookingId: b.id,
            datedSessionId: s.id,
            actorId: ctx.account._id,
            action: input.action,
            revision: b.queue.revision,
            before,
            after: { ...b.queue, lastTransition: undefined },
            professionalId: s.professionalId,
            professionalRevision: professionalRevision + 1,
            ...(input.reason ? { reason: input.reason.trim() } : {}),
            ...(input.action === "outOfOrder"
              ? { professionalInstructed: true }
              : {}),
            ...(input.action === "restoreArrival"
              ? { arrivedBeforeEnd: true }
              : {}),
            occurredAt: at,
          },
          { session },
        );
        await db.collection("security_events").insertOne(
          {
            _id: randomUUID(),
            targetId: b.id,
            actorId: ctx.account._id,
            action: `queue_${input.action}`,
            occurredAt: at,
            outcome: "success",
          },
          { session },
        );
        await receipts.insertOne(
          { _id: key, digest, bookingId: b.id, occurredAt: at },
          { session },
        );
        return { booking: dto(b) };
      }),
    checkIn: (token, input) =>
      run(token, true, async (session, ctx, a, at) => {
        allowFields(input, checkInFields);
        authorize(ctx, a, input.scopeId);
        if (
          !uuid(input.bookingId) ||
          !uuid(input.idempotencyKey) ||
          !Number.isSafeInteger(input.expectedRevision) ||
          input.expectedRevision < 0 ||
          typeof input.sessionVersion !== "string" ||
          !/^[\da-f]{64}$/.test(input.sessionVersion)
        ) {
          throw fail(
            "queue_input",
            "Review the booked patient and session before check-in.",
            400,
          );
        }
        dateOnly(input.date);
        identifier(input.sourceSessionId);
        identifier(input.scopeId);
        const receipts = db.collection("queue_receipts"),
          key = bookingDigest([ctx.account._id, input.idempotencyKey]);
        const digest = bookingDigest(
          Object.fromEntries(
            checkInFields
              .filter((k) => k !== "idempotencyKey")
              .map((k) => [k, input[k]]),
          ),
        );
        const prior = await receipts.findOne({ _id: key }, { session });
        if (prior && prior.digest !== digest)
          throw fail(
            "queue_idempotency",
            "This check-in key was used for different details. Reload the waiting list.",
          );
        const b = await bookings.findOne({ _id: input.bookingId }, { session });
        if (
          !b ||
          b.scopeId !== input.scopeId ||
          b.date !== input.date ||
          b.sourceSessionId !== input.sourceSessionId
        )
          throw fail(
            "queue_booking_ineligible",
            "Choose a confirmed booking in the selected session.",
          );
        if (b.queue?.status === "no_show")
          throw fail(
            "queue_closed",
            "Check-in has ended. A missed earlier arrival requires a reasoned No-show correction.",
          );
        if (
          (Object.hasOwn(b, "queue") &&
            (!b.queue ||
              !Number.isSafeInteger(b.queue.number) ||
              b.queue.number < 1 ||
              !Number.isSafeInteger(b.queue.position) ||
              b.queue.position < 1 ||
              !Number.isSafeInteger(b.queue.revision) ||
              b.queue.revision < 1)) ||
          (prior && !b.queue)
        )
          throw fail(
            "queue_unavailable",
            "The saved arrival state requires operator reconciliation.",
            503,
          );
        // A successful retry returns its stable admission even after check-in closes.
        if (prior) return { booking: dto(b), replayed: true };
        const s = selected(a, input, at);
        if (
          b.status !== "confirmed" ||
          b.datedSessionId !== s.id ||
          b.professionalId !== s.professionalId ||
          b.scheduleSignature !== s.scheduleSignature
        )
          throw fail(
            "queue_booking_ineligible",
            "This booking is cancelled or no longer matches the selected session.",
          );
        const replayed = Boolean(b.queue);
        if (!b.queue) {
          if (input.expectedRevision !== 0)
            throw fail(
              "queue_stale",
              "The patient arrival state changed. Reload the waiting list.",
            );
          if (s.checkInState !== "open")
            throw fail(
              "queue_closed",
              "Check-in is available from 30 minutes before this session until its scheduled end.",
            );
          const counters = db.collection("queue_state"),
            old = await counters.findOne({ _id: s.id }, { session });
          if (
            (!old &&
              (await bookings.findOne(
                { datedSessionId: s.id, "queue.number": { $exists: true } },
                { session, projection: { _id: 1 } },
              ))) ||
            (old &&
              ![old.nextNumber, old.nextPosition].every(
                (n) =>
                  Number.isSafeInteger(n) &&
                  n >= 1 &&
                  n < Number.MAX_SAFE_INTEGER,
              ))
          ) {
            throw fail(
              "queue_number_unavailable",
              "Queue numbering requires operator reconciliation.",
              503,
            );
          }
          const number = old?.nextNumber ?? 1,
            position = old?.nextPosition ?? 1;
          await counters.updateOne(
            { _id: s.id },
            { $set: { nextNumber: number + 1, nextPosition: position + 1 } },
            { session, upsert: true },
          );
          b.queue = {
            status: "waiting",
            number,
            position,
            checkedInAt: at,
            checkedInBy: ctx.account._id,
            revision: 1,
          };
          const updated = await bookings.updateOne(
            { _id: b._id, queue: { $exists: false } },
            { $set: { queue: b.queue } },
            { session },
          );
          if (updated.modifiedCount !== 1)
            throw fail(
              "queue_stale",
              "The arrival state changed. Reload the waiting list.",
            );
          await db.collection("queue_changes").insertOne(
            {
              _id: randomUUID(),
              bookingId: b.id,
              datedSessionId: s.id,
              actorId: ctx.account._id,
              action: "checked_in",
              revision: 1,
              number,
              position,
              occurredAt: at,
            },
            { session },
          );
          await db.collection("security_events").insertOne(
            {
              _id: randomUUID(),
              targetId: b.id,
              actorId: ctx.account._id,
              action: "queue_checked_in",
              occurredAt: at,
              outcome: "success",
            },
            { session },
          );
        } else if (
          input.expectedRevision !== 0 &&
          input.expectedRevision !== b.queue.revision
        ) {
          throw fail(
            "queue_stale",
            "The patient arrival state changed. Reload the waiting list.",
          );
        }
        await receipts.insertOne(
          { _id: key, digest, bookingId: b.id, occurredAt: at },
          { session },
        );
        return { booking: dto(b), replayed };
      }),
  };
  return service;
}
