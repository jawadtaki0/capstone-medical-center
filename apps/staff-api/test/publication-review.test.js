import test from "node:test";
import assert from "node:assert/strict";
import {
  composeCandidate,
  publicationChanges,
} from "../src/publication-review.js";
import { composePublications } from "../../../shared/published-timeline.mjs";

const source = () => ({
  scopes: [
    {
      id: "clinic:one",
      name: "Synthetic clinic",
      kind: "clinic",
      active: true,
    },
    {
      id: "service:lab",
      name: "Synthetic laboratory",
      kind: "service",
      active: true,
    },
  ],
  professionals: [
    {
      id: "doctor:one",
      name: "Synthetic doctor",
      specialty: "Synthetic specialty",
      kind: "doctor",
      gender: "male",
      active: true,
      scopeIds: ["clinic:one"],
      revision: 1,
    },
  ],
  sessions: [
    {
      id: "weekly:one",
      scopeId: "clinic:one",
      professionalId: "doctor:one",
      weekday: 4,
      startTime: "09:00",
      endTime: "11:00",
      capacity: 3,
      status: "active",
      appointmentRequired: true,
      revision: 1,
    },
  ],
  exceptions: [],
  hours: [{ id: "4", closed: false, startTime: "08:00", endTime: "17:00" }],
});
const event = (data, extra = {}) => ({
  id: "publication:1",
  sequence: 1,
  effectiveFrom: null,
  scopeIds: data.scopes.map((s) => s.id),
  publishesHours: true,
  ...structuredClone(data),
  ...extra,
});

test("candidate preserves unrelated scope content and center hours for a scoped update", () => {
  const before = source(),
    drafts = structuredClone(before);
  drafts.scopes[1].name = "Uncommitted laboratory change";
  drafts.hours[0].endTime = "18:00";
  drafts.sessions[0].endTime = "12:00";
  const result = composeCandidate(
    drafts,
    [event(before)],
    ["clinic:one"],
    "2026-11-05",
    false,
  );
  assert.equal(
    result.scopes.find((s) => s.id === "service:lab").name,
    "Synthetic laboratory",
  );
  assert.equal(result.hours[0].endTime, "17:00");
  assert.equal(result.sessions[0].endTime, "12:00");
  assert.equal(
    drafts.scopes[1].name,
    "Uncommitted laboratory change",
    "input remains unchanged",
  );
});

test("comparison uses the selected effective-date composite including later scope publications", () => {
  const before = source(),
    future = source();
  future.sessions[0].endTime = "12:00";
  const events = [
    event(before),
    event(future, {
      id: "publication:2",
      sequence: 2,
      effectiveFrom: "2026-12-01",
      scopeIds: ["clinic:one"],
      publishesHours: false,
    }),
  ];
  const early = composeCandidate(
    future,
    events,
    ["clinic:one"],
    "2026-11-01",
    false,
  );
  assert.equal(
    publicationChanges(composePublications(events, "2026-11-01"), early).total,
    1,
  );
  const late = composeCandidate(
    future,
    events,
    ["clinic:one"],
    "2026-12-01",
    false,
  );
  assert.equal(
    publicationChanges(composePublications(events, "2026-12-01"), late).total,
    0,
  );
});

test("shared professional requires linked scopes together unless the exact old revision remains", () => {
  const before = source();
  before.scopes.push({
    id: "clinic:two",
    name: "Second synthetic clinic",
    kind: "clinic",
    active: true,
  });
  before.professionals[0].scopeIds.push("clinic:two");
  const drafts = structuredClone(before);
  drafts.professionals[0].revision = 2;
  assert.throws(
    () =>
      composeCandidate(
        drafts,
        [event(before)],
        ["clinic:one"],
        "2026-11-01",
        false,
      ),
    (e) => e.code === "publication_conflict",
  );
  drafts.professionals[0].revision = 1;
  const result = composeCandidate(
    drafts,
    [event(before)],
    ["clinic:one"],
    "2026-11-01",
    false,
  );
  assert.deepEqual(result.professionals, before.professionals);
  assert.throws(
    () => composeCandidate(drafts, [], ["clinic:one"], null, false),
    (e) => e.code === "publication_conflict",
  );
});

