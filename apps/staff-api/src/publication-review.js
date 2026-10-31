import { StaffError } from "./errors.js";
import { composePublications } from "../../../shared/published-timeline.mjs";

const empty = () => ({
  scopes: [],
  professionals: [],
  sessions: [],
  exceptions: [],
  hours: [],
});

// The caller validates current authority, selected IDs and versions. This is the
// exact candidate composition shared by preview and the guarded publication.
export function composeCandidate(
  data,
  events,
  scopeIds,
  effectiveFrom,
  includeHours,
) {
  const base = composePublications(events, effectiveFrom) ?? empty();
  const selected = new Set(scopeIds);
  const replaceScoped = (key) => [
    ...base[key].filter(
      (r) => !selected.has(key === "scopes" ? r.id : r.scopeId),
    ),
    ...data[key].filter((r) =>
      selected.has(key === "scopes" ? r.id : r.scopeId),
    ),
  ];
  const professionals = [...base.professionals];
  for (const profile of data.professionals.filter((p) =>
    p.scopeIds.some((id) => selected.has(id)),
  )) {
    const old = professionals.find((r) => r.id === profile.id);
    if (!profile.scopeIds.every((id) => selected.has(id))) {
      if (!old || old.revision !== profile.revision)
        throw new StaffError(
          "publication_conflict",
          "Publish every linked clinic together when changing a shared professional profile.",
          409,
        );
    } else {
      const index = professionals.findIndex((r) => r.id === profile.id);
      if (index < 0) professionals.push(profile);
      else professionals[index] = profile;
    }
  }
  return {
    scopes: replaceScoped("scopes"),
    professionals,
    sessions: replaceScoped("sessions"),
    exceptions: replaceScoped("exceptions"),
    hours: includeHours ? data.hours : base.hours,
  };
}

const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const avatar = (p) =>
  ["male", "female"].includes(p?.gender)
    ? p.gender
    : ["male", "female", "neutral"].includes(p?.avatarVariant)
      ? p.avatarVariant
      : "neutral";
const status = (active) => (active ? "Active" : "Inactive");
const hours = (record) => `${record.startTime}–${record.endTime}`;
const pick = (record, keys) =>
  Object.fromEntries(keys.map((key) => [key, record[key]]));
const sessionFields = [
  "scopeId",
  "professionalId",
  "weekday",
  "startTime",
  "endTime",
  "status",
  "appointmentRequired",
];

// An allowlisted display projection only: no revisions, raw gender, capacity or
// arbitrary record properties can enter the review result.
function publicRecord(type, record) {
  if (type === "professionals")
    return {
      ...pick(record, ["name", "specialty", "kind", "active"]),
      avatarVariant: avatar(record),
      scopeIds: [...record.scopeIds].sort(),
    };
  if (type === "scopes") return pick(record, ["name", "kind", "active"]);
  if (type === "sessions") return pick(record, sessionFields);
  if (type === "hours")
    return record.closed
      ? { closed: true }
      : pick(record, ["closed", "startTime", "endTime"]);
  throw new Error("Unsupported publication review type.");
}

