import { StaffError } from "./errors.js";
import { effectiveSessions, assertNoOverlap } from "./operational-model.js";

const incomplete = (message) => {
  throw new StaffError("publication_incomplete", message, 409);
};
export {
  composePublications,
  publicSnapshotDatabase,
} from "../../../shared/published-timeline.mjs";

export function validatePublication(value) {
  if (value.hours.filter((h) => /^[0-6]$/.test(h.id)).length !== 7)
    incomplete(
      "Admin must confirm all seven days of center opening hours before publishing.",
    );
  const scopes = new Map(value.scopes.map((s) => [s.id, s]));
  const profiles = new Map(value.professionals.map((p) => [p.id, p]));
  const inspect = (sessions, day, date) => {
    const hours =
      value.hours.find((h) => h.id === date) ??
      value.hours.find((h) => h.id === String(day));
    if (date && hours.closed) return; // Explicit center-wide dated closure, not inferred holiday logic.
    if (new Set(sessions.map((s) => s.id)).size !== sessions.length)
      incomplete(
        "Effective session IDs must be unique across all clinics/services.",
      );
    for (const item of sessions) {
      const scope = scopes.get(item.scopeId),
        profile = item.professionalId && profiles.get(item.professionalId);
      if (
        !scope ||
        (item.professionalId &&
          (!profile || !profile.scopeIds.includes(item.scopeId)))
      )
        incomplete(
          "A session has an inconsistent professional/clinic reference.",
        );
      if (item.status !== "active") continue;
      if (!scope.active || (item.professionalId && !profile.active))
        incomplete(
          "Cancel or explicitly revise affected sessions before publishing a deactivation. History is retained.",
        );
      if (item.professionalId && !Number.isInteger(item.capacity))
        incomplete(
          "Confirm a positive patient capacity for every applicable active session before publishing. No default is supplied.",
        );
      if (
        hours.closed ||
        item.startTime < hours.startTime ||
        item.endTime > hours.endTime
      )
        incomplete(
          "Active sessions must be within the confirmed center opening hours.",
        );
    }
  };
  for (let day = 0; day < 7; day++)
    inspect(
      value.sessions.filter((s) => s.weekday === day),
      day,
    );
  for (const date of new Set([
    ...value.exceptions.map((e) => e.date),
    ...value.hours.filter((h) => !/^[0-6]$/.test(h.id)).map((h) => h.id),
  ]))
    inspect(
      effectiveSessions(value.sessions, value.exceptions, date),
      new Date(`${date}T12:00:00Z`).getUTCDay(),
      date,
    );
  assertNoOverlap(value.sessions, value.exceptions);
}
