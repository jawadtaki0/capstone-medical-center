import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { randomBytes } from "node:crypto";
import { assertIsolatedTestTarget, createSecurityFixture, digest, syntheticPassword,
  syntheticProfile, TEST_DATABASE } from "./helpers/security-fixture.js";

let fixture;
before(async () => { fixture = await createSecurityFixture(); });
beforeEach(async () => { await fixture.reset(); });
afterEach(async () => { await fixture.restart(); });
after(async () => { await fixture?.close(); });

function succeeded(response) {
  assert.ok([200, 201].includes(response.status), `Expected a successful response; received ${response.status}.`);
  assert.equal(response.body.error, undefined);
  return response.body;
}

function refused(response, expectedCode) {
  assert.ok(response.status >= 400 && response.status < 500, `Expected a safe rejection; received ${response.status}.`);
  assert.equal(typeof response.body.error?.code, "string");
  assert.notEqual(response.body.error.code, "not_found", "A missing endpoint is not authentication enforcement.");
  assert.notEqual(response.body.error.code, "route_not_found", "A missing endpoint is not authentication enforcement.");
  if (expectedCode) assert.equal(response.body.error.code, expectedCode);
  else assert.equal(["origin_denied", "transport_denied", "json_required"].includes(response.body.error.code), false,
    "A middleware mismatch must not masquerade as an authentication test passing.");
}

async function login(person) {
  return fixture.request("/auth/login", { method: "POST", body: { username: person.username, password: person.password } });
}

async function authenticate(person) {
  const first = succeeded(await login(person));
  if (first.token) return first;
  assert.equal(typeof first.challenge, "string");
  return succeeded(await fixture.request("/mfa/complete", { method: "POST", body: {
    challenge: first.challenge, code: await fixture.totp(person.secret),
  } }));
}

async function setupInput(options = {}) {
  const code = await fixture.issueSetup(options);
  return { code, username: `synthetic.${randomBytes(5).toString("hex")}`, password: syntheticPassword(), profile: syntheticProfile() };
}

async function claimAndEnroll(input) {
  const claim = succeeded(await fixture.request("/setup/claim", { method: "POST", body: input }));
  assert.equal(typeof claim.challenge, "string");
  assert.equal(claim.token, undefined, "Claiming setup must not issue a privileged session.");
  const enrollment = succeeded(await fixture.request("/mfa/enroll", { method: "POST", body: { challenge: claim.challenge } }));
  assert.equal(typeof enrollment.secret, "string");
  assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//);
  return { challenge: claim.challenge, secret: enrollment.secret };
}

async function completeEnrollment(enrollment) {
  return succeeded(await fixture.request("/mfa/complete", { method: "POST", body: {
    challenge: enrollment.challenge, code: await fixture.totp(enrollment.secret),
  } }));
}

async function invalidTotp(secret) {
  const valid = new Set(await Promise.all([-30000, 0, 30000].map((offset) => fixture.totp(secret, offset))));
  for (let candidate = 0; candidate < 10; candidate += 1) {
    const code = String(candidate).padStart(6, "0");
    if (!valid.has(code)) return code;
  }
  throw new Error("Could not select a known-invalid synthetic TOTP.");
}

test("integration fixtures reject every non-test, public, remote or existing local target before cleanup", () => {
  const valid = {
    db: { databaseName: TEST_DATABASE },
    config: { database: TEST_DATABASE, host: "127.0.0.1", port: 27018, replicaSet: "capstoneStaffDev" },
    client: { options: { hosts: [{ host: "127.0.0.1", port: 27018 }] } },
  };
  assert.doesNotThrow(() => assertIsolatedTestTarget(valid));
  for (const invalid of [
    { ...valid, db: { databaseName: "capstone_staff_dev" } },
    { ...valid, db: { databaseName: "medical-center-dev" } },
    { ...valid, config: { ...valid.config, port: 27017 } },
    { ...valid, config: { ...valid.config, host: "example.invalid" } },
    { ...valid, config: { ...valid.config, replicaSet: "other" } },
    { ...valid, client: { options: { hosts: [{ host: "127.0.0.1", port: 27017 }] } } },
  ]) assert.throws(() => assertIsolatedTestTarget(invalid), /isolated loopback staff-test/);
});

