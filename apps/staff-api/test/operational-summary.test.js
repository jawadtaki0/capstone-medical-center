import test from "node:test";
import assert from "node:assert/strict";
import {
  createOperationalSummaryService,
  ensureOperationalSummaryIndexes,
  SUMMARY_VIEWS,
} from "../src/operational-summary.js";

const at = new Date("2026-10-29T09:00:00Z");
const get = (value, path) =>
  path
    .split(".")
    .reduce(
      (v, key) => (Array.isArray(v) ? v.map((x) => x?.[key]).flat() : v?.[key]),
      value,
    );
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function condition(value, query) {
  if (
    !query ||
    typeof query !== "object" ||
    query instanceof Date ||
    Array.isArray(query)
  )
    return Array.isArray(value)
      ? value.some((v) => same(v, query))
      : same(value, query);
  return Object.entries(query).every(([operator, operand]) => {
    if (operator === "$in")
      return (Array.isArray(value) ? value : [value]).some((v) =>
        operand.some((x) => same(x, v)),
      );
    if (operator === "$nin")
      return !(Array.isArray(value) ? value : [value]).some((v) =>
        operand.some((x) => same(x, v)),
      );
    if (operator === "$ne") return !same(value, operand);
    if (operator === "$exists") return (value !== undefined) === operand;
    if (operator === "$gt") return value > operand;
    if (operator === "$not") return !condition(value, operand);
    if (operator === "$elemMatch")
      return Array.isArray(value) && value.some((v) => condition(v, operand));
    throw Error("Unsupported mock condition " + operator);
  });
}
function expression(value, row) {
  if (typeof value === "string" && value.startsWith("$"))
    return get(row, value.slice(1));
  if (!value || typeof value !== "object" || value instanceof Date)
    return value;
  if (Array.isArray(value)) return value.map((v) => expression(v, row));
  if (value.$and) return value.$and.every((v) => expression(v, row));
  if (value.$eq) return same(...value.$eq.map((v) => expression(v, row)));
  if (value.$ifNull)
    return (
      expression(value.$ifNull[0], row) ?? expression(value.$ifNull[1], row)
    );
  if (value.$slice) {
    const [array, n] = value.$slice.map((v) => expression(v, row));
    return n < 0 ? array.slice(n) : array.slice(0, n);
  }
  throw Error("Unsupported mock expression");
}
const matches = (row, query) =>
  Object.entries(query).every(([key, value]) =>
    key === "$expr" ? expression(value, row) : condition(get(row, key), value),
  );
const projection = (row, spec) =>
  spec
    ? Object.fromEntries(
        Object.entries(spec)
          .filter(([, v]) => v !== 0)
          .map(([k, v]) => [k, v === 1 ? row[k] : expression(v, row)]),
      )
    : row;
const sortRows = (rows, spec) =>
  [...rows].sort((a, b) => {
    for (const [k, d] of Object.entries(spec)) {
      const x = get(a, k),
        y = get(b, k);
      if (x < y) return -d;
      if (x > y) return d;
    }
    return 0;
  });
