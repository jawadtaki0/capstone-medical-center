import { createHash } from "node:crypto";
export const AVAILABILITY_FRESH_MS = 120000;
export const AVAILABILITY_STATES = ["available", "full", "blocked"];
export const availabilityDigest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Fixed-size cache slots bound storage even when arbitrary future dates are browsed.
// A collision evicts advisory information only: it never invents availability.
export const availabilitySlot = (date) =>
  parseInt(availabilityDigest(date).slice(0, 4), 16) % 64;
export const availabilitySignature = (s) =>
  availabilityDigest([
    s.date,
    s.scopeId,
    s.sourceSessionId,
    s.professionalId,
    s.startTime,
    s.endTime,
  ]);
export function publicAvailability(session, snapshot, now) {
  const age = new Date(now).getTime() - Date.parse(snapshot?.generatedAt);
  if (
    snapshot?.date !== session.date ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > AVAILABILITY_FRESH_MS
  )
    return "unknown";
  return (
    snapshot.sessions.find(
      (s) => s.signature === availabilitySignature(session),
    )?.state ?? "unknown"
  );
}
export function validateAvailability(input) {
  const keys = ["date", "sequence", "generatedAt", "sessions", "digest"];
  if (
    !input ||
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((k) => !keys.includes(k)) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
    new Date(`${input.date}T12:00:00Z`).toISOString().slice(0, 10) !==
      input.date ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !Number.isFinite(Date.parse(input.generatedAt)) ||
    !Array.isArray(input.sessions) ||
    input.sessions.length > 100 ||
    input.sessions.some(
      (s) =>
        !s ||
        Object.keys(s).length !== 2 ||
        !/^[a-f0-9]{64}$/.test(s.signature) ||
        !AVAILABILITY_STATES.includes(s.state),
    ) ||
    new Set(input.sessions.map((s) => s.signature)).size !==
      input.sessions.length
  )
    throw Error("Invalid availability projection.");
  const { digest, ...body } = input;
  if (availabilityDigest(body) !== digest)
    throw Error("Invalid availability digest.");
  return input;
}
