import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { AUTH_THROTTLE_POLICIES } from "../src/auth.js";
import { createSecurityFixture, digest } from "./helpers/security-fixture.js";
import { startIsolatedApiProcess } from "./helpers/isolated-api-process.js";

// Serial execution is required: this file owns the same guarded synthetic
// database as the other integration tests, never the development authority.
let fixture;
let child;
before(async () => {
  fixture = await createSecurityFixture();
});
beforeEach(async () => {
  await fixture.reset();
  child = await startIsolatedApiProcess();
});
afterEach(async () => {
  try {
    await child?.stop();
    child = undefined;
  } finally {
    await fixture?.reset();
  }
});
after(async () => {
  try {
    await child?.stop();
  } finally {
    await fixture?.close();
  }
});

function allowed(response) {
  assert.equal(
    response.status,
    200,
    "Expected successful isolated authentication.",
  );
  assert.equal(response.body.error, undefined);
  return response.body;
}

function blocked(response) {
  assert.equal(response.status, 429);
  assert.equal(response.body.error?.code, "try_later");
  assert.equal(typeof response.body.token, "undefined");
  assert.equal(typeof response.body.challenge, "undefined");
}

function login(person, password = person.password) {
  return child.request("/auth/login", {
    body: { username: person.username, password },
  });
}

async function restartChild() {
  const previousPid = child.pid;
  await child.stop();
  child = await startIsolatedApiProcess();
  assert.notEqual(
    child.pid,
    previousPid,
    "Persistence must be tested using a genuinely new API process.",
  );
}

async function bucket(kind, value) {
  return fixture.db
    .collection("auth_throttles")
    .findOne({ _id: `${kind}:${digest(value)}` });
}

test("account cooldown survives a separate API process; another account does not erase its block or source failures", async () => {
  assert.equal(AUTH_THROTTLE_POLICIES.account.maxFailures, 5);
  assert.equal(AUTH_THROTTLE_POLICIES.source.maxFailures, 30);
  const a = await fixture.account();
  const b = await fixture.account();
  for (
    let attempt = 0;
    attempt < AUTH_THROTTLE_POLICIES.account.maxFailures;
    attempt += 1
  ) {
    const failed = await login(a, "Synthetic incorrect account passphrase");
    assert.equal(failed.status, 401);
    assert.equal(failed.body.error?.code, "authentication_failed");
  }
  blocked(await login(a));
  const accountBefore = await bucket("subject", a.username);
  const sourceBefore = await bucket("source", "127.0.0.1");
  assert.ok(accountBefore.blockedUntil instanceof Date);
  assert.equal(sourceBefore.failures, 5);
  const bSession = allowed(await login(b));
  assert.equal(typeof bSession.token, "string");
  const afterSuccess = await bucket("subject", a.username);
  assert.equal(
    afterSuccess.blockedUntil.getTime(),
    accountBefore.blockedUntil.getTime(),
  );
  assert.equal(
    (await bucket("source", "127.0.0.1")).failures,
    sourceBefore.failures,
  );
  await restartChild();
  blocked(await login(a));
  allowed(await child.request("/workspace", { token: bSession.token }));
  allowed(await login(b));
  assert.equal(
    (await bucket("subject", a.username)).blockedUntil.getTime(),
    accountBefore.blockedUntil.getTime(),
  );
  assert.equal(
    (await bucket("source", "127.0.0.1")).failures,
    sourceBefore.failures,
  );
});

test("aggregate source cooldown survives a separate API process without invalidating an existing authorized session", async () => {
  const protectedPerson = await fixture.account();
  const protectedSession = allowed(await login(protectedPerson));
  assert.equal(typeof protectedSession.token, "string");
  const fresh = await fixture.account();
  const accounts = [];
  const requiredAccounts = Math.ceil(
    AUTH_THROTTLE_POLICIES.source.maxFailures /
      AUTH_THROTTLE_POLICIES.account.maxFailures,
  );
  for (let index = 0; index < requiredAccounts; index += 1)
    accounts.push(await fixture.account());
  for (
    let attempt = 0;
    attempt < AUTH_THROTTLE_POLICIES.source.maxFailures;
    attempt += 1
  ) {
    const person =
      accounts[
        Math.floor(attempt / AUTH_THROTTLE_POLICIES.account.maxFailures)
      ];
    const failed = await login(
      person,
      "Synthetic incorrect aggregate passphrase",
    );
    assert.equal(
      failed.status,
      401,
      "Each counted aggregate failure must be a real authentication denial.",
    );
    assert.equal(failed.body.error?.code, "authentication_failed");
  }
  const sourceBefore = await bucket("source", "127.0.0.1");
  assert.equal(sourceBefore.failures, 30);
  assert.ok(sourceBefore.blockedUntil instanceof Date);
  blocked(await login(fresh));
  allowed(
    await child.request("/auth/session", { token: protectedSession.token }),
  );
  allowed(await child.request("/workspace", { token: protectedSession.token }));
  await restartChild();
  blocked(await login(fresh));
  allowed(await child.request("/workspace", { token: protectedSession.token }));
  const persisted = await bucket("source", "127.0.0.1");
  assert.equal(persisted.failures, sourceBefore.failures);
  assert.equal(
    persisted.blockedUntil.getTime(),
    sourceBefore.blockedUntil.getTime(),
  );
});
