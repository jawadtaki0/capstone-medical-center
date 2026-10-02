import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AUTH_POLICY, AUTH_THROTTLE_POLICIES } from "../src/auth.js";
import { createSecurityFixture, digest } from "./helpers/security-fixture.js";

// Only this guarded suite's synthetic capstone_staff_test records and its own
// ephemeral HTTP server are touched. Never connect to development accounts.
// The workspace test command runs files sequentially (--test-concurrency=1).
let fixture;
before(async () => { fixture = await createSecurityFixture(); });
beforeEach(async () => { await fixture.reset(); });
after(async () => {
  if (!fixture) return;
  try { await fixture.reset(); } finally { await fixture.close(); }
});

const sourceId = `source:${digest("127.0.0.1")}`;
const subjectId = (username) => `subject:${digest(username.trim().toLowerCase())}`;
const throttles = () => fixture.db.collection("auth_throttles");
const sourceRecord = () => throttles().findOne({ _id: sourceId });
const subjectRecord = (person) => throttles().findOne({ _id: subjectId(person.username) });

function succeeded(response) {
  assert.equal(response.status, 200, "Expected a successful synthetic authentication response.");
  assert.equal(response.body.error, undefined);
  return response.body;
}

function refused(response, status = 401) {
  assert.equal(response.status, status, "Security rejection must not be a missing route or technical failure.");
  assert.equal(response.body.error?.code, status === 429 ? "try_later" : "authentication_failed");
  assert.equal(response.body.token, undefined);
}

function login(person, password = person.password) {
  return fixture.request("/auth/login", { method: "POST", body: { username: person.username, password } });
}

function wrongPassword(person) {
  return login(person, "Synthetic deliberately incorrect credential only");
}

function wrongUnknown(index, headers = {}) {
  return fixture.request("/auth/login", { method: "POST", body: {
    username: `synthetic.spray.${String(index).padStart(3, "0")}`,
    password: "Synthetic deliberately incorrect credential only",
  }, headers });
}

async function authenticate(person) {
  const first = succeeded(await login(person));
  assert.equal(first.token, undefined, "An administrative password alone must not grant a session.");
  assert.equal(first.kind, "mfa");
  assert.equal(typeof first.challenge, "string");
  const final = succeeded(await fixture.request("/mfa/complete", { method: "POST", body: {
    challenge: first.challenge, code: await fixture.totp(person.secret),
  } }));
  assert.equal(typeof final.token, "string");
  return final;
}

async function invalidTotp(secret) {
  const allowed = new Set(await Promise.all([-30000, 0, 30000].map((offset) => fixture.totp(secret, offset))));
  for (let index = 0; index < 10; index += 1) {
    const candidate = String(index).padStart(6, "0");
    if (!allowed.has(candidate)) return candidate;
  }
  throw new Error("Could not select a known-invalid synthetic factor.");
}

test("account, challenge and aggregate-source policy retain the approved independent limits", () => {
  assert.equal(AUTH_POLICY.maxFailures, 5);
  assert.deepEqual(AUTH_THROTTLE_POLICIES.account, {
    maxFailures: 5, windowMs: 15 * 60000, cooldownMs: 15 * 60000,
  });
  assert.deepEqual(AUTH_THROTTLE_POLICIES.source, {
    maxFailures: 30, windowMs: 15 * 60000, cooldownMs: 15 * 60000,
  });
});

