import { createHash } from "node:crypto";
import { composePublications } from "./published-timeline.mjs";

export const MAX_PUBLICATION_BYTES = 1024 * 1024;
export class PublicationError extends Error {
  constructor(code = "invalid_publication", status = 400) {
    super(
      "The publication was not accepted. The previous public version is unchanged.",
    );
    this.code = code;
    this.status = status;
  }
}
const invalid = () => {
  throw new PublicationError();
};
const fields = {
  event: [
    "id",
    "sequence",
    "effectiveFrom",
    "publishedAt",
    "scopeIds",
    "publishesHours",
    "scopes",
    "professionals",
    "sessions",
    "exceptions",
    "hours",
  ],
  scopes: ["id", "name", "kind", "active"],
  professionals: [
    "id",
    "name",
    "specialty",
    "kind",
    "avatarVariant",
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
    "status",
    "appointmentRequired",
  ],
  exceptions: ["id", "scopeId", "date", "closed", "sessions"],
};
function object(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
function id(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{1,120}$/.test(value))
    invalid();
}
function text(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 160)
    invalid();
}
function bool(value) {
  if (typeof value !== "boolean") invalid();
}
export function calendarDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) ||
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value
  )
    invalid();
}
function timeWindow(value) {
  if (
    ![value.startTime, value.endTime].every(
      (time) =>
        typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time),
    ) ||
    value.startTime >= value.endTime
  )
    invalid();
}
function array(value, limit = 2000) {
  if (!Array.isArray(value) || value.length > limit) invalid();
}
function unique(records) {
  if (new Set(records.map((r) => r.id)).size !== records.length) invalid();
}
function project(type, value) {
  const result = Object.fromEntries(
    fields[type].map((key) => [key, value[key]]),
  );
  if (type === "professionals")
    result.avatarVariant = ["male", "female"].includes(value.gender)
      ? value.gender
      : "neutral";
  if (type === "event")
    for (const key of ["scopes", "professionals", "sessions", "exceptions"])
      result[key] = value[key].map((entry) => project(key, entry));
  if (type === "exceptions")
    result.sessions = value.sessions.map((entry) => project("sessions", entry));
  if (type === "event")
    result.hours = value.hours.map((h) => ({
      id: h.id,
      closed: h.closed,
      ...(h.closed ? {} : { startTime: h.startTime, endTime: h.endTime }),
    }));
  return result;
}
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const payloadDigest = (value) =>
  createHash("sha256").update(canonicalJSON(value)).digest("hex");