function fixture(roles = ["Receptionist"], grants = ["clinic:one"]) {
  const data = {
    operational_scopes: [
      { id: "clinic:one", kind: "clinic", active: true },
      { id: "clinic:two", kind: "clinic", active: true },
      { id: "service:audio", kind: "service", active: true },
    ],
    operational_grants: [{ _id: "staff:one", scopeIds: grants }],
    website_request_inbox: [
      {
        _id: "a",
        scopeId: "clinic:one",
        status: "awaiting",
        createdAt: at,
        expiresAt: new Date(+at + 86400000),
        sequence: 1,
        generation: 1,
        patient: { motherFirstName: "PRIVATE-MOTHER", phone: "PRIVATE-PHONE" },
      },
      {
        _id: "b",
        scopeId: "clinic:two",
        status: "awaiting",
        createdAt: at,
        expiresAt: new Date(+at + 86400000),
        sequence: 1,
        generation: 1,
      },
      {
        _id: "expired",
        scopeId: "clinic:one",
        status: "confirmed",
        createdAt: new Date(+at - 1000),
        expiresAt: new Date(+at - 1),
        sequence: 1,
        generation: 1,
      },
    ],
    website_request_notices: [
      {
        _id: "notice-a",
        scopeId: "clinic:one",
        requestId: "a",
        state: "pending",
        version: 1,
        generation: 1,
        createdAt: at,
        history: [],
      },
      {
        _id: "notice-b",
        scopeId: "clinic:two",
        requestId: "b",
        state: "pending",
        version: 1,
        generation: 1,
        createdAt: at,
        history: [],
      },
      {
        _id: "notice-expired",
        scopeId: "clinic:one",
        requestId: "expired",
        state: "pending",
        version: 1,
        generation: 1,
        createdAt: at,
        history: [],
      },
      {
        _id: "notice-stale",
        scopeId: "clinic:one",
        requestId: "a",
        state: "pending",
        version: 0,
        generation: 1,
        createdAt: at,
        history: [],
      },
    ],
    bookings: [
      { scopeId: "clinic:one", date: "2026-10-29", status: "confirmed" },
      { scopeId: "clinic:two", date: "2026-10-29", status: "confirmed" },
    ],
    public_publication_outbox: [
      {
        _id: "pub-a",
        scopeIds: ["clinic:one"],
        state: "accepted",
        acceptedAt: new Date(+at - 1000),
        effectiveFrom: "2027-01-01",
      },
      {
        _id: "pub-shared-failed",
        scopeIds: ["clinic:one", "clinic:two"],
        state: "failed",
        lastError: "safe_error",
      },
    ],
  };
  const calls = [],
    writes = [];
  let actor = "staff:one",
    failure = false;
  function aggregate(name, pipeline) {
    let rows = [...(data[name] ?? [])];
    for (const stage of pipeline) {
      if (stage.$match) rows = rows.filter((r) => matches(r, stage.$match));
      else if (stage.$sort) rows = sortRows(rows, stage.$sort);
      else if (stage.$limit) rows = rows.slice(0, stage.$limit);
      else if (stage.$project)
        rows = rows.map((r) => projection(r, stage.$project));
      else if (stage.$lookup) {
        const l = stage.$lookup;
        rows = rows.map((r) => ({
          ...r,
          [l.as]: (data[l.from] ?? [])
            .filter((f) => same(f[l.foreignField], r[l.localField]))
            .map((f) => projection(f, l.pipeline?.[0]?.$project)),
        }));
      } else if (stage.$unwind) {
        const key = stage.$unwind.slice(1);
        rows = rows.flatMap((r) => r[key].map((v) => ({ ...r, [key]: v })));
      } else if (stage.$count)
        rows = rows.length ? [{ [stage.$count]: rows.length }] : [];
      else throw Error("Unsupported mock stage");
    }
    return rows;
  }
  const db = {
    collection(name) {
      calls.push(name);
      return {
        collectionName: name,
        find(query, options) {
          calls.push({ name, kind: "find", query, options });
          let rows = (data[name] ?? []).filter((r) => matches(r, query));
          return {
            sort(spec) {
              rows = sortRows(rows, spec);
              return this;
            },
            limit(n) {
              rows = rows.slice(0, n);
              return this;
            },
            maxTimeMS(n) {
              assert(n <= 2000);
              return this;
            },
            async toArray() {
              return rows.map((r) => projection(r, options?.projection));
            },
          };
        },
        async findOne(query, options) {
          calls.push({ name, kind: "findOne", query, options });
          const r = (data[name] ?? []).find((r) => matches(r, query));
          return r ? projection(r, options?.projection) : null;
        },
        async countDocuments(query, options) {
          calls.push({ name, kind: "count", query, options });
          assert(options.maxTimeMS <= 2000);
          return (data[name] ?? []).filter((r) => matches(r, query)).length;
        },
        aggregate(pipeline, options) {
          calls.push({ name, kind: "aggregate", pipeline, options });
          assert(options.maxTimeMS <= 2000);
          return { toArray: async () => aggregate(name, pipeline) };
        },
        async updateOne(query, update, options) {
          writes.push({ name, query, update, options });
          const i = (data[name] ??= []).findIndex((r) => matches(r, query));
          if (i < 0) data[name].push({ ...query, ...update.$set });
          else Object.assign(data[name][i], update.$set);
          return { modifiedCount: 1 };
        },
        async createIndex(keys) {
          calls.push({ name, kind: "index", keys });
        },
      };
    },
  };
  const service = createOperationalSummaryService({
    db,
    transaction: async (action) => action({}),
    authenticated: async () =>
      failure
        ? { failure: { code: "expired" } }
        : { account: { _id: actor, roles } },
    now: () => at,
  });
  return {
    service,
    data,
    calls,
    writes,
    db,
    setActor: (v) => {
      actor = v;
    },
    setFailure: () => {
      failure = true;
    },
  };
}