test("A's five failures block only A; B completes password plus MFA without clearing either failure history", async () => {
  const accountA = await fixture.account({ roles: ["Admin"], mfa: true });
  const accountB = await fixture.account({ roles: ["Clinic Admin"], mfa: true });
  for (let attempt = 0; attempt < 5; attempt += 1) refused(await wrongPassword(accountA));
  const blockedA = await subjectRecord(accountA);
  const sourceBefore = await sourceRecord();
  assert.equal(blockedA.failures, 5);
  assert.equal(sourceBefore.failures, 5);
  assert.ok(blockedA.blockedUntil > fixture.clock());
  assert.equal(sourceBefore.blockedUntil, null);
  refused(await login(accountA), 429);

  for (let attempt = 0; attempt < 4; attempt += 1) refused(await wrongPassword(accountB));
  const sharedAfterBFailures = await sourceRecord();
  assert.equal(sharedAfterBFailures.failures, 9);
  const passwordB = succeeded(await login(accountB));
  assert.equal(passwordB.kind, "mfa");
  assert.equal(passwordB.token, undefined);
  assert.equal((await subjectRecord(accountB)).failures, 4, "Password alone must not clear factor-stage failures.");
  const sessionB = succeeded(await fixture.request("/mfa/complete", { method: "POST", body: {
    challenge: passwordB.challenge, code: await fixture.totp(accountB.secret),
  } }));
  succeeded(await fixture.request("/workspace", { token: sessionB.token }));
  assert.deepEqual(await subjectRecord(accountA), blockedA, "B must not clear or extend A's cooldown.");
  assert.deepEqual(await sourceRecord(), sharedAfterBFailures, "A successful account must not erase aggregate source evidence.");
  assert.equal(await subjectRecord(accountB), null);
  refused(await login(accountA), 429);
});

test("29 distinct failures permit a valid MFA login; failure 30 blocks new authentication but not an existing session", async () => {
  const person = await fixture.account({ roles: ["System Admin"], mfa: true });
  for (let index = 0; index < 29; index += 1) refused(await wrongUnknown(index, {
    "X-Forwarded-For": `198.51.100.${index + 1}`,
  }));
  const before = await sourceRecord();
  assert.equal(before.failures, 29);
  assert.equal(before.blockedUntil, null);
  assert.equal(await throttles().countDocuments({ _id: /^source:/ }), 1,
    "Untrusted forwarded headers must not split the actual socket-source budget.");
  const authorized = await authenticate(person);
  assert.deepEqual(await sourceRecord(), before, "Full authentication must not reset the 29 shared-source failures.");

  refused(await wrongUnknown(29));
  const afterThreshold = await sourceRecord();
  assert.equal(afterThreshold.failures, 30);
  assert.equal(afterThreshold.blockedUntil.getTime() - fixture.clock().getTime(), 15 * 60000);
  assert.ok(afterThreshold.expiresAt >= afterThreshold.blockedUntil, "TTL must not remove an enforced block early.");
  refused(await login(person), 429);
  refused(await fixture.request("/auth/login", { method: "POST", headers: { "X-Forwarded-For": "203.0.113.9" },
    body: { username: person.username, password: person.password } }), 429);
  refused(await wrongUnknown(30), 429);
  assert.deepEqual(await sourceRecord(), afterThreshold, "Blocked retries must not silently extend the cooldown.");
  succeeded(await fixture.request("/auth/session", { token: authorized.token }));
  succeeded(await fixture.request("/workspace", { token: authorized.token }));
  succeeded(await fixture.request("/auth/activity", { method: "POST", body: {}, token: authorized.token }));
});

test("five bad TOTP attempts still exhaust A's challenge/account while B can authenticate on the shared source", async () => {
  const accountA = await fixture.account({ roles: ["Admin"], mfa: true });
  const accountB = await fixture.account({ roles: ["Lab Admin"], mfa: true });
  const first = succeeded(await login(accountA));
  const invalid = await invalidTotp(accountA.secret);
  for (let attempt = 0; attempt < 5; attempt += 1) refused(await fixture.request("/mfa/complete", {
    method: "POST", body: { challenge: first.challenge, code: invalid },
  }));
  const challenge = await fixture.db.collection("auth_challenges").findOne({ _id: digest(first.challenge) });
  assert.equal(challenge.attempts, 5);
  assert.equal(challenge.consumedAt, null);
  assert.equal((await subjectRecord(accountA)).failures, 5);
  assert.equal((await sourceRecord()).failures, 5);
  refused(await fixture.request("/mfa/complete", { method: "POST", body: {
    challenge: first.challenge, code: await fixture.totp(accountA.secret),
  } }), 429);
  refused(await login(accountA), 429);
  const sessionB = await authenticate(accountB);
  succeeded(await fixture.request("/workspace", { token: sessionB.token }));
  assert.equal((await subjectRecord(accountA)).failures, 5);
  assert.equal((await sourceRecord()).failures, 5);
});

