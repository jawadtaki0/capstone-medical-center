import { createHash } from "node:crypto";
import { composePublications } from "../../../shared/published-timeline.mjs";
import { effectiveSessions } from "./operational-model.js";
import { StaffError } from "./errors.js";

export const bookingDigest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const datedSessionId = (date, scopeId, sourceSessionId) =>
  bookingDigest([date, scopeId, sourceSessionId]);
export const bookingLimitId = (date, scopeId, sourceSessionId) =>
  bookingDigest([date ?? "weekly", scopeId, sourceSessionId]);

export async function saveBookingLimits(db, session, type, value, actorId, at) {
  // Retain an explicitly saved limit even if a later private draft removes the
  // session. Only publication changes schedule availability; removal must not
  // accidentally restore an older published limit in the meantime.
  const entries = type === "sessions" ? [value] : value.sessions;
  for (const entry of entries.filter((s) => s.professionalId)) {
    const date = type === "exceptions" ? value.date : null;
    await db.collection("booking_limits").updateOne(
      { _id: bookingLimitId(date, entry.scopeId, entry.id) },
      {
        $set: {
          date,
          scopeId: entry.scopeId,
          sourceSessionId: entry.id,
          capacity: entry.capacity,
          updatedAt: at,
          updatedBy: actorId,
        },
        $inc: { revision: 1 },
      },
      { session, upsert: true },
    );
  }
}
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Beirut",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function beirutClock(at) {
  const p = Object.fromEntries(
    formatter.formatToParts(at).map(({ type, value }) => [type, value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
  };
}
export function bookingAccess(roles, grantIds, scope) {
  return Boolean(
    scope?.kind === "clinic" &&
    scope.active &&
    (roles.includes("Admin") ||
      (roles.includes("Receptionist") && grantIds.includes(scope.id))),
  );
}
// Capacity is private live policy. Only that field is read from drafts: unpublished
// hours, closures, profiles and sessions never become booking availability.
export function resolveBookingSessions(events, drafts, date) {
  const published = composePublications(events, date);
  if (!published) return [];
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const hours =
    published.hours.find((h) => h.id === date) ??
    published.hours.find((h) => h.id === String(day));
  if (!hours || hours.closed) return [];
  return effectiveSessions(
    published.sessions,
    published.exceptions,
    date,
  ).flatMap((source) => {
    const scope = published.scopes.find((s) => s.id === source.scopeId);
    const professional = published.professionals.find(
      (p) => p.id === source.professionalId,
    );
    if (
      scope?.kind !== "clinic" ||
      !scope.active ||
      !professional?.active ||
      source.status !== "active" ||
      source.startTime < hours.startTime ||
      source.endTime > hours.endTime
    )
      return [];
    const replacement = published.exceptions.some(
      (e) => e.date === date && e.scopeId === source.scopeId,
    );
    const dated = drafts.exceptions
      .find((e) => e.date === date && e.scopeId === source.scopeId)
      ?.sessions.find((s) => s.id === source.id);
    const recurring = drafts.sessions.find(
      (s) => s.id === source.id && s.scopeId === source.scopeId,
    );
    const policy =
      (drafts.limits ?? []).find(
        (p) => p._id === bookingLimitId(date, source.scopeId, source.id),
      ) ??
      (!replacement && !dated
        ? (drafts.limits ?? []).find(
            (p) => p._id === bookingLimitId(null, source.scopeId, source.id),
          )
        : undefined);
    // An explicit dated null stays null. A published dated replacement never
    // inherits a recurring limit. No copy/recalculation policy is introduced.
    const capacity = policy
      ? policy.capacity
      : dated
        ? dated.capacity
        : !replacement && recurring
          ? recurring.capacity
          : source.capacity;
    const identity = {
      date,
      scopeId: source.scopeId,
      sourceSessionId: source.id,
      professionalId: source.professionalId,
      startTime: source.startTime,
      endTime: source.endTime,
      appointmentRequired: source.appointmentRequired,
    };
    return [
      {
        ...identity,
        id: datedSessionId(date, source.scopeId, source.id),
        capacity,
        version: bookingDigest([identity, capacity]),
        scheduleSignature: bookingDigest(identity),
        publicationId: published.id,
        publicationSequence: published.sequence,
        professionalName: professional.name,
        specialty: professional.specialty,
        clinicName: scope.name,
      },
    ];
  });
}
export function assertBookableTime(value, at) {
  const clock = beirutClock(at);
  if (
    value.date < clock.date ||
    (value.date === clock.date && value.endTime <= clock.time)
  )
    throw new StaffError(
      "booking_ended",
      "This session has ended. Choose today’s remaining or a future session.",
      409,
    );
}
export async function loadBookingAuthority(db, session) {
  const options = { session };
  // MongoDB sessions do not support parallel operations in a transaction.
  const events = await db
    .collection("operational_publications")
    .find({}, options)
    .toArray();
  const sessions = await db
    .collection("operational_session_drafts")
    .find({}, options)
    .toArray();
  const exceptions = await db
    .collection("operational_date_drafts")
    .find({}, options)
    .toArray();
  const scopes = await db
    .collection("operational_scopes")
    .find({}, options)
    .toArray();
  const grants = await db
    .collection("operational_grants")
    .find({}, options)
    .toArray();
  const limits = await db
    .collection("booking_limits")
    .find({}, options)
    .toArray();
  return { events, sessions, exceptions, scopes, grants, limits };
}
export async function assertBookingIntegrity(
  db,
  session,
  authority,
  { publication = false } = {},
) {
  // Called under the SAME staff-controls write guard as booking/cancellation.
  // Inspect only occupied dates, not an invented advance-booking horizon.
  const occupied = await db
    .collection("bookings")
    .aggregate(
      [
        { $match: { status: "confirmed" } },
        {
          $group: {
            _id: "$datedSessionId",
            date: { $first: "$date" },
            count: { $sum: 1 },
            signature: { $first: "$scheduleSignature" },
          },
        },
      ],
      { session },
    )
    .toArray();
  const conflicts = [];
  for (const group of occupied) {
    const resolved = resolveBookingSessions(
      authority.events,
      authority,
      group.date,
    ).find((s) => s.id === group._id);
    if (
      (publication &&
        (!resolved || resolved.scheduleSignature !== group.signature)) ||
      (resolved &&
        (resolved.capacity === null || resolved.capacity < group.count))
    )
      conflicts.push(group._id);
  }
  if (conflicts.length) {
    // The operations UI only receives bookings in the actor's existing view scope;
    // this exception itself contains no patient data or cross-scope booking IDs.
    throw new StaffError(
      "booking_conflict",
      publication
        ? "This publication would invalidate active bookings. Open Affected bookings, cancel them through an authorized booking role, then publish again."
        : "The patient limit cannot be unset or reduced below the active confirmed count. Review affected bookings first.",
      409,
    );
  }
}
