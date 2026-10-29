import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import {
  createPublicationReceiver,
  upcomingRequestSessions,
  requestSessionsFromSnapshot,
} from "../src/publication-receiver.js";
import { websiteRequestRouter } from "../src/website-request-routes.js";
import { createPublicIntake } from "../src/website-requests.js";

const now = new Date("2026-11-02T06:00:00Z");
const session = (values = {}) => ({
  id: "weekly",
  scopeId: "clinic:main",
  professionalId: "professional:one",
  weekday: 1,
  startTime: "09:00",
  endTime: "10:00",
  status: "active",
  appointmentRequired: true,
  capacity: 999,
  ...values,
});
const event = (values = {}) => ({
  id: "published:one",
  sequence: 1,
  effectiveFrom: null,
  publishedAt: "2026-10-29T09:00:00Z",
  scopeIds: ["clinic:main", "service:lab"],
  publishesHours: true,
  scopes: [
    { id: "clinic:main", kind: "clinic", active: true },
    { id: "service:lab", kind: "service", active: true },
  ],
  professionals: [
    {
      id: "professional:one",
      name: "Dr. Synthetic",
      specialty: "Synthetic",
      kind: "doctor",
      avatarVariant: "male",
      active: true,
      scopeIds: ["clinic:main"],
      gender: "PRIVATE",
    },
  ],
  sessions: [session()],
  exceptions: [],
  hours: Array.from({ length: 7 }, (_, day) => ({
    id: String(day),
    closed: false,
    startTime: "00:00",
    endTime: "23:59",
  })),
  ...values,
});
const record = (events = [event()]) => ({
  digest: "synthetic-digest",
  payload: { sequence: events.length, events },
});
const input = (values = {}) => ({
  professionalId: "professional:one",
  fromDate: "2026-11-02",
  ...values,
});

test("upcoming discovery applies exact Beirut end time and emits only existing public session fields", () => {
  const result = upcomingRequestSessions(
    record(),
    input(),
    new Date("2026-11-02T08:00:00Z"),
  );
  assert.equal(result.sessions[0].date, "2026-11-09");
  assert.equal(result.sessions.length, 3);
  assert.equal(result.throughDate, "2026-11-29");
  assert.equal(result.nextDate, "2026-11-30");
  assert.equal(result.nextAfter, null);
  assert.equal(result.sequence, 1);
  assert.equal(result.digest, "synthetic-digest");
  for (const s of result.sessions) {
    assert.equal(s.capacity, undefined);
    assert.equal(s.gender, undefined);
    assert.equal(s.appointmentRequired, true);
    assert.equal(s.scopeId, "clinic:main");
  }
  assert.equal(
    upcomingRequestSessions(
      record(),
      input(),
      new Date("2026-11-02T07:59:59.999Z"),
    ).sessions[0].date,
    "2026-11-02",
  );
});

test("dated lookups and discovery agree: a Wednesday professional has no Thursday session", () => {
  const e = event({ sessions: [session({ weekday: 3 })] });
  assert.equal(requestSessionsFromSnapshot(e, "2026-10-29").length, 0);
  assert.equal(requestSessionsFromSnapshot(e, "2026-11-04").length, 1);
  const result = upcomingRequestSessions(
    record([e]),
    input({ fromDate: "2026-10-29" }),
    new Date("2026-10-29T06:00Z"),
  );
  assert.equal(result.sessions[0].date, "2026-11-04");
});

test("discovery uses Beirut calendar midnight and the last valid DST-fold end instant", () => {
  const midnight = record([
    event({ sessions: [session({ startTime: "00:00", endTime: "00:10" })] }),
  ]);
  assert.equal(
    upcomingRequestSessions(midnight, input(), new Date("2026-11-01T22:05:00Z"))
      .sessions[0].date,
    "2026-11-02",
  );
  assert.equal(
    upcomingRequestSessions(midnight, input(), new Date("2026-11-01T22:10:00Z"))
      .sessions[0].date,
    "2026-11-09",
  );
  const folded = record([
    event({
      sessions: [session({ weekday: 6, startTime: "22:00", endTime: "23:30" })],
    }),
  ]);
  assert.equal(
    upcomingRequestSessions(
      folded,
      input({ fromDate: "2026-10-24" }),
      new Date("2026-10-24T20:45:00Z"),
    ).sessions[0].date,
    "2026-10-24",
  );
  assert.equal(
    upcomingRequestSessions(
      folded,
      input({ fromDate: "2026-10-24" }),
      new Date("2026-10-24T21:30:00Z"),
    ).sessions[0].date,
    "2026-10-31",
  );
});

