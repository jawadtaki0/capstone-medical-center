import { randomUUID } from "node:crypto";
import { StaffError } from "./errors.js";
import {
  dateOnly,
  identifier,
  operationalAccess,
} from "./operational-model.js";
import { validRoles } from "./permissions.js";
import { allowFields } from "./management-validation.js";
import {
  bookingDigest,
  bookingAccess,
  beirutClock,
  assertBookableTime,
  loadBookingAuthority,
  resolveBookingSessions,
} from "./booking-model.js";

const fail = (code, message, status = 409) =>
  new StaffError(code, message, status);
const uuid = (value) => {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
  )
    throw fail(
      "booking_input",
      "Choose a valid patient and confirmation request.",
      400,
    );
  return value;
};
export async function ensureBookingIndexes(db) {
  const b = db.collection("bookings");
  await b.createIndex({ bookingNumber: 1 }, { unique: true });
  await b.createIndex({ actorId: 1, idempotencyKey: 1 }, { unique: true });
  await b.createIndex(
    { datedSessionId: 1, patientId: 1 },
    { unique: true, partialFilterExpression: { status: "confirmed" } },
  );
  await b.createIndex({ date: 1, scopeId: 1, ordinal: 1 });
  await b.createIndex({ patientId: 1, date: 1, status: 1 });
  await b.createIndex({ status: 1, date: 1, ordinal: 1 });
  await db
    .collection("booking_changes")
    .createIndex({ bookingId: 1, occurredAt: -1 });
}
const dto = (b) =>
  Object.fromEntries(
    [
      "id",
      "bookingNumber",
      "patientId",
      "patientNumber",
      "patientName",
      "datedSessionId",
      "sourceSessionId",
      "scopeId",
      "professionalId",
      "professionalName",
      "date",
      "startTime",
      "endTime",
      "status",
      "createdAt",
      "cancelledAt",
      "cancellationReason",
    ]
      .filter((k) => b[k] !== undefined)
      .map((k) => [k, b[k]]),
  );