test("setup requires an issued unexpired private code and creates no account on expiry", async () => {
  const beforeIssue = await fixture.request("/setup/claim", { method: "POST", body: {
    code: "synthetic-not-issued", username: "synthetic.unissued", password: syntheticPassword(), profile: syntheticProfile(),
  } });
  refused(beforeIssue);
  const input = await setupInput({ expiresIn: -1 });
  refused(await fixture.request("/setup/claim", { method: "POST", body: input }));
  assert.equal(await fixture.db.collection("accounts").countDocuments({}), 0);
  assert.equal(await fixture.db.collection("staff_profiles").countDocuments({}), 0);
});

test("single-use bootstrap replay and simultaneous claims cannot create replacement Admins", async () => {
  const input = await setupInput();
  const responses = await Promise.all([
    fixture.request("/setup/claim", { method: "POST", body: input }),
    fixture.request("/setup/claim", { method: "POST", body: { ...input, username: `${input.username}.second` } }),
  ]);
  assert.equal(responses.filter((response) => [200, 201].includes(response.status)).length, 1);
  responses.filter((response) => ![200, 201].includes(response.status)).forEach((response) => refused(response));
  assert.equal(await fixture.db.collection("accounts").countDocuments({}), 1);
  assert.equal(await fixture.db.collection("staff_profiles").countDocuments({}), 1);
  const marker = await fixture.db.collection("installation_state").findOne({ _id: "first-admin" });
  assert.equal(marker.status, "claimed");
  assert.equal(Object.hasOwn(marker, "codeHash"), false);
  const account = await fixture.db.collection("accounts").findOne({ _id: marker.firstAccountId });
  assert.deepEqual(account.roles, ["Admin"]);
  assert.equal(account.status, "mfa_pending");
  assert.match(account.passwordHash, /^\$argon2id\$/);
  await fixture.restart({ reconnect: true });
  refused(await fixture.request("/setup/claim", { method: "POST", body: input }));
  assert.equal(await fixture.db.collection("accounts").countDocuments({}), 1);
});

test("a consumed bootstrap never reopens when its synthetic first account is removed", async () => {
  const input = await setupInput();
  succeeded(await fixture.request("/setup/claim", { method: "POST", body: input }));
  const marker = await fixture.db.collection("installation_state").findOne({ _id: "first-admin" });
  await fixture.db.collection("accounts").deleteOne({ _id: marker.firstAccountId });
  await fixture.restart({ reconnect: true });
  const status = succeeded(await fixture.request("/setup/status"));
  assert.equal(status.available, false);
  refused(await fixture.request("/setup/claim", { method: "POST", body: input }));
  assert.equal(await fixture.db.collection("accounts").countDocuments({}), 0);
  assert.equal((await fixture.db.collection("installation_state").findOne({ _id: "first-admin" })).status, "claimed");
});

test("an audit-write failure rolls back setup account, profile, challenge and marker mutations", async () => {
  const input = await setupInput();
  await fixture.restart({ failAudit: true });
  const response = await fixture.request("/setup/claim", { method: "POST", body: input });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "authority_unavailable");
  for (const name of ["accounts", "staff_profiles", "auth_challenges", "staff_sessions", "security_events"]) {
    assert.equal(await fixture.db.collection(name).countDocuments({}), 0);
  }
  const marker = await fixture.db.collection("installation_state").findOne({ _id: "first-admin" });
  assert.equal(marker.status, "issued");
  assert.equal(marker.codeHash === digest(input.code), true);
  await fixture.restart();
  succeeded(await fixture.request("/setup/claim", { method: "POST", body: input }));
});

test("setup failed-attempt limit persists across service restart without opening bootstrap", async () => {
  const input = await setupInput();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    refused(await fixture.request("/setup/claim", { method: "POST", body: { ...input, code: "synthetic-wrong-code" } }));
  }
  await fixture.restart({ reconnect: true });
  refused(await fixture.request("/setup/claim", { method: "POST", body: input }));
  assert.equal(await fixture.db.collection("accounts").countDocuments({}), 0);
});

