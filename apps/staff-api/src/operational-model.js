import { StaffError } from "./errors.js";
import { allowFields } from "./management-validation.js";
import { validDate } from "./validation.js";

const invalid = (message) => new StaffError("invalid_input", message);
export function identifier(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{1,120}$/.test(value))
    throw invalid(
      "Use a stable identifier containing letters, numbers, colon, underscore or hyphen.",
    );
  return value;
}
function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160)
    throw invalid(`Enter ${label} (up to 160 characters).`);
  return value.trim();
}
function boolean(value) {
  if (typeof value !== "boolean")
    throw invalid("Choose an explicit true/false value.");
  return value;
}
export function dateOnly(value) {
  if (!validDate(value))
    throw invalid("Use a valid center-local date (YYYY-MM-DD).");
  return value;
}
function hours(value) {
  if (
    ![value.startTime, value.endTime].every(
      (time) =>
        typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time),
    ) ||
    value.startTime >= value.endTime
  )
    throw invalid(
      "Start must be before end on the same day. Overnight sessions are not supported.",
    );
  return { startTime: value.startTime, endTime: value.endTime };
}
export function operationalAccess(roles, grants, scope) {
  const admin = roles.includes("Admin");
  const assigned = scope.active && grants.includes(scope.id);
  const clinic = scope.kind === "clinic";
  const edit =
    admin ||
    Boolean(assigned && roles.includes(clinic ? "Clinic Admin" : "Lab Admin"));
  return {
    view:
      edit ||
      Boolean(
        assigned &&
        roles.includes(clinic ? "Clinic Receptionist" : "Lab Receptionist"),
      ),
    edit,
    publish: edit,
  };
}
export function validateOperationalRecord(type, value) {
  const fields = {
    scopes: ["id", "name", "kind", "active"],
    professionals: [
      "id",
      "name",
      "specialty",
      "kind",
      "gender",
      "active",
      "scopeIds",
    ],
    sessions: [
      "id",
      "scopeId",
      "professionalId",
      "weekday",
      "startTime",
      "endTime",
      "capacity",
      "status",
      "appointmentRequired",
    ],
    exceptions: ["id", "scopeId", "date", "closed", "sessions"],
    hours: ["id", "closed", "startTime", "endTime"],
  }[type];
  if (!Array.isArray(fields))
    throw invalid("Choose a supported operational record.");
  allowFields(value, fields);
  const id = identifier(value.id);
  if (type === "scopes") {
    if (!["clinic", "service"].includes(value.kind))
      throw invalid("Choose clinic or service.");
    return {
      id,
      name: text(value.name, "a clinic/service name"),
      kind: value.kind,
      active: boolean(value.active),
    };
  }
  if (type === "professionals") {
    if (
      !["doctor", "specialist"].includes(value.kind) ||
      !["male", "female", "neutral"].includes(value.gender) ||
      !Array.isArray(value.scopeIds) ||
      !value.scopeIds.length ||
      new Set(value.scopeIds).size !== value.scopeIds.length
    )
      throw invalid(
        "Choose a professional kind, confirmed avatar gender or neutral, and unique clinic assignments.",
      );
    if (!id.startsWith(`${value.kind}:`))
      throw invalid(
        "Keep the professional's stable doctor: or specialist: identifier.",
      );
    return {
      id,
      kind: value.kind,
      name: text(value.name, "a professional name with their actual title"),
      specialty: text(value.specialty, "a specialty"),
      gender: value.gender,
      active: boolean(value.active),
      scopeIds: value.scopeIds.map(identifier),
    };
  }
  if (type === "hours") {
    if (!/^[0-6]$/.test(id)) dateOnly(id);
    return {
      id,
      closed: boolean(value.closed),
      ...(value.closed ? {} : hours(value)),
    };
  }
  if (type === "exceptions") {
    if (
      !Array.isArray(value.sessions) ||
      value.sessions.length > 60 ||
      (value.closed && value.sessions.length)
    )
      throw invalid(
        "A closed scope/day has no sessions. Use at most 60 replacement sessions.",
      );
    const scopeId = identifier(value.scopeId),
      date = dateOnly(value.date);
    const sessions = value.sessions.map((entry) =>
      validateOperationalRecord("sessions", entry),
    );
    if (
      sessions.some(
        (entry) => entry.scopeId !== scopeId || entry.weekday !== weekday(date),
      ) ||
      new Set(sessions.map((entry) => entry.id)).size !== sessions.length
    )
      throw invalid(
        "Replacement sessions must have unique IDs and belong to this scope and weekday.",
      );
    return { id, scopeId, date, closed: boolean(value.closed), sessions };
  }
  if (
    !Number.isInteger(value.weekday) ||
    value.weekday < 0 ||
    value.weekday > 6 ||
    !["active", "cancelled"].includes(value.status) ||
    !(
      value.capacity === null ||
      (Number.isSafeInteger(value.capacity) && value.capacity > 0)
    )
  )
    throw invalid(
      "Choose a weekday, active/cancelled status and positive whole capacity (or leave the draft unconfirmed).",
    );
  return {
    id,
    scopeId: identifier(value.scopeId),
    professionalId:
      value.professionalId === null ? null : identifier(value.professionalId),
    weekday: value.weekday,
    ...hours(value),
    capacity: value.capacity,
    status: value.status,
    appointmentRequired: boolean(value.appointmentRequired),
  };
}
export function weekday(date) {
  return new Date(`${dateOnly(date)}T12:00:00Z`).getUTCDay();
}
export function effectiveSessions(sessions, exceptions, date) {
  const replacements = exceptions.filter((entry) => entry.date === date);
  const replaced = new Set(replacements.map((entry) => entry.scopeId));
  return [
    ...sessions.filter(
      (entry) =>
        entry.weekday === weekday(date) && !replaced.has(entry.scopeId),
    ),
    ...replacements.flatMap((entry) => (entry.closed ? [] : entry.sessions)),
  ];
}
function checkIntervals(sessions) {
  const active = sessions.filter(
    (entry) => entry.status === "active" && entry.professionalId,
  );
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i],
        b = active[j];
      if (
        a.professionalId === b.professionalId &&
        a.startTime < b.endTime &&
        b.startTime < a.endTime
      )
        throw new StaffError(
          "schedule_overlap",
          "This professional has overlapping effective sessions. Review the schedule; no change was saved.",
          409,
        );
    }
}
export function assertNoOverlap(sessions, exceptions = []) {
  for (let day = 0; day < 7; day++)
    checkIntervals(sessions.filter((entry) => entry.weekday === day));
  for (const date of new Set(exceptions.map((entry) => entry.date)))
    checkIntervals(effectiveSessions(sessions, exceptions, date));
}
