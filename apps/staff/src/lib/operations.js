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
  if (
    type === "professionals" &&
    (!record.scopeIds?.length ||
      !record.scopeIds.every((id) => allowed(id, true)))
  )
    return "Choose at least one valid assigned clinic.";
  return "";
}
export function cleanOperationalRecord(type, record) {
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