test("interrupted pre-TOTP enrollment resumes through the chosen password, never repeat bootstrap", async () => {
  const input = await setupInput();
  const initial = await claimAndEnroll(input);
  refused(await fixture.request("/workspace", { token: initial.challenge }));
  await fixture.restart({ reconnect: true });
  const resumed = succeeded(await login(input));
  assert.equal(resumed.token, undefined);
  assert.equal(typeof resumed.challenge, "string");
  const enrollment = succeeded(await fixture.request("/mfa/enroll", { method: "POST", body: { challenge: resumed.challenge } }));
  assert.equal(enrollment.secret === initial.secret, true, "Password resumption must keep the already provisioned pending authenticator secret.");
  const completed = await completeEnrollment({ challenge: resumed.challenge, secret: enrollment.secret });
  assert.equal(typeof completed.token, "string");
  refused(await fixture.request("/workspace", { token: completed.token }), "backup_acknowledgement_required");
  refused(await fixture.request("/setup/claim", { method: "POST", body: input }));
  assert.equal(await fixture.db.collection("accounts").countDocuments({}), 1);
});

test("backup acknowledgement persists: restart and new MFA login cannot bypass it or redisplay codes", async () => {
  const input = await setupInput();
  const enrollment = await claimAndEnroll(input);
  const completed = await completeEnrollment(enrollment);
  assert.equal(completed.backupCodes.length, 10);
  assert.equal(new Set(completed.backupCodes).size, 10);
  refused(await fixture.request("/workspace", { token: completed.token }), "backup_acknowledgement_required");
  refused(await fixture.request("/auth/activity", { method: "POST", body: {}, token: completed.token }), "backup_acknowledgement_required");
  const codesBefore = (await fixture.db.collection("accounts").findOne({ username: input.username })).mfa.backupCodes;
  await fixture.restart({ reconnect: true });
  fixture.advance(30000);
  const fresh = await authenticate({ ...input, secret: enrollment.secret });
  assert.equal(fresh.backupCodes, undefined);
  refused(await fixture.request("/workspace", { token: fresh.token }), "backup_acknowledgement_required");
  const codesAfter = (await fixture.db.collection("accounts").findOne({ username: input.username })).mfa.backupCodes;
  assert.deepEqual(codesAfter, codesBefore, "Login must not regenerate lost backup codes.");
  succeeded(await fixture.request("/mfa/acknowledge", { method: "POST", body: {}, token: fresh.token }));
  succeeded(await fixture.request("/workspace", { token: fresh.token }));
  const account = await fixture.db.collection("accounts").findOne({ username: input.username });
  assert.equal(account.mfa.backupAcknowledged, true);
  assert.equal((await fixture.db.collection("installation_state").findOne({ _id: "first-admin" })).status, "completed");
  await fixture.restart({ reconnect: true });
  fixture.advance(30000);
  const acknowledgedLogin = await authenticate({ ...input, secret: enrollment.secret });
  assert.equal(acknowledgedLogin.needsBackupAcknowledgement, false);
  assert.equal(acknowledgedLogin.backupCodes, undefined);
  succeeded(await fixture.request("/workspace", { token: acknowledgedLogin.token }));
});

test("password, client roles and password-only MFA challenges cannot authorize a workspace", async () => {
  const person = await fixture.account({ roles: ["Admin"], mfa: true });
  refused(await fixture.request("/workspace"));
  refused(await fixture.request("/auth/login", { method: "POST", body: { username: person.username, password: "synthetic incorrect passphrase" } }));
  const first = succeeded(await fixture.request("/auth/login", { method: "POST", body: {
    username: `  ${person.username.toUpperCase()}  `, password: person.password, roles: ["Admin"],
  } }));
  assert.equal(first.token, undefined);
  refused(await fixture.request("/workspace", { token: first.challenge }));
  refused(await fixture.request("/mfa/backup", { method: "POST", body: { challenge: "synthetic-no-password-challenge", code: person.backupCodes[0] } }));
});

test("invalid and expired MFA challenges do not issue sessions, even when Mongo TTL has not deleted them", async () => {
  const person = await fixture.account({ roles: ["Clinic Admin"], mfa: true });
  const first = succeeded(await login(person));
  refused(await fixture.request("/mfa/complete", { method: "POST", body: { challenge: first.challenge, code: await invalidTotp(person.secret) } }));
  fixture.advance(5 * 60 * 1000);
  assert.ok(await fixture.db.collection("auth_challenges").findOne({ _id: digest(first.challenge) }));
  refused(await fixture.request("/mfa/complete", { method: "POST", body: { challenge: first.challenge, code: await fixture.totp(person.secret) } }));
  assert.equal(await fixture.db.collection("staff_sessions").countDocuments({}), 0);
});