test("five wrong backup attempts preserve the same account/challenge limit and do not lock B", async () => {
  const accountA = await fixture.account({ roles: ["Admin"], mfa: true });
  const accountB = await fixture.account({ roles: ["Clinic Admin"], mfa: true });
  const first = succeeded(await login(accountA));
  const invalid = Array.from({ length: 16 }, (_unused, index) => index.toString(16).repeat(32))
    .find((candidate) => !accountA.backupCodes.includes(candidate));
  assert.equal(typeof invalid, "string");
  for (let attempt = 0; attempt < 5; attempt += 1) refused(await fixture.request("/mfa/backup", {
    method: "POST", body: { challenge: first.challenge, code: invalid },
  }));
  const challenge = await fixture.db.collection("auth_challenges").findOne({ _id: digest(first.challenge) });
  assert.equal(challenge.attempts, 5);
  assert.equal(challenge.consumedAt, null);
  refused(await fixture.request("/mfa/backup", { method: "POST", body: {
    challenge: first.challenge, code: accountA.backupCodes[0],
  } }), 429);
  const storedA = await fixture.db.collection("accounts").findOne({ _id: accountA.id });
  assert.equal(storedA.mfa.backupCodes.filter((code) => code.usedAt !== null).length, 0);
  await authenticate(accountB);
  assert.equal((await subjectRecord(accountA)).failures, 5);
  assert.equal((await sourceRecord()).failures, 5);
});

test("account cooldown is anchored at failure five, not the original counting-window expiry", async () => {
  const accountA = await fixture.account({ roles: ["Admin"], mfa: true });
  const accountB = await fixture.account({ roles: ["Lab Admin"], mfa: true });
  const startedAt = fixture.clock().getTime();
  for (let attempt = 0; attempt < 4; attempt += 1) refused(await wrongPassword(accountA));
  fixture.advance(14 * 60000);
  refused(await wrongPassword(accountA));
  const blocked = await subjectRecord(accountA);
  assert.equal(blocked.windowStartedAt.getTime(), startedAt);
  assert.equal(blocked.blockedUntil.getTime(), startedAt + 29 * 60000);
  fixture.advance(60000); // Original 15-minute counting window is now over.
  refused(await login(accountA), 429);
  await authenticate(accountB);
  fixture.advance(14 * 60000 - 1);
  refused(await login(accountA), 429);
  fixture.advance(1);
  await authenticate(accountA);
  assert.equal(await subjectRecord(accountA), null);
});

test("source cooldown remains active after its counting window expires and ends at its own exact deadline", async () => {
  const person = await fixture.account({ roles: ["Clinic Admin"], mfa: true });
  const startedAt = fixture.clock().getTime();
  for (let index = 0; index < 29; index += 1) refused(await wrongUnknown(index));
  fixture.advance(14 * 60000);
  refused(await wrongUnknown(29));
  const blocked = await sourceRecord();
  assert.equal(blocked.windowStartedAt.getTime(), startedAt);
  assert.equal(blocked.blockedUntil.getTime(), startedAt + 29 * 60000);
  fixture.advance(60000);
  refused(await login(person), 429);
  fixture.advance(14 * 60000 - 1);
  refused(await login(person), 429);
  fixture.advance(1);
  await authenticate(person);
  refused(await wrongUnknown(30));
  const freshWindow = await sourceRecord();
  assert.equal(freshWindow.failures, 1);
  assert.equal(freshWindow.windowStartedAt.getTime(), fixture.clock().getTime());
  assert.equal(freshWindow.blockedUntil, null);
});

