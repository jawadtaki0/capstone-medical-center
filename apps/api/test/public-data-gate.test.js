import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createPublicDataGate } from "../src/public-data-gate.js";

test("migration gate drains existing reads, blocks new data reads, and leaves health available", async (context) => {
  let paused = false;
  let finishRead;
  const pending = new Promise((resolve) => {
    finishRead = resolve;
  });
  const gate = createPublicDataGate({ paused: () => paused });
  const server = createApp({
    publicDataGate: gate,
    databaseHealthReader: async () => "connected",
    professionalsReader: async () => {
      await pending;
      return { professionals: [] };
    },
  }).listen(0);
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = fetch(`${origin}/api/professionals`);
  for (let tries = 0; tries < 100 && !gate.status().activeReaders; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(gate.status().activeReaders, 1);
  paused = true;
  for (const path of ["/api/professionals", "/api/schedule"]) {
    const blocked = await fetch(`${origin}${path}`);
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error, "schema_migration_in_progress");
  }
  const health = await (await fetch(`${origin}/api/health`)).json();
  assert.deepEqual(health.publicData, { paused: true, activeReaders: 1 });
  assert.equal(health.database, "connected");
  finishRead();
  assert.equal((await first).status, 200);
  assert.equal(gate.status().activeReaders, 0);
  paused = false;
  assert.equal((await fetch(`${origin}/api/professionals`)).status, 200);
});

test("a disconnected client's pending reader stays counted until its database read completes", async (context) => {
  let paused = false;
  let finishRead;
  let readerStarted;
  let responseClosed;
  const pending = new Promise((resolve) => {
    finishRead = resolve;
  });
  const started = new Promise((resolve) => {
    readerStarted = resolve;
  });
  const closed = new Promise((resolve) => {
    responseClosed = resolve;
  });
  const gate = createPublicDataGate({ paused: () => paused });
  const server = createApp({
    publicDataGate: gate,
    databaseHealthReader: async () => "connected",
    scheduleReader: async () => {
      readerStarted();
      await pending;
      return { date: "2026-10-01", doctorSessions: [] };
    },
  }).listen(0);
  server.on("request", (request, response) => {
    if (request.url.startsWith("/api/schedule"))
      response.once("close", responseClosed);
  });
  context.after(() => {
    finishRead();
    server.close();
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const first = fetch(`${origin}/api/schedule?date=2026-10-01`, {
    signal: controller.signal,
  }).catch((error) => error);
  await started;
  assert.equal(gate.status().activeReaders, 1);
  paused = true;
  controller.abort();
  assert.equal((await first).name, "AbortError");
  await closed;
  assert.equal(gate.status().activeReaders, 1);

  const health = await (await fetch(`${origin}/api/health`)).json();
  assert.deepEqual(health.publicData, { paused: true, activeReaders: 1 });
  assert.equal((await fetch(`${origin}/api/professionals`)).status, 503);
  finishRead();
  for (let tries = 0; tries < 100 && gate.status().activeReaders; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(gate.status(), { paused: true, activeReaders: 0 });
});

test("reader failures release the gate without depending on response events", async () => {
  const gate = createPublicDataGate({ paused: () => false });
  const guarded = gate.guard(async () => {
    assert.equal(gate.status().activeReaders, 1);
    throw new Error("Synthetic read failure");
  });
  await assert.rejects(guarded({}, {}), /Synthetic read failure/);
  assert.equal(gate.status().activeReaders, 0);
});
