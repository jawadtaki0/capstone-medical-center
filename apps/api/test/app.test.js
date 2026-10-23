import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

test("ordinary public source is unchanged and has no receiver-writing endpoint without explicit review injection", async (context) => {
  const marker = { professionals: [] };
  let reads = 0;
  const server = createApp({
    professionalsReader: async () => {
      reads++;
      return marker;
    },
  }).listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(
    await (await fetch(`${origin}/api/professionals`)).json(),
    marker,
  );
  assert.equal(reads, 1);
  assert.equal(
    (
      await fetch(`${origin}/api/publications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    404,
  );
});

test("GET /api/health reports the API and database state", async (context) => {
  const server = createApp({
    databaseHealthReader: async () => "connected",
  }).listen(0);
  context.after(() => server.close());

  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.service, "medical-center-api");
  assert.equal(body.status, "ok");
  assert.equal(body.database, "connected");
});

test("health reports a fresh unavailable state instead of a stale startup success", async (context) => {
  let currentState = "connected";
  const server = createApp({
    databaseHealthReader: async () => currentState,
  }).listen(0);
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  assert.equal((await (await fetch(url)).json()).database, "connected");
  currentState = "unavailable";
  assert.equal((await (await fetch(url)).json()).database, "unavailable");
});

test("unknown routes return a JSON 404", async (context) => {
  const server = createApp().listen(0);
  context.after(() => server.close());

  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/missing`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error, "not_found");
});