test("simultaneous fresh-account failures count exactly five before account enforcement, without technical upsert failures", async () => {
  const person = await fixture.account({ roles: ["Admin"], mfa: true });
  assert.equal(await subjectRecord(person), null);
  assert.equal(await sourceRecord(), null);
  const responses = await Promise.all(Array.from({ length: 6 }, () => wrongPassword(person)));
  assert.equal(responses.filter((response) => response.status === 401).length, 5);
  assert.equal(responses.filter((response) => response.status === 429).length, 1);
  responses.forEach((response) => refused(response, response.status === 429 ? 429 : 401));
  assert.equal((await subjectRecord(person)).failures, 5);
  assert.equal((await sourceRecord()).failures, 5);
  assert.equal(await fixture.db.collection("security_events").countDocuments({ action: "password_rejected", accountId: person.id }), 5);
  refused(await login(person), 429);
});

test("concurrent distinct-subject failures initialize and reach the source threshold without losing counts", async () => {
  assert.equal(await sourceRecord(), null);
  // Bounded batches exercise the initial source upsert and later contention
  // without thirty concurrent Argon2 jobs exhausting the development machine.
  for (let batch = 0; batch < 5; batch += 1) {
    const responses = await Promise.all(Array.from({ length: 6 }, (_unused, index) => wrongUnknown(batch * 6 + index)));
    responses.forEach((response) => refused(response));
    assert.equal((await sourceRecord()).failures, (batch + 1) * 6);
  }
  const source = await sourceRecord();
  assert.equal(source.failures, 30);
  assert.ok(source.blockedUntil > fixture.clock());
  assert.equal(await throttles().countDocuments({}), 31, "One source and thirty independent subjects must be preserved.");
  for (let index = 0; index < 30; index += 1) {
    const subject = await subjectRecord({ username: `synthetic.spray.${String(index).padStart(3, "0")}` });
    assert.equal(subject.failures, 1);
    assert.equal(subject.blockedUntil, null);
  }
  assert.equal(await fixture.db.collection("security_events").countDocuments({ action: "password_rejected" }), 30);
  refused(await wrongUnknown(30), 429);
});

test("six simultaneous unique failures at source count 29 admit exactly one final counted failure", async () => {
  for (let index = 0; index < 29; index += 1) refused(await wrongUnknown(index));
  assert.equal((await sourceRecord()).failures, 29);
  const responses = await Promise.all(Array.from({ length: 6 }, (_unused, index) => wrongUnknown(29 + index)));
  assert.equal(responses.filter((response) => response.status === 401).length, 1);
  assert.equal(responses.filter((response) => response.status === 429).length, 5);
  responses.forEach((response) => refused(response, response.status === 429 ? 429 : 401));
  const source = await sourceRecord();
  assert.equal(source.failures, 30, "Concurrent retries must recheck the reached source threshold.");
  assert.equal(source.blockedUntil.getTime() - fixture.clock().getTime(), 15 * 60000);
  assert.equal(await throttles().countDocuments({ _id: /^subject:/ }), 30);
  assert.equal(await fixture.db.collection("security_events").countDocuments({ action: "password_rejected" }), 30);
});

test("a previously stored source cooldown is preserved until expiry when the source threshold changes", async () => {
  const person = await fixture.account({ roles: ["Admin"], mfa: true });
  const at = fixture.clock();
  const legacy = { _id: sourceId, failures: 5, windowStartedAt: at,
    blockedUntil: new Date(at.getTime() + 15 * 60000), expiresAt: new Date(at.getTime() + 30 * 60000) };
  await throttles().insertOne(legacy);
  refused(await login(person), 429);
  assert.deepEqual(await sourceRecord(), legacy, "A threshold change must not silently erase an already issued cooldown.");
  fixture.advance(15 * 60000 - 1);
  refused(await login(person), 429);
  fixture.advance(1);
  await authenticate(person);
});