test("enrollment challenge expires at ten minutes without granting password-only access", async () => {
  const input = await setupInput();
  const enrollment = await claimAndEnroll(input);
  fixture.advance(10 * 60 * 1000);
  refused(await fixture.request("/mfa/complete", { method: "POST", body: {
    challenge: enrollment.challenge, code: await fixture.totp(enrollment.secret),
  } }));
  assert.equal(await fixture.db.collection("staff_sessions").countDocuments({}), 0);
  assert.equal((await fixture.db.collection("accounts").findOne({ username: input.username })).status, "mfa_pending");
});

test("TOTP replay is rejected across distinct challenges, concurrent requests and restart", async () => {
  const person = await fixture.account({ roles: ["System Admin"], mfa: true });
  const challenges = await Promise.all([login(person), login(person)]);
  const code = await fixture.totp(person.secret);
  const attempts = await Promise.all(challenges.map((response) => fixture.request("/mfa/complete", {
    method: "POST", body: { challenge: succeeded(response).challenge, code },
  })));
  assert.equal(attempts.filter((response) => response.status === 200).length, 1);
  attempts.filter((response) => response.status !== 200).forEach((response) => refused(response));
  assert.equal(await fixture.db.collection("staff_sessions").countDocuments({}), 1);
  await fixture.restart({ reconnect: true });
  const next = succeeded(await login(person));
  refused(await fixture.request("/mfa/complete", { method: "POST", body: { challenge: next.challenge, code } }));
  fixture.advance(30000);
  const newer = succeeded(await login(person));
  succeeded(await fixture.request("/mfa/complete", { method: "POST", body: { challenge: newer.challenge, code: await fixture.totp(person.secret) } }));
});

test("an MFA audit failure rolls back factor replay state, challenge consumption and session issuance", async () => {
  const person = await fixture.account({ roles: ["Clinic Admin"], mfa: true });
  const first = succeeded(await login(person));
  const stepBefore = (await fixture.db.collection("accounts").findOne({ _id: person.id })).mfa.lastAcceptedStep;
  const eventsBefore = await fixture.db.collection("security_events").countDocuments({});
  const code = await fixture.totp(person.secret);
  await fixture.restart({ failAudit: true });
  const response = await fixture.request("/mfa/complete", { method: "POST", body: { challenge: first.challenge, code } });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "authority_unavailable");
  assert.equal((await fixture.db.collection("accounts").findOne({ _id: person.id })).mfa.lastAcceptedStep, stepBefore);
  assert.equal((await fixture.db.collection("auth_challenges").findOne({ _id: digest(first.challenge) })).consumedAt, null);
  assert.equal(await fixture.db.collection("staff_sessions").countDocuments({}), 0);
  assert.equal(await fixture.db.collection("security_events").countDocuments({}), eventsBefore);
  await fixture.restart();
  const recovered = succeeded(await fixture.request("/mfa/complete", { method: "POST", body: { challenge: first.challenge, code } }));
  succeeded(await fixture.request("/workspace", { token: recovered.token }));
});

test("configured one-step TOTP clock tolerance accepts adjacent steps, not arbitrary stale codes", async () => {
  for (const offset of [-30000, 30000]) {
    const person = await fixture.account({ roles: ["Lab Admin"], mfa: true });
    const first = succeeded(await login(person));
    succeeded(await fixture.request("/mfa/complete", { method: "POST", body: { challenge: first.challenge, code: await fixture.totp(person.secret, offset) } }));
  }
  const person = await fixture.account({ roles: ["Lab Admin"], mfa: true });
  const first = succeeded(await login(person));
  refused(await fixture.request("/mfa/complete", { method: "POST", body: { challenge: first.challenge, code: await invalidTotp(person.secret) } }));
  // Ensure this exercises the clock window, not the separate replay barrier.
  await fixture.db.collection("accounts").updateOne({ _id: person.id }, {
    $set: { "mfa.lastAcceptedStep": Math.floor(fixture.clock().getTime() / 30000) - 10 },
  });
  const allowedCodes = new Set(await Promise.all([-30000, 0, 30000].map((offset) => fixture.totp(person.secret, offset))));
  for (const direction of [-1, 1]) {
    let offset = direction * 60000;
    let outsideCode = await fixture.totp(person.secret, offset);
    // Six-digit codes can coincide; select an outside-window code that cannot
    // accidentally equal one of the three permitted values.
    while (allowedCodes.has(outsideCode)) {
      offset += direction * 30000;
      outsideCode = await fixture.totp(person.secret, offset);
    }
    refused(await fixture.request("/mfa/complete", { method: "POST", body: { challenge: first.challenge, code: outsideCode } }));
  }
});