test("discovery composes scoped future publications, dated replacement/closures and center hours", () => {
  const baseline = event({
    sessions: [session(), session({ id: "lab", scopeId: "service:lab" })],
    exceptions: [
      {
        id: "closed",
        scopeId: "clinic:main",
        date: "2026-11-02",
        closed: true,
        sessions: [],
      },
      {
        id: "replacement",
        scopeId: "clinic:main",
        date: "2026-11-09",
        closed: false,
        sessions: [
          session({ id: "dated", startTime: "12:00", endTime: "13:00" }),
        ],
      },
    ],
  });
  const future = event({
    id: "published:two",
    sequence: 2,
    effectiveFrom: "2026-11-16",
    scopeIds: ["clinic:main"],
    professionals: [{ ...baseline.professionals[0], active: false }],
    publishesHours: false,
  });
  const result = upcomingRequestSessions(
    record([baseline, future]),
    input(),
    now,
  );
  assert.deepEqual(
    result.sessions.map((s) => [s.date, s.sourceSessionId, s.startTime]),
    [["2026-11-09", "dated", "12:00"]],
  );
  const hours = event({
    hours: [...baseline.hours, { id: "2026-11-02", closed: true }],
  });
  assert.equal(
    upcomingRequestSessions(record([hours]), input(), now).sessions[0].date,
    "2026-11-09",
  );
});

test("empty page has continuation and far-future browsing is not restricted by an advance horizon", () => {
  const baseline = event({
    professionals: [{ ...event().professionals[0], active: false }],
  });
  const later = event({
    id: "future",
    sequence: 2,
    effectiveFrom: "2035-01-01",
  });
  const r = record([baseline, later]);
  const first = upcomingRequestSessions(r, input(), now);
  assert.equal(first.sessions.length, 0);
  assert.equal(first.nextDate, "2026-11-30");
  const distant = upcomingRequestSessions(
    r,
    input({ fromDate: "2035-01-01" }),
    now,
  );
  assert(distant.sessions.length > 0);
  assert.equal(distant.sessions[0].date, "2035-01-01");
  const last = upcomingRequestSessions(
    record(),
    input({ fromDate: "9999-12-31" }),
    now,
  );
  assert.equal(last.nextDate, null);
});