test("request badge counts unresolved authority-filtered work, not page views or all patients", async () => {
  const f = fixture();
  const result = await f.service.read("dummy");
  assert.equal(result.counts.requestsAwaitingDecision, 1);
  assert.equal(result.counts.messagesToSend, 1);
  assert.equal(result.counts.todayBookings, 1);
  assert.equal(result.counts.unpublishedChanges, undefined);
  assert(
    !f.calls.some(
      (c) => c === "patients" || c === "accounts" || c === "staff_sessions",
    ),
  );
  assert.equal(f.writes.length, 0);
  const text = JSON.stringify(result);
  assert(!text.includes("PRIVATE"));
  assert(
    !/"(?:patient|motherFirstName|phone|dateOfBirth|privateNotes)"\s*:/.test(
      text,
    ),
  );
  assert(result.activity.length <= 3);
  assert(result.activity.some((e) => e.needsAction));
  await f.service.viewed("dummy", { eventId: result.activity[0].id });
  const after = await f.service.read("dummy");
  assert.equal(after.counts.requestsAwaitingDecision, 1);
  assert.equal(after.counts.messagesToSend, 1);
  assert(after.activity[0].viewed);
  f.data.website_request_inbox[0].status = "rejected";
  assert.equal(
    (await f.service.read("dummy")).counts.requestsAwaitingDecision,
    0,
  );
});
test("scope/role revocation and invalid roles do not leak stale counts", async () => {
  const f = fixture();
  assert.equal(
    (await f.service.read("dummy")).counts.requestsAwaitingDecision,
    1,
  );
  f.data.operational_grants[0].scopeIds = [];
  assert.equal(
    (await f.service.read("dummy")).counts.requestsAwaitingDecision,
    undefined,
  );
  const expired = fixture();
  expired.setFailure();
  assert.deepEqual(await expired.service.read("dummy"), {
    failure: { code: "expired" },
  });
  assert.equal(expired.calls.length, 0);
  await assert.rejects(
    fixture(["System Admin"]).service.read("dummy"),
    (e) => e.code === "permission_denied",
  );
});
test("Clinic Admin may view scoped bookings but gains no request/message or booking-write authority", async () => {
  const result = await fixture(["Clinic Admin"]).service.read("dummy");
  assert.equal(result.counts.todayBookings, 1);
  assert.equal(result.counts.requestsAwaitingDecision, undefined);
  assert.equal(result.capabilities.book, false);
  assert(result.capabilities.professionals);
});
test("Lab Admin service assignment does not confer clinic counts; mixed roles combine explicit grants", async () => {
  const lab = await fixture(["Lab Admin"], ["service:audio"]).service.read(
    "dummy",
  );
  assert(lab.capabilities.serviceHours);
  assert.equal(lab.counts.todayBookings, undefined);
  assert.equal(lab.counts.requestsAwaitingDecision, undefined);
  assert.equal(lab.capabilities.professionals, false);
  const mixed = await fixture(
    ["Lab Admin", "Receptionist"],
    ["service:audio", "clinic:one"],
  ).service.read("dummy");
  assert(mixed.capabilities.serviceHours && mixed.capabilities.requests);
  assert.equal(mixed.counts.requestsAwaitingDecision, 1);
});
test("only all-scope publication managers see actionable delivery failure counts", async () => {
  const clinic = await fixture(["Clinic Admin"]).service.read("dummy");
  assert.equal(clinic.counts.publicationDeliveryProblems, 0);
  const admin = await fixture(["Admin"], []).service.read("dummy");
  assert.equal(admin.counts.publicationDeliveryProblems, 1);
  assert.equal(admin.counts.requestsAwaitingDecision, 2);
  assert(admin.capabilities.centerSettings && admin.capabilities.directory);
});
test("viewed state is per staff, bounded to latest three IDs and never stores private event payloads", async () => {
  const f = fixture();
  const initial = await f.service.read("dummy");
  await f.service.viewed("dummy", { eventId: initial.activity[0].id });
  assert.equal(f.writes[0].name, SUMMARY_VIEWS);
  assert.equal(f.writes[0].query._id, "staff:one");
  assert(f.writes[0].update.$set.events.length <= 3);
  f.setActor("staff:two");
  f.data.operational_grants.push({
    _id: "staff:two",
    scopeIds: ["clinic:one"],
  });
  assert((await f.service.read("dummy")).activity.every((e) => !e.viewed));
  await assert.rejects(
    f.service.viewed("dummy", { eventId: "request:unauthorized" }),
    (e) => e.code === "summary_stale",
  );
  assert.equal(f.writes.length, 1);
});
test("private limit/revision-only edits are not counted as unpublished public changes, including future publication", async () => {
  const f = fixture(["Clinic Admin"]);
  const session = {
    id: "weekly",
    scopeId: "clinic:one",
    professionalId: "doctor:one",
    weekday: 1,
    startTime: "09:00",
    endTime: "10:00",
    status: "active",
    appointmentRequired: false,
    capacity: 3,
    revision: 2,
  };
  f.data.operational_session_drafts = [session];
  f.data.operational_publications = [
    {
      sequence: 1,
      effectiveFrom: "2027-01-01",
      scopeIds: ["clinic:one"],
      scopes: [],
      professionals: [],
      sessions: [{ ...session, capacity: 1, revision: 1 }],
      exceptions: [],
      hours: [],
    },
  ];
  assert.equal((await f.service.read("dummy")).counts.unpublishedChanges, 0);
  f.data.operational_date_drafts = [
    {
      id: "private-date-limit",
      scopeId: "clinic:one",
      date: "2027-01-04",
      closed: false,
      sessions: [{ ...session, capacity: 1 }],
    },
  ];
  assert.equal(
    (await f.service.read("dummy")).counts.unpublishedChanges,
    0,
    "an inherited public window with a private dated limit is not a website edit",
  );
  f.data.operational_date_drafts[0].sessions[0].endTime = "12:00";
  assert.equal((await f.service.read("dummy")).counts.unpublishedChanges, 1);
  f.data.operational_date_drafts = [];
  session.endTime = "11:00";
  assert.equal((await f.service.read("dummy")).counts.unpublishedChanges, 1);
});
test("summary overflow is a controlled unavailable response, not false empty/partial counts", async () => {
  const f = fixture(["Admin"]);
  f.data.operational_scopes = Array.from({ length: 101 }, (_, i) => ({
    id: "clinic:" + i,
    kind: "clinic",
    active: true,
  }));
  await assert.rejects(
    f.service.read("dummy"),
    (e) => e.code === "summary_unavailable",
  );
});
test("index initializer is explicit and all read projections are bounded", async () => {
  const f = fixture();
  await f.service.read("dummy");
  assert(!f.calls.some((c) => c.kind === "index"));
  await ensureOperationalSummaryIndexes(f.db);
  assert(
    f.calls.some(
      (c) => c.kind === "index" && c.name === "website_request_inbox",
    ),
  );
});

test("unexpected database errors become secret-free controlled summary unavailability", async () => {
  const service = createOperationalSummaryService({
    db: {
      collection() {
        throw Error("DUMMY PRIVATE QUERY TEXT");
      },
    },
    transaction: async (action) => action({}),
    authenticated: async () => ({
      account: { _id: "staff:one", roles: ["Admin"] },
    }),
    now: () => at,
  });
  await assert.rejects(
    service.read("dummy"),
    (error) =>
      error.code === "summary_unavailable" &&
      !error.message.includes("DUMMY") &&
      error.status === 503,
  );
});