test("MFA backup code consumption is atomic across challenges and survives restart", async () => {
  const person = await fixture.account({ roles: ["Lab Admin"], mfa: true });
  const logins = await Promise.all([login(person), login(person)]);
  const responses = await Promise.all(logins.map((response) => fixture.request("/mfa/backup", {
    method: "POST", body: { challenge: succeeded(response).challenge, code: person.backupCodes[0] },
  })));
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  responses.filter((response) => response.status !== 200).forEach((response) => refused(response));
  const account = await fixture.db.collection("accounts").findOne({ _id: person.id });
  assert.equal(account.mfa.backupCodes.filter(({ usedAt }) => usedAt instanceof Date).length, 1);
  await fixture.restart({ reconnect: true });
  const next = succeeded(await login(person));
  refused(await fixture.request("/mfa/backup", { method: "POST", body: { challenge: next.challenge, code: person.backupCodes[0] } }));
});

test("disabled accounts and later security-version changes invalidate existing sessions", async () => {
  const person = await fixture.account();
  const session = await authenticate(person);
  succeeded(await fixture.request("/workspace", { token: session.token }));
  await fixture.db.collection("accounts").updateOne({ _id: person.id }, { $inc: { version: 1 } });
  refused(await fixture.request("/workspace", { token: session.token }));
  const newer = await authenticate(person);
  await fixture.db.collection("accounts").updateOne({ _id: person.id }, { $set: { status: "disabled" } });
  refused(await fixture.request("/workspace", { token: newer.token }));
  refused(await login(person));
});

test("all six explicit roles have only foundation access; departments and unknown roles grant nothing", async () => {
  for (const role of ["Admin", "System Admin", "Clinic Admin", "Lab Admin", "Clinic Receptionist", "Lab Receptionist"]) {
    const person = await fixture.account({ roles: [role], mfa: role.endsWith("Admin"), departments: ["Clinic", "Laboratory"] });
    const session = await authenticate(person);
    const workspace = succeeded(await fixture.request("/workspace", { token: session.token }));
    assert.deepEqual(workspace.permissions, ["workspace:view"]);
    assert.equal(workspace.permissions.includes("schedule:write"), false);
    assert.equal(workspace.permissions.some((permission) => /clinical|patient|result/.test(permission)), false);
    for (const path of ["/accounts", "/patients", "/schedules", "/lab/results"]) {
      const response = await fixture.request(path, { token: session.token });
      assert.equal(response.status, 404, "Deferred workflows must not become usable endpoints.");
    }
  }
  const unknown = await fixture.account({ roles: ["Unknown Role"], departments: ["Administration"] });
  refused(await login(unknown));
});

test("logout revokes a persisted token and service restart does not resurrect it", async () => {
  const person = await fixture.account();
  const session = await authenticate(person);
  succeeded(await fixture.request("/auth/logout", { method: "POST", body: {}, token: session.token }));
  refused(await fixture.request("/auth/session", { token: session.token }));
  await fixture.restart({ reconnect: true });
  refused(await fixture.request("/workspace", { token: session.token }));
});

test("polling does not renew idle expiry; server denies access at exactly ten idle minutes", async () => {
  const session = await authenticate(await fixture.account());
  const expectedExpiry = Date.parse(session.session.idleExpiresAt);
  assert.equal(expectedExpiry - fixture.clock().getTime(), 10 * 60 * 1000);
  fixture.advance(9 * 60 * 1000);
  const polled = succeeded(await fixture.request("/auth/session", { token: session.token }));
  assert.equal(Date.parse(polled.session.idleExpiresAt), expectedExpiry);
  succeeded(await fixture.request("/workspace", { token: session.token }));
  fixture.advance(60 * 1000);
  refused(await fixture.request("/auth/session", { token: session.token }));
});

