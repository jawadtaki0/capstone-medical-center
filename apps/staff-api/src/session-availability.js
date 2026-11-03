import {
  loadBookingAuthority,
  resolveBookingSessions,
} from "./booking-model.js";
import {
  availabilitySlot,
  availabilitySignature,
  availabilityDigest,
} from "../../../shared/session-availability.mjs";

// Called in the same guarded transaction as booking or policy changes. No second
// counter: delivery recomputes the three public states from confirmed bookings.
export async function invalidateAvailability(db, session, date) {
  await db
    .collection("website_request_sync")
    .updateMany(
      { kind: "availability", ...(date ? { date } : {}) },
      { $set: { dirty: true } },
      { session },
    );
}
export async function prepareAvailability(db, session, dates, at) {
  if (
    !Array.isArray(dates) ||
    dates.length > 64 ||
    dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))
  )
    throw Error("Invalid availability dates.");
  const authority = await loadBookingAuthority(db, session);
  for (const date of [...new Set(dates)]) {
    const sessions = resolveBookingSessions(authority.events, authority, date);
    if (sessions.length > 100)
      throw Error("Availability page exceeds its bound.");
    const states = [];
    for (const s of sessions) {
      if (
        s.capacity !== null &&
        (!Number.isSafeInteger(s.capacity) || s.capacity < 1)
      )
        throw Error("Invalid authoritative patient limit.");
      const count =
        s.capacity === null
          ? 0
          : await db.collection("bookings").countDocuments(
              {
                datedSessionId: s.id,
                status: "confirmed",
                admissionKind: { $ne: "extra" },
              },
              { session },
            );
      states.push({
        signature: availabilitySignature(s),
        state:
          s.capacity === null
            ? "blocked"
            : count >= s.capacity
              ? "full"
              : "available",
      });
    }
    const sequence = await db
      .collection("website_request_sync")
      .findOneAndUpdate(
        { _id: "availability-sequence" },
        { $inc: { value: 1 } },
        { session, upsert: true, returnDocument: "after" },
      );
    const body = {
      date,
      sequence: sequence.value,
      generatedAt: at.toISOString(),
      sessions: states,
    };
    await db.collection("website_request_sync").updateOne(
      { _id: `availability:${availabilitySlot(date)}` },
      {
        $set: {
          kind: "availability",
          date,
          dirty: false,
          state: "pending",
          payload: { ...body, digest: availabilityDigest(body) },
        },
      },
      { session, upsert: true },
    );
  }
}
