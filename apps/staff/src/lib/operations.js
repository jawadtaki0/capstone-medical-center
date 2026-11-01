import { validPatientLimit } from "../../../../shared/session-capacity.mjs";
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export function centerToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
// Feedback only: the API remains authoritative for current roles and scopes.
export function operationalScopeError(type, record, state) {
  const sessions =
    type === "sessions"
      ? [record]
      : type === "exceptions" && !record.closed
        ? (record.sessions ?? [])
        : [];
  const allowed = (id, clinicOnly = false) =>
    state.scopes.some(
      (scope) =>
        scope.id === id &&
        scope.active &&
        scope.access.edit &&
        (!clinicOnly || scope.kind === "clinic"),
    );
  if (["sessions", "exceptions"].includes(type) && !allowed(record.scopeId))
    return "Choose a valid assigned scope.";
  if (sessions.some((s) => !validPatientLimit(s.capacity)))
    return "Enter a positive whole patient limit, or leave it blank.";
  if (type === "professionals") {
    const clinics = state.scopes.filter(
      (scope) => scope.kind === "clinic" && scope.active,
    );
    if (clinics.length !== 1)
      return "Exactly one active clinic must be configured before editing a professional.";
    if (!allowed(clinics[0].id, true))
      return "Your current account cannot edit this clinic's professionals.";
  }
  return "";
}
export function cleanOperationalRecord(type, record) {
  const fields = {
    scopes: ["id", "name", "kind", "active"],
    professionals: ["id", "name", "specialty", "kind", "gender", "active"],
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
  return Object.fromEntries(
    fields
      .filter((key) => Object.hasOwn(record, key))
      .map((key) => [
        key,
        key === "sessions"
          ? record.closed
            ? []
            : record.sessions.map((entry) =>
                cleanOperationalRecord("sessions", entry),
              )
          : record[key],
      ]),
  );
}
export function limitOnlyEdit(type, before, after) {
  if (!before.revision || !["sessions", "exceptions"].includes(type))
    return false;
  const withoutLimit = (record) =>
    JSON.stringify(cleanOperationalRecord(type, record), (key, value) =>
      key === "capacity" ? undefined : value,
    );
  return withoutLimit(before) === withoutLimit(after);
}

// One scope/date remains the stored replacement unit. A professional-only edit
// rebuilds that unit with every unaffected entry preserved, including its limit.
export function oneDateReplacement(state, date, target, closed, replacements) {
  const [kind, ...parts] = target.split("|");
  const targetId = parts.join("|");
  const professional =
    kind === "professional"
      ? state.professionals.find((p) => p.id === targetId)
      : null;
  const scopeId = professional?.scopeIds[0] ?? targetId;
  const scope = state.scopes.find(
    (s) => s.id === scopeId && s.active && s.access.edit,
  );
  if (
    !scope ||
    (kind === "professional" && (!professional || !professional.canEdit))
  )
    throw new Error("Choose a currently authorized target.");
  const prior = state.exceptions.find(
    (e) => e.scopeId === scopeId && e.date === date,
  );
  const current = scheduleForDate(state, date).filter(
    (s) => s.scopeId === scopeId,
  );
  const unaffected = professional
    ? current.filter((s) => s.professionalId !== professional.id)
    : [];
  const affected = current.filter(
    (s) => !professional || s.professionalId === professional.id,
  );
  const sessions = [...unaffected, ...(closed ? [] : replacements)].map((s) =>
    cleanOperationalRecord("sessions", s),
  );
  return {
    prior,
    current,
    affected,
    scope,
    professional,
    record: {
      id: prior?.id ?? `exception:${crypto.randomUUID()}`,
      scopeId,
      date,
      closed: !professional && closed,
      sessions,
    },
  };
}
export function scheduleForDate(data, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const changes = data.exceptions.filter((e) => e.date === date),
    scopes = new Set(changes.map((e) => e.scopeId));
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return [
    ...data.sessions.filter(
      (s) => s.weekday === weekday && !scopes.has(s.scopeId),
    ),
    ...changes.flatMap((e) => (e.closed ? [] : e.sessions)),
  ];
}
export const newSession = (scopeId, weekday = 1) => ({
  id: `session:${crypto.randomUUID()}`,
  scopeId,
  professionalId: null,
  weekday,
  startTime: "",
  endTime: "",
  capacity: null,
  status: "active",
  appointmentRequired: false,
});