test("expired sessions are permanently revoked and repeated polls or clock rollback cannot revive them", async () => {
  const person = await fixture.account();
  const session = await authenticate(person);
  fixture.advance(10 * 60 * 1000);
  refused(await fixture.request("/auth/session", { token: session.token }));
  const revoked = await fixture.db.collection("staff_sessions").findOne({ _id: digest(session.token) });
  assert.ok(revoked.revokedAt instanceof Date);
  assert.equal(revoked.revocationReason, "idle_expired");
  const eventQuery = { action: "session_rejected", accountId: person.id };
  assert.equal(await fixture.db.collection("security_events").countDocuments(eventQuery), 1);
  refused(await fixture.request("/auth/session", { token: session.token }));
  fixture.advance(-10 * 60 * 1000);
  await fixture.restart({ reconnect: true });
  refused(await fixture.request("/workspace", { token: session.token }));
  assert.equal(await fixture.db.collection("security_events").countDocuments(eventQuery), 1,
    "A rejected token must not flood the security audit on repeated polling.");
});

test("explicit activity extends idle access, but never beyond the eight-hour absolute session limit", async () => {
  const session = await authenticate(await fixture.account());
  const absoluteExpiry = Date.parse(session.session.absoluteExpiresAt);
  assert.equal(absoluteExpiry - fixture.clock().getTime(), 8 * 60 * 60 * 1000);
  fixture.advance(9 * 60 * 1000);
  const renewed = succeeded(await fixture.request("/auth/activity", { method: "POST", body: {}, token: session.token }));
  assert.equal(Date.parse(renewed.session.idleExpiresAt) - fixture.clock().getTime(), 10 * 60 * 1000);
  // Repeated deliberate foreground activity, not background polling.
  while (fixture.clock().getTime() + 9 * 60 * 1000 < absoluteExpiry) {
    fixture.advance(9 * 60 * 1000);
    succeeded(await fixture.request("/auth/activity", { method: "POST", body: {}, token: session.token }));
  }
  fixture.advance(absoluteExpiry - fixture.clock().getTime());
  refused(await fixture.request("/workspace", { token: session.token }));
});

test("persistent login cooldown survives reconnection and expires only on the server clock", async () => {
  const person = await fixture.account();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    refused(await fixture.request("/auth/login", { method: "POST", body: { username: person.username, password: "synthetic incorrect passphrase" } }));
  }
  await fixture.restart({ reconnect: true });
  assert.equal((await login(person)).status, 429);
  fixture.advance(15 * 60 * 1000 - 1);
  assert.equal((await login(person)).status, 429);
  fixture.advance(1);
  assert.equal(typeof succeeded(await login(person)).token, "string");
});

test("browser origin and mutation content-type checks fail closed without ambient session cookies", async () => {
  const person = await fixture.account();
  const badOrigin = await fixture.request("/auth/login", { method: "POST", body: {
    username: person.username, password: person.password,
  }, originHeader: "https://untrusted.example.invalid" });
  refused(badOrigin, "origin_denied");
  const form = await fixture.request("/auth/login", { method: "POST", body: {
    username: person.username, password: person.password,
  }, headers: { "Content-Type": "text/plain" } });
  refused(form, "json_required");
  const response = await login(person);
  succeeded(response);
  assert.equal(response.headers.has("set-cookie"), false);
});

test("persistent accounts, challenges, sessions and audit evidence never contain raw test secrets", async () => {
  const input = await setupInput();
  const enrollment = await claimAndEnroll(input);
  const completed = await completeEnrollment(enrollment);
  const collections = ["installation_state", "accounts", "staff_profiles", "auth_challenges", "staff_sessions", "auth_throttles", "security_events"];
  const records = (await Promise.all(collections.map((name) => fixture.db.collection(name).find({}).toArray()))).flat();
  const serialized = JSON.stringify(records);
  for (const secret of [input.code, input.password, enrollment.challenge, enrollment.secret, completed.token, ...completed.backupCodes]) {
    assert.equal(serialized.includes(secret), false, "A raw secret was persisted outside its authorized protected representation.");
  }
  assert.ok(await fixture.db.collection("staff_sessions").findOne({ _id: digest(completed.token) }));
  assert.ok(await fixture.db.collection("security_events").countDocuments({}) > 0);
});
