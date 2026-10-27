import test from "node:test";
import assert from "node:assert/strict";
import { assertLegacyReaderMode } from "../src/normal-publication.js";
import * as normal from "../src/normal-publication.js";
import { createApp } from "../src/app.js";

test("omitted publication startup configuration cannot silently restore legacy reads after activation", async () => {
  const db = (value) => ({
    collection(name) {
      assert.equal(name, "public_data_authority");
      return { findOne: async () => value };
    },
  });
  await assertLegacyReaderMode(db(null));
  await assertLegacyReaderMode(db({ mode: "legacy", writesFrozen: true }));
  await assert.rejects(
    assertLegacyReaderMode(db({ mode: "cedar", streamId: "stream:synthetic" })),
    /explicit publication configuration/,
  );
  await assert.rejects(
    assertLegacyReaderMode(db({ mode: "unknown" })),
    /explicit publication configuration/,
  );
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("publication initialization is shared; ready reads never initialize", async () => {
  const db = {},
    gate = deferred();
  let calls = 0;
  const lifecycle = normal.createPublicationLifecycle({
    getDatabase: () => db,
    initialize: async () => {
      calls++;
      return gate.promise;
    },
  });
  assert.throws(() => lifecycle.ready(), /not ready/);
  assert.equal(calls, 0);
  const first = lifecycle.refresh(),
    second = lifecycle.refresh();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.throws(() => lifecycle.ready(), /not ready/);
  const binding = { receiver: {}, authority: {} };
  gate.resolve(binding);
  assert.equal(await first, binding);
  assert.equal(lifecycle.ready(), binding);
  await lifecycle.refresh();
  assert.equal(calls, 1);
});

test("obsolete completions cannot overwrite a recovered connection or its current configuration", async () => {
  const oldDb = {},
    newDb = {},
    old = deferred(),
    current = deferred();
  let db = oldDb;
  const calls = [];
  const lifecycle = normal.createPublicationLifecycle({
    getDatabase: () => db,
    initialize: async (value) => {
      calls.push(value);
      return value === oldDb ? old.promise : current.promise;
    },
  });
  const oldWork = lifecycle.refresh();
  const rejected = assert.rejects(oldWork, /not ready/);
  await Promise.resolve();
  db = newDb;
  assert.throws(() => lifecycle.ready(), /not ready/);
  const newWork = lifecycle.refresh();
  const binding = {
    configGeneration: 2,
    authority: { mode: async () => "cedar" },
  };
  current.resolve(binding);
  assert.equal(await newWork, binding);
  old.resolve({ configGeneration: 1 });
  await rejected;
  assert.equal(lifecycle.ready(), binding);
  assert.equal(await lifecycle.ready().authority.mode(), "cedar");
  assert.deepEqual(calls, [oldDb, newDb]);
});

test("outage and invalidation reject prior bindings, including late initialization", async () => {
  const db = {},
    gate = deferred();
  let available = true,
    calls = 0;
  const lifecycle = normal.createPublicationLifecycle({
    getDatabase: () => {
      if (!available) throw Error("offline");
      return db;
    },
    initialize: async () => {
      calls++;
      return calls === 1 ? gate.promise : { current: true };
    },
  });
  const work = lifecycle.refresh(),
    rejected = assert.rejects(work, /not ready/);
  await Promise.resolve();
  available = false;
  assert.throws(() => lifecycle.ready(), /not ready/);
  gate.resolve({ obsolete: true });
  await rejected;
  available = true;
  await lifecycle.refresh();
  assert.deepEqual(lifecycle.ready(), { current: true });
  lifecycle.invalidate();
  assert.throws(() => lifecycle.ready(), /not ready/);
});

test("failed initialization retries current configuration and never falls back to old authority", async () => {
  const oldDb = {},
    newDb = {};
  let db = oldDb,
    fail = false,
    loads = 0;
  const lifecycle = normal.createPublicationLifecycle({
    getDatabase: () => db,
    initialize: async () => {
      loads++;
      if (fail) throw Error("configuration unavailable");
      return { loads };
    },
  });
  await lifecycle.refresh();
  db = newDb;
  assert.throws(() => lifecycle.ready(), /not ready/);
  fail = true;
  await assert.rejects(lifecycle.refresh(), /configuration unavailable/);
  assert.throws(() => lifecycle.ready(), /not ready/);
  fail = false;
  await lifecycle.refresh();
  assert.deepEqual(lifecycle.ready(), { loads: 3 });
});

test("pending initialization returns controlled health and directory unavailability without awaiting it", async (context) => {
  const gate = deferred();
  let calls = 0;
  const lifecycle = normal.createPublicationLifecycle({
    getDatabase: () => db,
    initialize: async () => {
      calls++;
      return gate.promise;
    },
  });
  const db = {};
  const work = lifecycle.refresh();
  const server = createApp({
    publicationReceiver: {
      authorized: () => false,
      health: async () => {
        try {
          return await lifecycle.withReady(({ receiver }) => receiver.health());
        } catch {
          return "unavailable";
        }
      },
      professionals: async () =>
        lifecycle.withReady(({ receiver }) => receiver.professionals()),
    },
    publicAuthority: {
      mode: async () =>
        lifecycle.withReady(({ authority }) => authority.mode()),
    },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`, {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal((await health.json()).database, "unavailable");
  assert.equal(
    (
      await fetch(`${base}/api/professionals`, {
        signal: AbortSignal.timeout(2000),
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await fetch(`${base}/api/schedule?date=2026-01-05`, {
        signal: AbortSignal.timeout(2000),
      })
    ).status,
    503,
  );
  assert.equal(calls, 1);
  gate.resolve({
    receiver: {
      health: async () => "connected",
      professionals: async () => ({ professionals: [] }),
    },
    authority: { mode: async () => "cedar" },
  });
  await work;
  assert.equal((await fetch(`${base}/api/professionals`)).status, 200);
});

test("invalidated queued initialization does not start or restore a binding", async () => {
  const db = {};
  let calls = 0;
  const lifecycle = normal.createPublicationLifecycle({
    getDatabase: () => db,
    initialize: async () => {
      calls++;
      return {};
    },
  });
  const work = lifecycle.refresh();
  lifecycle.invalidate();
  await assert.rejects(work, /not ready/);
  assert.equal(calls, 0);
  assert.throws(() => lifecycle.ready(), /not ready/);
});

test("authority responses from an obsolete connection are rejected after awaiting", async () => {
  const first = {},
    second = {},
    gate = deferred();
  let db = first;
  const lifecycle = normal.createPublicationLifecycle({
    getDatabase: () => db,
    initialize: async (value) => ({
      authority: {
        mode: () => (value === first ? gate.promise : Promise.resolve("cedar")),
      },
    }),
  });
  await lifecycle.refresh();
  const work = lifecycle.withReady(({ authority }) => authority.mode());
  const rejected = assert.rejects(work, /not ready/);
  db = second;
  await lifecycle.refresh();
  gate.resolve("legacy");
  await rejected;
  assert.equal(
    await lifecycle.withReady(({ authority }) => authority.mode()),
    "cedar",
  );
});
