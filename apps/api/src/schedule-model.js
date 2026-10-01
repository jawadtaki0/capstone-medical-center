export const COLLECTIONS = Object.freeze({
  doctors: "doctor_profiles",
  specialists: "specialist_profiles",
  weekly: "weekly_schedules",
  changes: "schedule_date_changes",
  seeds: "schedule_seed_runs",
});

function validHours(value) {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return (
    value &&
    time.test(value.startTime) &&
    time.test(value.endTime) &&
    value.startTime < value.endTime
  );
}

export function validateScheduleDay(day) {
  if (
    !day ||
    typeof day.closed !== "boolean" ||
    !Array.isArray(day.doctorSessions) ||
    !Array.isArray(day.specialistSessions) ||
    !Array.isArray(day.otherServices)
  )
    throw new Error("Invalid schedule day.");
  const all = [
    ...day.doctorSessions,
    ...day.specialistSessions,
    ...day.otherServices,
  ];
  if (day.closed) {
    if (day.centerHours !== null || all.length)
      throw new Error("A closed day must have no sessions or service hours.");
    return;
  }
  if (!validHours(day.centerHours)) throw new Error("Invalid center hours.");
  const ids = new Set();
  for (const item of all) {
    if (
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      !validHours(item) ||
      !["active", "cancelled"].includes(item.status)
    )
      throw new Error("Invalid or duplicate session/service.");
    ids.add(item.id);
  }
  for (const session of day.doctorSessions) {
    if (
      typeof session.doctorId !== "string" ||
      typeof session.appointmentRequired !== "boolean"
    ) {
      throw new Error(
        "A doctor session needs a profile and appointment policy.",
      );
    }
  }
  for (const session of day.specialistSessions) {
    if (
      typeof session.specialistId !== "string" ||
      typeof session.appointmentRequired !== "boolean"
    ) {
      throw new Error(
        "A specialist session needs a profile and appointment policy.",
      );
    }
  }
  if (
    day.otherServices.some(
      (item) => typeof item.name !== "string" || !item.name.trim(),
    )
  ) {
    throw new Error("A service needs a name.");
  }
}
