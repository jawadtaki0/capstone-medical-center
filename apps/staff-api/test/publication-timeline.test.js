import assert from "node:assert/strict";
import test from "node:test";
import { composePublications } from "../src/operational-publication.js";

const event = (sequence, effectiveFrom, scopeId, name) => ({
  id: `publication:${sequence}`,
  sequence,
  effectiveFrom,
  publishedAt: new Date().toISOString(),
  scopeIds: [scopeId],
  publishesHours: true,
  scopes: [{ id: scopeId, name, kind: "service", active: true }],
  professionals: [],
  sessions: [],
  exceptions: [],
  hours: [{ id: "1", closed: false, startTime: "08:00", endTime: "17:00" }],
});
test("an explicitly published future scope survives a later current-date publication in another scope", () => {
  const events = [
    event(1, "2026-10-01", "one", "Original"),
    event(2, "2026-11-01", "one", "Future"),
    event(3, "2026-10-18", "two", "Current addition"),
  ];
  assert.equal(composePublications(events, "2026-10-17").scopes.length, 1);
  assert.deepEqual(
    composePublications(events, "2026-10-18").scopes.map((s) => s.name),
    ["Original", "Current addition"],
  );
  assert.deepEqual(
    composePublications(events, "2026-11-01").scopes.map((s) => s.name),
    ["Current addition", "Future"],
  );
  assert.equal(composePublications(events, "2026-09-30"), null);
  assert.equal(events[1].scopes[0].name, "Future");
});