export function createBookingService({
  db,
  transaction,
  guard,
  authenticated,
  now,
}) {
  const bookings = db.collection("bookings");
  const grants = (a, id) => a.grants.find((g) => g.id === id)?.scopeIds ?? [];
  const canBook = (context, a, scopeId) =>
    bookingAccess(
      context.account.roles,
      grants(a, context.account._id),
      a.scopes.find((s) => s.id === scopeId) && {
        ...a.scopes.find((s) => s.id === scopeId),
        active: true,
      },
    );
  const canView = (context, a, scopeId) => {
    const scope = a.scopes.find((s) => s.id === scopeId);
    return (
      scope?.kind === "clinic" &&
      operationalAccess(context.account.roles, grants(a, context.account._id), {
        ...scope,
        active: true,
      }).view
    );
  };
  function authorize(context, a, scopeId, view = false) {
    if (!(view ? canView(context, a, scopeId) : canBook(context, a, scopeId)))
      throw fail(
        "booking_forbidden",
        "Your current roles and explicit clinic assignment do not permit this booking action.",
        403,
      );
  }
  async function run(token, write, action) {
    return transaction(async (session) => {
      if (write) await guard(session);
      const at = now(),
        context = await authenticated(session, token, at);
      if (context.failure) return context;
      if (!validRoles(context.account.roles))
        throw fail(
          "booking_forbidden",
          "Booking access is not permitted.",
          403,
        );
      return action(
        session,
        context,
        await loadBookingAuthority(db, session),
        at,
      );
    });
  }
  async function audit(session, context, b, action, at, reason) {
    await db.collection("booking_changes").insertOne(
      {
        _id: randomUUID(),
        bookingId: b.id,
        actorId: context.account._id,
        action,
        occurredAt: at,
        ...(reason ? { reason } : {}),
      },
      { session },
    );
    await db.collection("security_events").insertOne(
      {
        _id: randomUUID(),
        targetId: b.id,
        actorId: context.account._id,
        action: `booking_${action}`,
        occurredAt: at,
        outcome: "success",
      },
      { session },
    );
  }
  async function patient(input, session) {
    const p = await db
      .collection("patients")
      .findOne({ _id: uuid(input.patientId) }, { session });
    if (!p) throw fail("patient_missing", "Select an existing patient.", 404);
    if (
      !Number.isSafeInteger(input.patientRevision) ||
      input.patientRevision !== p.revision
    )
      throw fail(
        "patient_stale",
        "The selected patient changed. Search and review the patient again.",
      );
    return p;
  }
  function selected(a, input, at) {
    const date = dateOnly(input.date),
      sourceId = identifier(input.sourceSessionId),
      scopeId = identifier(input.scopeId);
    const s = resolveBookingSessions(a.events, a, date).find(
      (v) => v.sourceSessionId === sourceId && v.scopeId === scopeId,
    );
    if (!s)
      throw fail(
        "booking_unavailable",
        "This session is no longer published or available. Reload sessions.",
      );
    assertBookableTime(s, at);
    return s;
  }
  async function availability(s, session) {
    const confirmed = await bookings.countDocuments(
      { datedSessionId: s.id, status: "confirmed" },
      { session },
    );
    return {
      ...s,
      confirmed,
      remaining:
        s.capacity === null ? null : Math.max(0, s.capacity - confirmed),
    };
  }
  async function overlaps(p, s, session) {
    return (
      await bookings
        .find(
          {
            patientId: p._id,
            date: s.date,
            status: "confirmed",
            datedSessionId: { $ne: s.id },
            startTime: { $lt: s.endTime },
            endTime: { $gt: s.startTime },
          },
          { session },
        )
        .sort({ ordinal: 1 })
        .limit(21)
        .toArray()
    ).map(dto);
  }
  const requestFields = [
    "patientId",
    "patientRevision",
    "date",
    "scopeId",
    "sourceSessionId",
  ];
  return {
    affected: (token, input) =>
      run(token, false, async (session, context, a) => {
        allowFields(input, ["cursor"]);
        const scopeIds = a.scopes
          .filter((s) => canView(context, a, s.id))
          .map((s) => s.id);
        if (!scopeIds.length)
          throw fail(
            "booking_forbidden",
            "Clinic schedule authority or an explicit clinic assignment is required.",
            403,
          );
        let cursor;
        if (input.cursor !== undefined) {
          if (
            typeof input.cursor !== "string" ||
            !/^\d{4}-\d{2}-\d{2}:B-\d{8,16}$/.test(input.cursor)
          )
            throw fail("booking_input", "Reload affected bookings.", 400);
          cursor = {
            date: input.cursor.slice(0, 10),
            number: input.cursor.slice(11),
          };
        }
        const found = await bookings
          .find(
            {
              status: "confirmed",
              scopeId: { $in: scopeIds },
              ...(cursor
                ? {
                    $or: [
                      { date: { $gt: cursor.date } },
                      {
                        date: cursor.date,
                        ordinal: { $gt: Number(cursor.number.slice(2)) },
                      },
                    ],
                  }
                : {}),
            },
            { session },
          )
          .sort({ date: 1, ordinal: 1 })
          .limit(51)
          .maxTimeMS(2000)
          .toArray();
        return {
          bookings: found.slice(0, 50).map((b) => ({
            ...dto(b),
            canCancel: canBook(context, a, b.scopeId),
          })),
          nextCursor:
            found.length > 50
              ? `${found[49].date}:${found[49].bookingNumber}`
              : null,
        };
      }),
    sessions: (token, input) =>
      run(token, false, async (session, context, a, at) => {
        allowFields(input, ["date"]);
        const date = dateOnly(input.date);
        if (date < beirutClock(at).date)
          throw fail("booking_ended", "Choose today or a future date.");
        const scopes = a.scopes.filter(
          (s) => s.kind === "clinic" && canView(context, a, s.id),
        );
        if (!scopes.length)
          throw fail(
            "booking_forbidden",
            "An explicit clinic assignment or Admin authority is required.",
            403,
          );
        const sessions = [];
        for (const s of resolveBookingSessions(a.events, a, date).filter((v) =>
          scopes.some((scope) => scope.id === v.scopeId),
        )) {
          if (
            date === beirutClock(at).date &&
            s.endTime <= beirutClock(at).time
          )
            continue;
          sessions.push({
            ...(await availability(s, session)),
            canBook: canBook(context, a, s.scopeId),
          });
        }
        return {
          date,
          sessions,
          scopes: scopes.map((s) => ({
            id: s.id,
            name: s.name,
            canBook: canBook(context, a, s.id),
          })),
        };
      }),
    review: (token, input) =>
      run(token, false, async (session, context, a, at) => {
        allowFields(input, requestFields);
        authorize(context, a, input.scopeId);
        const p = await patient(input, session),
          s = selected(a, input, at);
        return {
          session: await availability(s, session),
          patient: {
            id: p._id,
            patientNumber: p.patientNumber,
            revision: p.revision,
            firstName: p.firstName,
            fatherName: p.fatherName,
            lastName: p.lastName,
          },
          overlaps: await overlaps(p, s, session),
        };
      }),
    confirm: (token, input) =>
      run(token, true, async (session, context, a, at) => {
        allowFields(input, [
          ...requestFields,
          "sessionVersion",
          "idempotencyKey",
        ]);
        authorize(context, a, input.scopeId);
        uuid(input.idempotencyKey);
        if (
          typeof input.sessionVersion !== "string" ||
          !/^[\da-f]{64}$/.test(input.sessionVersion)
        )
          throw fail(
            "booking_input",
            "Review the selected session before confirming.",
            400,
          );
        const meaningful = Object.fromEntries(
          [...requestFields, "sessionVersion"].map((k) => [k, input[k]]),
        );
        const requestDigest = bookingDigest(meaningful);
        const prior = await bookings.findOne(
          {
            actorId: context.account._id,
            idempotencyKey: input.idempotencyKey,
          },
          { session },
        );
        if (prior) {
          if (prior.requestDigest !== requestDigest)
            throw fail(
              "booking_idempotency",
              "This confirmation key was used for different booking details. Start a new review.",
            );
          return { booking: dto(prior), replayed: true };
        }
        const p = await patient(input, session),
          s = selected(a, input, at);
        if (input.sessionVersion !== s.version)
          throw fail(
            "booking_stale",
            "The session or patient limit changed. Review availability again.",
          );
        const capacity = await availability(s, session);
        if (capacity.remaining === null)
          throw fail(
            "booking_limit_unset",
            "Patient limit is Not configured. An authorized schedule manager must configure it first.",
          );
        if (
          await bookings.findOne(
            { datedSessionId: s.id, patientId: p._id, status: "confirmed" },
            { session },
          )
        )
          throw fail(
            "booking_duplicate",
            "This patient already has an active booking in this session.",
          );
        if (!capacity.remaining)
          throw fail(
            "booking_full",
            "This session is full. No ordinary booking place remains.",
          );
        const counter = db.collection("booking_state"),
          old = await counter.findOne({ _id: "numbers" }, { session });
        if (
          (!old &&
            (await bookings.findOne(
              {},
              { session, projection: { _id: 1 } },
            ))) ||
          (old &&
            (!Number.isSafeInteger(old.next) ||
              old.next < 1 ||
              old.next >= Number.MAX_SAFE_INTEGER))
        )
          throw fail(
            "booking_number_unavailable",
            "Booking numbering requires operator reconciliation.",
            503,
          );
        const number = old?.next ?? 1;
        await counter.updateOne(
          { _id: "numbers" },
          { $set: { next: number + 1 } },
          { session, upsert: true },
        );
        const b = {
          _id: randomUUID(),
          id: undefined,
          ordinal: number,
          bookingNumber: `B-${String(number).padStart(8, "0")}`,
          patientId: p._id,
          patientNumber: p.patientNumber,
          patientName: [p.firstName, p.fatherName, p.lastName].join(" "),
          datedSessionId: s.id,
          sourceSessionId: s.sourceSessionId,
          scopeId: s.scopeId,
          professionalId: s.professionalId,
          professionalName: s.professionalName,
          date: s.date,
          startTime: s.startTime,
          endTime: s.endTime,
          scheduleSignature: s.scheduleSignature,
          publicationId: s.publicationId,
          publicationSequence: s.publicationSequence,
          limitAtConfirmation: s.capacity,
          status: "confirmed",
          actorId: context.account._id,
          createdAt: at,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
        };
        b.id = b._id;
        await bookings.insertOne(b, { session });
        await audit(session, context, b, "confirmed", at);
        return { booking: dto(b), overlaps: await overlaps(p, s, session) };
      }),
    list: (token, input) =>
      run(token, false, async (session, context, a) => {
        allowFields(input, ["date", "scopeId", "cursor"]);
        const date = dateOnly(input.date),
          scopeId = identifier(input.scopeId);
        authorize(context, a, scopeId, true);
        if (
          input.cursor !== undefined &&
          (typeof input.cursor !== "string" ||
            !/^B-\d{8,16}$/.test(input.cursor))
        )
          throw fail("booking_input", "Reload the booking list.", 400);
        const found = await bookings
          .find(
            {
              date,
              scopeId,
              ...(input.cursor
                ? { ordinal: { $gt: Number(input.cursor.slice(2)) } }
                : {}),
            },
            { session },
          )
          .sort({ ordinal: 1 })
          .limit(51)
          .maxTimeMS(2000)
          .toArray();
        return {
          bookings: found.slice(0, 50).map(dto),
          nextCursor: found.length > 50 ? found[49].bookingNumber : null,
          canCancel: canBook(context, a, scopeId),
        };
      }),
    cancel: (token, input) =>
      run(token, true, async (session, context, a, at) => {
        allowFields(input, ["bookingId", "reason"]);
        const b = await bookings.findOne(
          { _id: uuid(input.bookingId) },
          { session },
        );
        if (!b) throw fail("booking_missing", "Booking not found.", 404);
        authorize(context, a, b.scopeId);
        if (
          typeof input.reason !== "string" ||
          !input.reason.trim() ||
          input.reason.trim().length > 240
        )
          throw fail(
            "booking_input",
            "Enter a short cancellation reason (up to 240 characters).",
            400,
          );
        if (b.status === "cancelled")
          return { booking: dto(b), replayed: true };
        b.status = "cancelled";
        b.cancelledAt = at;
        b.cancelledBy = context.account._id;
        b.cancellationReason = input.reason.trim();
        await bookings.replaceOne({ _id: b._id }, b, { session });
        await audit(session, context, b, "cancelled", at, b.cancellationReason);
        return { booking: dto(b) };
      }),
  };
}