// Compare accepted-public fields of two composed states, never whole private
// draft records. Bounded output retains the full count instead of hiding rows.
export function publicationChanges(prior, candidate, { limit = 400 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 400)
    throw new Error("Publication review limit must be between 1 and 400.");
  const before = prior ?? empty(),
    after = candidate ?? empty();
  const changes = [];
  let total = 0;
  const add = (type, id, label, field, oldValue, newValue) => {
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
    total++;
    if (changes.length < limit)
      changes.push({
        type,
        id,
        label,
        field,
        before: oldValue,
        after: newValue,
      });
  };
  const scopeName = (state, id) =>
    state.scopes.find((s) => s.id === id)?.name ?? id;
  const professionalName = (state, id) =>
    state.professionals.find((p) => p.id === id)?.name ?? id;
  const sessionLabel = (state, record, date) =>
    `${date ?? weekdays[record.weekday]} · ${record.professionalId ? professionalName(state, record.professionalId) : scopeName(state, record.scopeId)}`;
  const labels = {
    scopes: { name: "Name", kind: "Type", active: "Status" },
    professionals: {
      name: "Name",
      specialty: "Specialty",
      kind: "Type",
      active: "Status",
      avatarVariant: "Avatar",
      scopeIds: "Clinic/service",
    },
    sessions: {
      scopeId: "Clinic/service",
      professionalId: "Professional",
      weekday: "Weekday",
      status: "Status",
      appointmentRequired: "Appointment required",
    },
  };
  const display = (state, key, value) =>
    key === "active"
      ? status(value)
      : key === "scopeIds"
        ? value.map((id) => scopeName(state, id)).join(", ")
        : key === "scopeId"
          ? scopeName(state, value)
          : key === "professionalId"
            ? value
              ? professionalName(state, value)
              : "Service hours"
            : key === "weekday"
              ? weekdays[value]
              : key === "status"
                ? value === "active"
                  ? "Active"
                  : "Cancelled"
                : key === "appointmentRequired"
                  ? value
                    ? "Yes"
                    : "No"
                  : value;
  function compare(type, oldRows, newRows, date, parentId) {
    const oldMap = new Map(oldRows.map((r) => [r.id, r])),
      nextMap = new Map(newRows.map((r) => [r.id, r]));
    for (const id of [
      ...new Set([...oldMap.keys(), ...nextMap.keys()]),
    ].sort()) {
      const old = oldMap.get(id),
        next = nextMap.get(id),
        value = next ?? old;
      const label =
        type === "sessions"
          ? sessionLabel(next ? after : before, value, date)
          : type === "hours"
            ? `${weekdays[Number(id)] ?? id} · Center opening hours`
            : value.name;
      const rowId = parentId ? `${parentId}/${id}` : id;
      if (!old || !next) {
        const recordLabel =
          type === "sessions"
            ? "Session"
            : type === "professionals"
              ? "Professional"
              : type === "hours"
                ? "Opening hours"
                : "Clinic/service";
        const summary =
          type === "sessions"
            ? `${hours(value)} · ${value.status === "active" ? "Active" : "Cancelled"}${value.appointmentRequired ? " · Appointment required" : ""}`
            : type === "hours"
              ? value.closed
                ? "Closed"
                : hours(value)
              : `${value.name} · ${status(value.active)}`;
        add(
          type,
          rowId,
          label,
          recordLabel,
          old ? summary : "Not present",
          next ? summary : "Removed",
        );
        continue;
      }
      const oldPublic = publicRecord(type, old),
        nextPublic = publicRecord(type, next);
      if (type === "hours") {
        add(
          type,
          rowId,
          label,
          "Status",
          old.closed ? "Closed" : "Open",
          next.closed ? "Closed" : "Open",
        );
        if (!old.closed || !next.closed)
          add(
            type,
            rowId,
            label,
            "Hours",
            old.closed ? "Closed" : hours(old),
            next.closed ? "Closed" : hours(next),
          );
      } else {
        for (const [key, field] of Object.entries(labels[type])) {
          // Compare canonical IDs first: renaming a related profile is already
          // its own row and must not mark every unchanged session as edited.
          if (
            JSON.stringify(oldPublic[key]) !== JSON.stringify(nextPublic[key])
          )
            add(
              type,
              rowId,
              label,
              field,
              display(before, key, oldPublic[key]),
              display(after, key, nextPublic[key]),
            );
        }
        if (type === "sessions")
          add(type, rowId, label, "Hours", hours(oldPublic), hours(nextPublic));
      }
    }
  }
  for (const type of ["scopes", "professionals", "sessions", "hours"])
    compare(type, before[type], after[type]);
  const key = (entry) => `${entry.scopeId}/${entry.date}`;
  const oldDates = new Map(before.exceptions.map((e) => [key(e), e])),
    newDates = new Map(after.exceptions.map((e) => [key(e), e]));
  const inherited = (state, scopeId, date) =>
    state.sessions.filter(
      (s) =>
        s.scopeId === scopeId &&
        s.weekday === new Date(`${date}T12:00:00Z`).getUTCDay(),
    );
  for (const dateKey of [
    ...new Set([...oldDates.keys(), ...newDates.keys()]),
  ].sort()) {
    const old = oldDates.get(dateKey),
      next = newDates.get(dateKey),
      entry = next ?? old;
    const label = `${entry.date} · ${scopeName(next ? after : before, entry.scopeId)}`;
    add(
      "exceptions",
      entry.id,
      label,
      "Status",
      old?.closed ? "Closed" : "Open",
      next?.closed ? "Closed" : "Open",
    );
    compare(
      "sessions",
      old
        ? old.closed
          ? []
          : old.sessions
        : inherited(before, entry.scopeId, entry.date),
      next
        ? next.closed
          ? []
          : next.sessions
        : inherited(after, entry.scopeId, entry.date),
      entry.date,
      entry.id,
    );
  }
  return { changes, total, truncated: total - changes.length };
}
