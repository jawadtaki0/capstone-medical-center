import test from "node:test";
import assert from "node:assert/strict";
import { startHostedReviewRequestWorker } from "../src/request-integration.js";
import { createWebsiteRequestService } from "../src/website-requests.js";
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("expired authorization never starts intake or outbound synchronization on Refresh", async () => {
  let queries = 0;
  const failure = {
    failure: {
      code: "session_expired",
      message: "Sign in again.",
      status: 401,
    },
  };
  const service = createWebsiteRequestService({
    db: {
      collection: () => ({
        find() {
          queries++;
          throw Error("Synchronization must not start");
        },
      }),
    },
    transaction: async (action) => action({}),
    guard: async () => {},
    authenticated: async () => failure,
    now: () => new Date("2026-10-30T12:00:00Z"),
    config: { key: Buffer.alloc(32, 3) },
  });
  assert.deepEqual(await service.refresh("synthetic-expired", {}), failure);
  assert.equal(queries, 0);
});
test("committed work wakes delivery immediately and stop unsubscribes without waiting for the interval", async (t) => {
  let listener,
    pending = false,
    calls = 0,
    unsubscribed = false;
  const timers = [];
  t.mock.method(globalThis, "setTimeout", (callback) => {
    timers.push(callback);
    return { unref() {} };
  });
  const worker = startHostedReviewRequestWorker({
    subscribePendingWork(fn) {
      listener = fn;
      return () => {
        unsubscribed = true;
      };
    },
    hasPendingWork: async () => pending,
    pump: async () => {
      calls++;
      pending = false;
    },
  });
  await flush();
  assert.equal(calls, 0);
  pending = true;
  listener();
  await flush();
  assert.equal(calls, 1);
  await worker.stop();
  assert.equal(unsubscribed, true);
  pending = true;
  listener();
  await flush();
  assert.equal(calls, 1);
});
test("service notifies only after successful authorized commit, never rollback or failed authorization", async () => {
  let committed = false,
    wakes = 0,
    rollback = false,
    expired = false;
  const at = new Date("2026-10-29T12:00:00Z");
  const row = {
    _id: "dummy",
    scopeId: "clinic:dummy",
    revision: 1,
    endsAt: new Date(+at + 3600000),
    expiresAt: new Date(+at + 86400000),
  };
  const service = createWebsiteRequestService({
    db: {
      collection(name) {
        return {
          find() {
            return {
              toArray: async () =>
                name === "operational_scopes"
                  ? [{ id: "clinic:dummy", kind: "clinic", active: true }]
                  : [],
            };
          },
          findOne: async () => ({ ...row }),
          replaceOne: async () => ({ modifiedCount: 1 }),
          insertOne: async () => ({}),
        };
      },
    },
    config: { key: Buffer.alloc(32, 4) },
    now: () => at,
    guard: async () => {},
    authenticated: async () =>
      expired
        ? { failure: "expired" }
        : { account: { _id: "synthetic", roles: ["Admin"] } },
    transaction: async (action) => {
      const result = await action({});
      if (rollback) throw Error("Synthetic rollback");
      committed = true;
      return result;
    },
  });
  const stop = service.subscribePendingWork(() => {
    assert.equal(committed, true);
    wakes++;
  });
  await service.notes("dummy", {
    id: "dummy",
    revision: 1,
    notes: "Synthetic note",
  });
  assert.equal(wakes, 1);
  committed = false;
  rollback = true;
  await assert.rejects(
    service.notes("dummy", {
      id: "dummy",
      revision: 1,
      notes: "Synthetic note",
    }),
    /Synthetic rollback/,
  );
  assert.equal(wakes, 1);
  rollback = false;
  expired = true;
  await service.notes("dummy", {
    id: "dummy",
    revision: 1,
    notes: "Synthetic note",
  });
  assert.equal(wakes, 1);
  stop();
});
test("committed pending work synchronizes on restart; failures retry without UI sessions or idle traffic", async (t) => {
  const callbacks = [],
    errors = [];
  let pending = true,
    calls = 0,
    failed = false;
  t.mock.method(globalThis, "setTimeout", (callback, interval) => {
    assert.equal(interval, 10000);
    callbacks.push(callback);
    return { unref() {} };
  });
  const service = {
    hasPendingWork: async () => pending,
    pump: async () => {
      calls++;
      if (!failed) {
        failed = true;
        throw Error("DUMMY provider detail must not be logged");
      }
      pending = false;
    },
  };
  const worker = startHostedReviewRequestWorker(service, {
    onError: (e) => errors.push(e),
  });
  await flush();
  assert.equal(calls, 1);
  assert.equal(pending, true);
  assert.equal(errors.length, 1);
  assert(!errors[0].includes("DUMMY"));
  await callbacks.shift()();
  assert.equal(calls, 2);
  assert.equal(pending, false);
  await callbacks.shift()();
  assert.equal(calls, 2);
  await worker.stop();
  pending = true;
  const restarted = startHostedReviewRequestWorker(service);
  await flush();
  assert.equal(calls, 3);
  assert.equal(pending, false);
  await restarted.stop();
});
test("worker never overlaps an in-flight synchronization or continues after stop", async (t) => {
  const callbacks = [];
  let resolve,
    calls = 0;
  t.mock.method(globalThis, "setTimeout", (callback) => {
    callbacks.push(callback);
    return { unref() {} };
  });
  const worker = startHostedReviewRequestWorker({
    hasPendingWork: async () => true,
    pump: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  await flush();
  const repeat = worker.runOnce();
  assert.equal(calls, 1);
  const stopping = worker.stop();
  resolve();
  await repeat;
  await stopping;
  assert.equal(callbacks.length, 0);
  await worker.runOnce();
  assert.equal(calls, 1);
});
test("local durable-work query covers events, rotations and ended requests without reading/touching sessions", async () => {
  for (const kind of ["idle", "event", "rotation", "ended"]) {
    const reads = [];
    let authCalls = 0;
    const service = createWebsiteRequestService({
      db: {
        collection(name) {
          return {
            findOne: async (filter, options) => {
              reads.push({ name, filter, options });
              return (kind === "event" && name === "website_request_events") ||
                (kind === "rotation" && filter.rotation) ||
                (kind === "ended" && filter.status === "awaiting")
                ? { _id: "dummy" }
                : null;
            },
          };
        },
      },
      config: { key: Buffer.alloc(32, 7) },
      now: () => new Date("2026-10-29T12:00:00Z"),
      authenticated: () => {
        authCalls++;
        throw Error("Must not authenticate/touch a session");
      },
      transaction: () => {
        throw Error("Must not open a staff transaction");
      },
      guard: () => {
        throw Error("Must not alter authority");
      },
    });
    assert.equal(await service.hasPendingWork(), kind !== "idle");
    assert.equal(authCalls, 0);
    assert(
      reads.every((r) =>
        ["website_request_events", "website_request_inbox"].includes(r.name),
      ),
    );
    assert(
      reads.every(
        (r) => r.options.maxTimeMS === 1000 && r.options.projection._id === 1,
      ),
    );
  }
});