test("100-row cap uses same-date continuation without dropping or repeating session rows", () => {
  const time = (minute) =>
    `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const r = record([
    event({
      sessions: Array.from({ length: 120 }, (_, i) =>
        session({
          id: `session:${i}`,
          startTime: time(600 + i),
          endTime: time(601 + i),
        }),
      ),
    }),
  ]);
  const first = upcomingRequestSessions(r, input(), now);
  assert.equal(first.sessions.length, 100);
  assert.equal(first.nextDate, "2026-11-02");
  assert(first.nextAfter);
  const second = upcomingRequestSessions(
    r,
    input({ fromDate: first.nextDate, after: first.nextAfter }),
    now,
  );
  const sameDate = [
    ...first.sessions,
    ...second.sessions.filter((s) => s.date === "2026-11-02"),
  ];
  assert.equal(sameDate.length, 120);
  assert.equal(new Set(sameDate.map((s) => s.sourceSessionId)).size, 120);
  assert(second.sessions.some((s) => s.date === "2026-11-09"));
});

test("discovery rejects malformed dates, cursors, forged fields and past dates", () => {
  for (const bad of [
    input({ fromDate: "2026-02-30" }),
    input({ fromDate: "2026-11-01" }),
    input({ fromDate: [] }),
    input({ after: "***" }),
    input({
      after: Buffer.from(
        JSON.stringify(["2026-11-03", "09:00", "clinic:main", "weekly"]),
      ).toString("base64url"),
    }),
    input({ capacity: 5 }),
    { fromDate: "2026-11-02" },
  ])
    assert.throws(
      () => upcomingRequestSessions(record(), bad, now),
      (e) => e.code === "request_input",
    );
});

test("upcoming receiver reads one accepted payload for the whole page even if a newer acceptance occurs", async () => {
  let stateReads = 0,
    versionReads = 0,
    writes = 0;
  const r = record();
  const db = {
    databaseName: "capstone_staff_test",
    collection(name) {
      return {
        updateOne: async () => {
          writes++;
          return { modifiedCount: 1 };
        },
        findOne: async (query) => {
          if (name === "public_publication_state") {
            stateReads++;
            return { sequence: stateReads === 1 ? 1 : 2 };
          }
          if (name === "public_accepted_publications") {
            versionReads++;
            assert.equal(query._id, "stream:test:1");
            return structuredClone(r);
          }
          return null;
        },
      };
    },
  };
  const client = {
    options: {
      hosts: [{ host: "127.0.0.1", port: 27018 }],
      replicaSet: "capstoneStaffDev",
    },
  };
  const receiver = await createPublicationReceiver({
    db,
    client,
    token: "a".repeat(43),
    streamId: "stream:test",
    demoMode: true,
    clock: () => now,
  });
  writes = 0;
  const page = await receiver.requestUpcoming(input());
  assert.equal(page.sequence, 1);
  assert.equal(stateReads, 1);
  assert.equal(versionReads, 1);
  assert.equal(writes, 0);
  assert.equal(page.sessions.length, 4);
});

test("intake upcoming reader is explicit and does not touch request counters or patient storage", async () => {
  let reads = 0;
  const service = createPublicIntake({
    db: {
      collection() {
        return {};
      },
    },
    client: {},
    key: Buffer.alloc(32, 7),
    upcomingReader: async (v) => {
      reads++;
      return { sessions: [], echo: v };
    },
  });
  assert.deepEqual(await service.upcoming(input()), {
    sessions: [],
    echo: input(),
  });
  assert.equal(reads, 1);
  const missing = createPublicIntake({
    db: {
      collection() {
        return {};
      },
    },
    client: {},
    key: Buffer.alloc(32, 7),
  });
  await assert.rejects(missing.upcoming(input()), (e) => e.status === 503);
});

test("dated catalogue also excludes already-ended sessions at exact Beirut end", async () => {
  const service = createPublicIntake({
    db: {
      collection() {
        return {};
      },
    },
    client: {},
    key: Buffer.alloc(32, 7),
    clock: () => new Date("2026-11-02T08:00:00Z"),
    sessionReader: async (date) => [
      { date, endTime: "10:00", sourceSessionId: "ended" },
      { date, endTime: "11:00", sourceSessionId: "future" },
    ],
  });
  assert.deepEqual(
    (await service.sessions("2026-11-02")).map((s) => s.sourceSessionId),
    ["future"],
  );
  assert.deepEqual(await service.sessions("2026-11-01"), []);
});

test("upcoming HTTP route validates exact query and preserves private response headers", async () => {
  const app = express();
  let calls = 0;
  app.use(
    websiteRequestRouter({
      service: {
        upcoming: async (v) => {
          calls++;
          assert.equal(v.professionalId, "professional:one");
          return { sessions: [], nextDate: "2026-11-30" };
        },
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const good = await fetch(
      base + "/upcoming?professionalId=professional:one&fromDate=2026-11-02",
    );
    assert.equal(good.status, 200);
    assert.match(good.headers.get("cache-control"), /no-store/);
    assert.equal(good.headers.get("referrer-policy"), "no-referrer");
    for (const q of [
      "professionalId=professional:one",
      "professionalId=professional:one&fromDate=2026-11-02&capacity=5",
    ]) {
      const bad = await fetch(base + "/upcoming?" + q);
      assert.equal(bad.status, 400);
    }
    assert.equal(calls, 1);
  } finally {
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
