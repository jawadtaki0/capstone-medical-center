import { BSON } from "mongodb";

export function syntheticBaselineSnapshot() {
  const empty = {
    closed: true,
    centerHours: null,
    doctorSessions: [],
    specialistSessions: [],
    otherServices: [],
  };
  const day = {
    closed: false,
    centerHours: { startTime: "08:00", endTime: "16:00" },
    doctorSessions: [
      {
        id: "synthetic-session",
        doctorId: "doctor:synthetic-import",
        startTime: "10:00",
        endTime: "11:00",
        status: "active",
        appointmentRequired: true,
      },
    ],
    specialistSessions: [],
    otherServices: [
      {
        id: "synthetic-lab",
        name: "Synthetic Laboratory",
        startTime: "08:00",
        endTime: "12:00",
        status: "active",
      },
    ],
  };
  const data = {
    doctor_profiles: [
      {
        _id: "doctor:synthetic-import",
        name: "Dr. Synthetic Import",
        specialty: "Dentistry",
        active: true,
        gender: "female",
      },
    ],
    specialist_profiles: [],
    weekly_schedules: [
      {
        _id: "weekly:synthetic-import",
        effectiveFrom: null,
        publicationStatus: "published",
        publishedAt: "2026-01-01T00:00:00.000Z",
        days: Object.fromEntries(
          Array.from({ length: 7 }, (_, i) => [
            i,
            i === 1 ? structuredClone(day) : structuredClone(empty),
          ]),
        ),
      },
    ],
    schedule_date_changes: [],
    schedule_seed_runs: [],
  };
  return {
    database: "capstone_staff_test",
    collections: Object.fromEntries(
      Object.entries(data).map(([name, docs]) => [
        name,
        {
          exists: true,
          raw: docs.map((doc) => BSON.serialize(doc)),
          metadata: { indexes: [], options: {} },
        },
      ]),
    ),
  };
}

export function syntheticTransitionSnapshot(todayWeekday) {
  const snapshot = syntheticBaselineSnapshot();
  const weekly = BSON.deserialize(snapshot.collections.weekly_schedules.raw[0]);
  const doctor = BSON.deserialize(snapshot.collections.doctor_profiles.raw[0]);
  doctor.name = "Dr. Synthetic Review";
  const specialist = {
    _id: "specialist:synthetic",
    name: "Synthetic Review Therapist",
    specialty: "Therapist",
    active: true,
    gender: "male",
  };
  for (let weekday = 0; weekday < 7; weekday++)
    weekly.days[weekday] = {
      closed: weekday === 0,
      centerHours: weekday
        ? { startTime: "08:00", endTime: weekday === 6 ? "13:00" : "17:00" }
        : null,
      doctorSessions: [],
      specialistSessions: [],
      otherServices: [],
    };
  for (const weekday of new Set([1, ...(todayWeekday ? [todayWeekday] : [])])) {
    const day = weekly.days[weekday];
    day.doctorSessions.push({
      id: `synthetic-doctor:${weekday}`,
      doctorId: doctor._id,
      startTime: "09:00",
      endTime: "11:00",
      status: "active",
      appointmentRequired: false,
    });
    day.specialistSessions.push({
      id: `synthetic-therapist:${weekday}`,
      specialistId: specialist._id,
      startTime: "10:00",
      endTime: "11:00",
      status: "active",
      appointmentRequired: true,
    });
    day.otherServices.push(
      {
        id: "service:audio",
        name: "Audiometry",
        startTime: "09:00",
        endTime: "13:00",
        status: "active",
      },
      {
        id: "synthetic-lab",
        name: "Synthetic Laboratory",
        startTime: "08:00",
        endTime: "12:00",
        status: "active",
      },
    );
  }
  snapshot.collections.doctor_profiles.raw = [BSON.serialize(doctor)];
  snapshot.collections.specialist_profiles.raw = [BSON.serialize(specialist)];
  snapshot.collections.weekly_schedules.raw = [BSON.serialize(weekly)];
  return snapshot;
}
