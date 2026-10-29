// Scheduling-only mocks. These do not establish MongoDB transaction correctness.
import test from "node:test";
import assert from "node:assert/strict";
import { createWebsiteRequestService } from "../src/website-requests.js";
import { createRequestTransport } from "../src/request-integration.js";

function fixture({ rotations = [], events = [], transport, clock }) {
  const mutations = [];
  const db = {
    collection(name) {
      return {
        find(query) {
          const records =
            name === "website_request_events"
              ? events.filter((e) => e.state === "pending")
              : query.rotation
                ? rotations
                : [];
          const cursor = {
            sort: () => cursor,
            limit: () => cursor,
            toArray: async () => records,
          };
          return cursor;
        },
        findOne: async () => ({ value: 0 }),
        countDocuments: async () =>
          events.filter((e) => e.state === "pending").length,
        updateOne: async (query, update) => {
          mutations.push({ name, query, update });
          if (name === "website_request_events") {
            const e = events.find((e) => e._id === query._id);
            if (e) Object.assign(e, update.$set);
          }
        },
      };
    },
  };
  const service = createWebsiteRequestService({
    db,
    transaction: (fn) => fn({}),
    guard: async () => {},
    authenticated: async () => {
      throw Error("Not an authentication fixture");
    },
    now: () => new Date("2026-10-29T09:00:00Z"),
    pumpClock: clock,
    config: { mode: "hosted-review", key: Buffer.alloc(32, 7), transport },
  });
  return { service, mutations };
}

test("a stalled rotation spends the shared hosted pump budget once and leaves pending work intact", async () => {
  let elapsed = 0;
  const rotations = Array.from({ length: 10 }, (_, i) => ({
    _id: `request:${i}`,
    rotation: { generation: 1, key: "dummy" },
  }));
  const before = structuredClone(rotations),
    calls = [];
  const { service, mutations } = fixture({
    rotations,
    clock: () => elapsed,
    transport: {
      rotate: async (_input, options) => {
        calls.push(options.remainingMs);
        elapsed += options.remainingMs;
        throw Error("Synthetic timeout");
      },
      pull: async () => {
        throw Error("Must not admit another request");
      },
    },
  });
  assert.deepEqual(await service.pump(), {
    pending: 0,
    partial: true,
    budgetExhausted: true,
  });
  assert.deepEqual(calls, [75000]);
  assert.deepEqual(rotations, before);
  assert.deepEqual(mutations, []);
  // A later explicit refresh receives a new execution budget, not new authority.
  assert.equal((await service.pump()).partial, true);
  assert.deepEqual(calls, [75000, 75000]);
  assert.deepEqual(rotations, before);
});

test("a successful slow wake leaves its remaining budget available to deliver persisted status", async () => {
  let elapsed = 0;
  const events = [
    {
      _id: "event",
      requestId: "request",
      sequence: 1,
      state: "pending",
      payload: { digest: "dummy-digest" },
    },
  ];
  const calls = [];
  const { service } = fixture({
    events,
    clock: () => elapsed,
    transport: {
      pull: async (_cursor, options) => {
        calls.push(["pull", options.remainingMs]);
        elapsed += 60000;
        return { schemaVersion: 1, cursor: 0, requests: [] };
      },
      event: async (_payload, options) => {
        calls.push(["event", options.remainingMs]);
        return { accepted: true, sequence: 1, digest: "dummy-digest" };
      },
    },
  });
  assert.deepEqual(await service.pump(), { pending: 0 });
  assert.deepEqual(calls, [
    ["pull", 75000],
    ["event", 15000],
  ]);
  assert.equal(events[0].state, "accepted");
});

test("hosted transport refuses exhausted or invalid operation budgets without outbound calls", async () => {
  let requests = 0;
  const transport = createRequestTransport(
    {
      mode: "hosted-review",
      apiOrigin: "https://cedar-review-example.onrender.com",
      publicBase: "https://cedar-review-example.vercel.app",
      publicDatabase: "capstone_public_review",
      publicSrvHost: "review.example.mongodb.net",
      streamId: "stream:11111111-1111-4111-8111-111111111111",
      target:
        "https://cedar-review-example.onrender.com/api/requests/integration",
      credential: "a".repeat(43),
    },
    async () => {
      requests++;
      return new Response("{}");
    },
  );
  for (const remainingMs of [0, -1, 0.5, 75001, NaN]) {
    await assert.rejects(transport.pull(0, { remainingMs }), /budget/);
  }
  assert.equal(requests, 0);
  await transport.pull(0, { remainingMs: 1000 });
  assert.equal(requests, 1);
});
