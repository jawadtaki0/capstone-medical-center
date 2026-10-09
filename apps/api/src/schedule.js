import { getDatabase } from "./db.js";
import { COLLECTIONS, validateScheduleDay } from "./schedule-model.js";

const TIME_ZONE = "Asia/Beirut";

export function isValidScheduleDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function getBeirutToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(
    parts.map(({ type, value: part }) => [type, part]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function emptySchedule(date, publicationStatus, centerClosed = null) {
  return {
    date,
    timeZone: TIME_ZONE,
    publicationStatus,
    centerClosed,
    centerHours: null,
    doctorSessions: [],
    specialistSessions: [],
    otherServices: [],
  };
}

function publicSessions(sessions, profiles, referenceKey, nameKey, date) {
  const byId = new Map(profiles.map((profile) => [profile._id, profile]));
  return sessions
    .map((session) => {
      const profile = byId.get(session[referenceKey]);
      if (
        !profile ||
        typeof profile.name !== "string" ||
        !profile.name.trim() ||
        typeof profile.specialty !== "string" ||
        !profile.specialty.trim()
      ) {
        throw new Error(
          "Published schedule references an unavailable profile.",
        );
      }
      return {
        id: session.id,
        [nameKey]: profile.name,
        specialty: profile.specialty,
        date,
        startTime: session.startTime,
        endTime: session.endTime,
        status: session.status,
        appointmentRequired: session.appointmentRequired,
      };
    })
    .sort((first, second) => first.startTime.localeCompare(second.startTime));
}

// All operations here are reads. Seeding and future authorized publication are separate.
export async function getScheduleForDate(date, database = undefined) {
  if (!isValidScheduleDate(date)) throw new RangeError("Invalid schedule date");
  const db = database ?? getDatabase();
  const weekly = await db.collection(COLLECTIONS.weekly).findOne(
    {
      publicationStatus: "published",
      $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: date } }],
    },
    { sort: { effectiveFrom: -1, publishedAt: -1, _id: -1 } },
  );
  if (!weekly) return emptySchedule(date, "unpublished");
  if (
    weekly.effectiveFrom !== null &&
    !isValidScheduleDate(weekly.effectiveFrom)
  ) {
    throw new Error("Invalid published weekly effective date.");
  }

  // A one-date replacement is tied to its weekly revision so stale overrides cannot leak.
  const change = await db.collection(COLLECTIONS.changes).findOne(
    {
      weeklyScheduleId: weekly._id,
      date,
      publicationStatus: "published",
    },
    { sort: { publishedAt: -1, _id: -1 } },
  );
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const day = change ? change.day : weekly.days?.[weekday];
  validateScheduleDay(day);
  if (day.closed) return emptySchedule(date, "published", true);

  const queryProfiles = (collection, ids) =>
    ids.length
      ? db
          .collection(collection)
          .find(
            {
              _id: { $in: ids },
              active: true,
            },
            { projection: { _id: 1, name: 1, specialty: 1 } },
          )
          .toArray()
      : Promise.resolve([]);
  const [doctors, specialists] = await Promise.all([
    queryProfiles(
      COLLECTIONS.doctors,
      day.doctorSessions.map((session) => session.doctorId),
    ),
    queryProfiles(
      COLLECTIONS.specialists,
      day.specialistSessions.map((session) => session.specialistId),
    ),
  ]);

  return {
    date,
    timeZone: TIME_ZONE,
    publicationStatus: "published",
    centerClosed: false,
    centerHours: {
      startTime: day.centerHours.startTime,
      endTime: day.centerHours.endTime,
    },
    doctorSessions: publicSessions(
      day.doctorSessions,
      doctors,
      "doctorId",
      "doctorName",
      date,
    ),
    specialistSessions: publicSessions(
      day.specialistSessions,
      specialists,
      "specialistId",
      "name",
      date,
    ),
    otherServices: day.otherServices
      .filter((service) => service.status === "active")
      .map((service) => ({
        id: service.id,
        name: service.name,
        date,
        startTime: service.startTime,
        endTime: service.endTime,
      })),
  };
}
