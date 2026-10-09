import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseConnection } from "../src/db.js";

function fakeClient({ connect = async () => {}, ping = async () => {} } = {}) {
  const calls = { connect: 0, ping: 0, close: 0 };
  const database = {
    async command(command) {
      assert.deepEqual(command, { ping: 1 });
      calls.ping += 1;
      return ping();
    },
  };
  return {
    calls,
    database,
    async connect() {
      calls.connect += 1;
      await connect();
    },
    db(name) {
      assert.equal(name, "synthetic_test");
      return database;
    },
    async close() {
      calls.close += 1;
    },
  };
}

function connectionWith(createClient) {
  return createDatabaseConnection({
    uri: "synthetic-uri",
    dbName: "synthetic_test",
    createClient,
  });
}

test("missing configuration never attempts a connection", async () => {
  const connection = createDatabaseConnection({
    uri: null,
    createClient: () => assert.fail("No client expected"),
  });
  assert.equal(await connection.connect(), null);
  assert.equal(await connection.health(), "not-configured");
  assert.throws(connection.get, /not connected/);
});

test("failed startup cleans up and a later attempt recovers without a restart", async () => {
  const failed = fakeClient({
    connect: async () => {
      throw new Error("Synthetic TLS failure");
    },
  });
  const recovered = fakeClient();
  let attempts = 0;
  const connection = connectionWith(() =>
    ++attempts === 1 ? failed : recovered,
  );
  await assert.rejects(connection.connect(), /Synthetic TLS/);
  assert.equal(connection.status(), "unavailable");
  assert.equal(failed.calls.close, 1);
  assert.throws(connection.get, /not connected/);
  assert.equal(await connection.connect(), recovered.database);
  assert.equal(connection.status(), "connected");
  assert.equal(connection.get(), recovered.database);
  await connection.close();
});

test("concurrent startup/health/retry calls share one attempt and client", async () => {
  const client = fakeClient();
  let clients = 0;
  const connection = connectionWith(() => {
    clients += 1;
    return client;
  });
  const [first, second, health] = await Promise.all([
    connection.connect(),
    connection.connect(),
    connection.health(),
  ]);
  assert.equal(first, client.database);
  assert.equal(second, first);
  assert.equal(health, "connected");
  assert.equal(clients, 1);
  assert.equal(client.calls.connect, 1);
  assert.equal(client.calls.ping, 1);
  await connection.close();
});

test("health reuses the pool, detects a later outage, and permits recovery", async () => {
  let unavailable = false;
  const first = fakeClient({
    ping: async () => {
      if (unavailable) throw new Error("Synthetic outage");
    },
  });
  const second = fakeClient();
  let clients = 0;
  const connection = connectionWith(() => (++clients === 1 ? first : second));
  assert.equal(await connection.health(), "connected");
  assert.equal(await connection.health(), "connected");
  assert.equal(clients, 1);
  unavailable = true;
  assert.equal(await connection.health(), "unavailable");
  assert.equal(first.calls.close, 1);
  assert.throws(connection.get, /not connected/);
  assert.equal(await connection.health(), "connected");
  assert.equal(connection.get(), second.database);
  await connection.close();
});

test("closing during startup prevents late publication of the database", async () => {
  let finishConnect;
  const waiting = new Promise((resolve) => {
    finishConnect = resolve;
  });
  const client = fakeClient({ connect: () => waiting });
  const connection = connectionWith(() => client);
  const pending = connection.connect();
  await Promise.resolve();
  assert.equal(connection.status(), "connecting");
  await connection.close();
  finishConnect();
  assert.equal(await pending, null);
  assert.equal(connection.status(), "disconnected");
  assert.throws(connection.get, /not connected/);
  assert.equal(client.calls.close, 1);
  assert.equal(client.calls.ping, 0);
});

test("client-construction errors also leave a retryable unavailable state", async () => {
  const client = fakeClient();
  let attempts = 0;
  const connection = connectionWith(() => {
    if (++attempts === 1) throw new Error("Synthetic configuration failure");
    return client;
  });
  assert.equal(await connection.health(), "unavailable");
  assert.equal(await connection.health(), "connected");
  await connection.close();
});