test("private limit/revision changes are absent while public avatar and actual hours are shown", () => {
  const before = source(),
    after = structuredClone(before);
  after.sessions[0].capacity = 1;
  after.sessions[0].revision++;
  after.professionals[0].revision++;
  assert.equal(publicationChanges(before, after).total, 0);
  after.professionals[0].gender = "female";
  after.sessions[0].endTime = "12:00";
  const result = publicationChanges(before, after);
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.changes.find((c) => c.field === "Hours"),
    {
      type: "sessions",
      id: "weekly:one",
      label: "Thursday · Synthetic doctor",
      field: "Hours",
      before: "09:00–11:00",
      after: "09:00–12:00",
    },
  );
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /capacity|gender|revision/);
  assert.match(text, /Avatar/);
});

test("dated closure/replacement reviews include only changed nested sessions and preserve unchanged peers", () => {
  const before = source();
  before.exceptions = [
    {
      id: "dated:one",
      scopeId: "clinic:one",
      date: "2026-11-05",
      closed: false,
      sessions: [
        structuredClone(before.sessions[0]),
        {
          ...before.sessions[0],
          id: "other:session",
          professionalId: "doctor:other",
          startTime: "12:00",
          endTime: "13:00",
        },
      ],
    },
  ];
  const after = structuredClone(before);
  after.exceptions[0].sessions[0].endTime = "10:00";
  let result = publicationChanges(before, after);
  assert.equal(result.total, 1);
  assert.equal(result.changes[0].id, "dated:one/weekly:one");
  assert.match(result.changes[0].label, /2026-11-05/);
  assert.doesNotMatch(JSON.stringify(result), /other:session/);
  after.exceptions[0].closed = true;
  after.exceptions[0].sessions = [];
  result = publicationChanges(before, after);
  assert(
    result.changes.some((c) => c.field === "Status" && c.after === "Closed"),
  );
  assert(
    result.changes.some((c) => c.field === "Session" && c.after === "Removed"),
  );
});

test("added/removed sessions and deactivation have concise explicit review rows", () => {
  const before = source(),
    after = structuredClone(before);
  after.professionals[0].active = false;
  after.sessions = [{ ...before.sessions[0], id: "new:session" }];
  const result = publicationChanges(before, after);
  assert.equal(result.total, 3);
  assert(
    result.changes.some(
      (c) =>
        c.field === "Status" && c.before === "Active" && c.after === "Inactive",
    ),
  );
  assert(
    result.changes.some((c) => c.id === "weekly:one" && c.after === "Removed"),
  );
  assert(
    result.changes.some(
      (c) => c.id === "new:session" && c.before === "Not present",
    ),
  );
});

test("a new one-date replacement compares to inherited weekly hours and does not list copied peers", () => {
  const before = source();
  before.sessions.push({
    ...before.sessions[0],
    id: "other:weekly",
    professionalId: "doctor:other",
    startTime: "12:00",
    endTime: "13:00",
  });
  const after = structuredClone(before);
  after.exceptions = [
    {
      id: "new:date",
      scopeId: "clinic:one",
      date: "2026-11-05",
      closed: false,
      sessions: structuredClone(after.sessions),
    },
  ];
  assert.equal(
    publicationChanges(before, after).total,
    0,
    "an exact one-date copy does not change the public hours",
  );
  after.exceptions[0].sessions[0].endTime = "10:00";
  const result = publicationChanges(before, after);
  assert.equal(result.total, 1);
  assert.equal(result.changes[0].id, "new:date/weekly:one");
  assert.equal(result.changes[0].before, "09:00–11:00");
  assert.equal(result.changes[0].after, "09:00–10:00");
  after.exceptions[0].sessions[0].capacity = null;
  assert.deepEqual(
    publicationChanges(before, after),
    result,
    "dated private limits do not add website changes",
  );
});

test("renaming a professional does not falsely change every referencing session", () => {
  const before = source(),
    after = structuredClone(before);
  after.professionals[0].name = "Updated synthetic name";
  const result = publicationChanges(before, after);
  assert.equal(result.total, 1);
  assert.equal(result.changes[0].field, "Name");
  assert.equal(result.changes[0].before, "Synthetic doctor");
  assert.equal(result.changes[0].after, "Updated synthetic name");
});

test("bounded review reports omitted changes honestly and cannot expose extra properties", () => {
  const after = source();
  after.professionals[0].password = "DUMMY-PRIVATE";
  const result = publicationChanges(null, after, { limit: 2 });
  assert.equal(result.changes.length, 2);
  assert(result.total > result.changes.length);
  assert.equal(result.truncated, result.total - result.changes.length);
  assert.doesNotMatch(
    JSON.stringify(result),
    /DUMMY-PRIVATE|password|capacity/,
  );
  for (const limit of [0, -1, 401, Infinity, "2"])
    assert.throws(() => publicationChanges(null, after, { limit }));
});