export function buildDelivery(streamId, events) {
  const result = {
    schemaVersion: 1,
    streamId,
    sequence: events.length,
    events: events.map((event) => project("event", event)),
  };
  return validateDelivery(result);
}
function validateSnapshot(snapshot) {
  const scopes = new Map(snapshot.scopes.map((s) => [s.id, s]));
  const profiles = new Map(snapshot.professionals.map((p) => [p.id, p]));
  for (const p of profiles.values())
    if (p.scopeIds.some((scope) => scopes.get(scope)?.kind !== "clinic"))
      invalid();
  const inspect = (sessions, day, date) => {
    unique(sessions);
    const hours =
      snapshot.hours.find((h) => h.id === date) ??
      snapshot.hours.find((h) => h.id === String(day));
    if (!hours) invalid();
    for (const s of sessions) {
      const scope = scopes.get(s.scopeId),
        profile = profiles.get(s.professionalId);
      if (
        !scope ||
        (scope.kind === "clinic"
          ? !profile || !profile.scopeIds.includes(scope.id)
          : s.professionalId !== null)
      )
        invalid();
      if (
        s.status === "active" &&
        !(date && hours.closed) &&
        (!scope.active ||
          (profile && !profile.active) ||
          hours.closed ||
          s.startTime < hours.startTime ||
          s.endTime > hours.endTime)
      )
        invalid();
    }
    const active = sessions.filter(
      (s) => s.status === "active" && s.professionalId,
    );
    for (let i = 0; i < active.length; i++)
      for (let j = i + 1; j < active.length; j++)
        if (
          active[i].professionalId === active[j].professionalId &&
          active[i].startTime < active[j].endTime &&
          active[j].startTime < active[i].endTime
        )
          invalid();
  };
  for (let day = 0; day < 7; day++)
    inspect(
      snapshot.sessions.filter((s) => s.weekday === day),
      day,
    );
  for (const date of new Set([
    ...snapshot.exceptions.map((e) => e.date),
    ...snapshot.hours.filter((h) => h.id.length !== 1).map((h) => h.id),
  ])) {
    const changes = snapshot.exceptions.filter((e) => e.date === date),
      replaced = new Set(changes.map((e) => e.scopeId)),
      day = new Date(`${date}T12:00:00Z`).getUTCDay();
    inspect(
      [
        ...snapshot.sessions.filter(
          (s) => s.weekday === day && !replaced.has(s.scopeId),
        ),
        ...changes.flatMap((e) => (e.closed ? [] : e.sessions)),
      ],
      day,
      date,
    );
  }
}
export function validateDelivery(value, byteLimit = MAX_PUBLICATION_BYTES) {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > byteLimit) invalid();
  object(value, ["schemaVersion", "streamId", "sequence", "events"]);
  id(value.streamId);
  array(value.events, 1000);
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    value.sequence !== value.events.length
  )
    invalid();
  for (const [index, event] of value.events.entries()) {
    object(event, fields.event);
    id(event.id);
    calendarDate(event.effectiveFrom);
    bool(event.publishesHours);
    if (
      event.sequence !== index + 1 ||
      event.id !== `publication:${index + 1}` ||
      typeof event.publishedAt !== "string" ||
      !Number.isFinite(Date.parse(event.publishedAt))
    )
      invalid();
    array(event.scopeIds, 100);
    if (
      !event.scopeIds.length ||
      new Set(event.scopeIds).size !== event.scopeIds.length
    )
      invalid();
    event.scopeIds.forEach(id);
    for (const key of [
      "scopes",
      "professionals",
      "sessions",
      "exceptions",
      "hours",
    ]) {
      array(event[key]);
      unique(event[key]);
    }
    for (const scope of event.scopes) {
      object(scope, fields.scopes);
      id(scope.id);
      text(scope.name);
      bool(scope.active);
      if (!["clinic", "service"].includes(scope.kind)) invalid();
    }
    if (
      event.scopeIds.some((scope) => !event.scopes.some((s) => s.id === scope))
    )
      invalid();
    for (const p of event.professionals) {
      object(p, fields.professionals);
      id(p.id);
      text(p.name);
      text(p.specialty);
      bool(p.active);
      if (
        !["doctor", "specialist"].includes(p.kind) ||
        !p.id.startsWith(`${p.kind}:`) ||
        !["male", "female", "neutral"].includes(p.avatarVariant)
      )
        invalid();
      array(p.scopeIds, 100);
      if (!p.scopeIds.length || new Set(p.scopeIds).size !== p.scopeIds.length)
        invalid();
      p.scopeIds.forEach(id);
    }
    const session = (s) => {
      object(s, fields.sessions);
      id(s.id);
      id(s.scopeId);
      if (s.professionalId !== null) id(s.professionalId);
      if (
        !Number.isInteger(s.weekday) ||
        s.weekday < 0 ||
        s.weekday > 6 ||
        !["active", "cancelled"].includes(s.status)
      )
        invalid();
      bool(s.appointmentRequired);
      timeWindow(s);
    };
    event.sessions.forEach(session);
    for (const e of event.exceptions) {
      object(e, fields.exceptions);
      id(e.id);
      id(e.scopeId);
      calendarDate(e.date);
      bool(e.closed);
      array(e.sessions, 60);
      if (e.closed && e.sessions.length) invalid();
      if (!event.scopes.some((s) => s.id === e.scopeId)) invalid();
      for (const s of e.sessions) {
        session(s);
        if (
          s.scopeId !== e.scopeId ||
          s.weekday !== new Date(`${e.date}T12:00:00Z`).getUTCDay()
        )
          invalid();
      }
    }
    if (
      new Set(event.exceptions.map((e) => `${e.scopeId}:${e.date}`)).size !==
      event.exceptions.length
    )
      invalid();
    for (const h of event.hours) {
      bool(h.closed);
      object(
        h,
        h.closed ? ["id", "closed"] : ["id", "closed", "startTime", "endTime"],
      );
      if (!/^[0-6]$/.test(h.id)) calendarDate(h.id);
      if (!h.closed) timeWindow(h);
    }
    if (event.hours.filter((h) => /^[0-6]$/.test(h.id)).length !== 7) invalid();
    validateSnapshot(event);
  }
  // Revalidate every effective boundary in the fully composed timeline.
  for (const date of new Set(value.events.map((e) => e.effectiveFrom)))
    validateSnapshot(composePublications(value.events, date));
  return value;
}
