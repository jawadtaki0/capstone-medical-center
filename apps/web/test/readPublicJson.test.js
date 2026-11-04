import test from "node:test";
import assert from "node:assert/strict";
import {
  readPublicJson,
  PUBLIC_READ_TIMEOUT_MS,
} from "../src/lib/readPublicJson.js";

test("public reads share the cold-start-aware 75-second budget and retain successful/empty data", async () => {
  assert.equal(PUBLIC_READ_TIMEOUT_MS, 75000);
  for (const data of [[], { publicationStatus: "unpublished" }]) {
    assert.deepEqual(
      await readPublicJson("/api/schedule", {
        request: async () => ({ ok: true, json: async () => data }),
      }),
      data,
    );
  }
});

test("stalled headers and stalled bodies both reach the deadline and abort without retrying", async () => {
  for (const stalledBody of [false, true]) {
    let calls = 0,
      transportSignal;
    const never = new Promise(() => {});
    await assert.rejects(
      readPublicJson("/api/professionals", {
        timeoutMs: 15,
        request: async (_, { signal }) => {
          calls++;
          transportSignal = signal;
          return stalledBody ? { ok: true, json: () => never } : never;
        },
      }),
      { name: "TimeoutError" },
    );
    assert.equal(calls, 1);
    assert.equal(transportSignal.aborted, true);
  }
});

test("caller cancellation discards stalled data and pre-cancelled reads never send", async () => {
  const c = new AbortController();
  let calls = 0,
    transportSignal;
  const request = async (_, { signal }) => {
    calls++;
    transportSignal = signal;
    return new Promise(() => {});
  };
  const pending = readPublicJson("/api/schedule", {
    signal: c.signal,
    request,
  });
  c.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(transportSignal.aborted, true);
  await assert.rejects(
    readPublicJson("/api/schedule", { signal: c.signal, request }),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("failed/invalid responses stay errors and explicit retry can recover", async () => {
  await assert.rejects(
    readPublicJson("/api/schedule", { request: async () => ({ ok: false }) }),
    /request failed/,
  );
  await assert.rejects(
    readPublicJson("/api/schedule", {
      request: async () => ({
        ok: true,
        json: async () => {
          throw SyntaxError("Invalid JSON");
        },
      }),
    }),
    SyntaxError,
  );
  assert.deepEqual(
    await readPublicJson("/api/schedule", {
      request: async () => ({
        ok: true,
        json: async () => ({ date: "2026-11-05" }),
      }),
    }),
    { date: "2026-11-05" },
  );
});

test("a completed read clears its deadline and detaches caller cancellation", async () => {
  const c = new AbortController();
  let transportSignal;
  await readPublicJson("/api/professionals", {
    signal: c.signal,
    timeoutMs: 15,
    request: async (_, { signal }) => {
      transportSignal = signal;
      return { ok: true, json: async () => [] };
    },
  });
  c.abort();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(transportSignal.aborted, false);
});
