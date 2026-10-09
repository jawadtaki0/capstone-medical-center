import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import * as argon2 from "argon2";
import {
  createSecurityFixture,
  digest,
  syntheticPassword,
  syntheticProfile,
} from "./helpers/security-fixture.js";

// This suite uses the fixture's exact database/host/port/replica-set guard and
// allowlisted cleanup. All accounts/profiles are synthetic capstone_staff_test
// records; it never uses development accounts or restarts MongoDB.
let fixture;
before(async () => {
  fixture = await createSecurityFixture();
});
beforeEach(async () => {
  await fixture.reset();
});
after(async () => {
  await fixture?.close();
});

function success(response) {
  assert.equal(
    response.status,
    200,
    `Expected success, received ${response.status}.`,
  );
  assert.equal(response.body.error, undefined);
  return response.body;
}
function denial(response, code) {
  assert.ok(
    response.status >= 400 && response.status < 500,
    `Expected safe denial, received ${response.status}.`,
  );
  if (code) assert.equal(response.body.error?.code, code);
}
const post = (path, body, token) =>
  fixture.request(path, { method: "POST", body, token });
async function signIn(person) {
  const first = success(
    await post("/auth/login", {
      username: person.username,
      password: person.password,
    }),
  );
  return first.token
    ? first
    : success(
        await post("/mfa/complete", {
          challenge: first.challenge,
          code: await fixture.totp(person.secret),
        }),
      );
}
async function manager() {
  const person = await fixture.account({
    roles: ["Admin"],
    mfa: true,
    departments: ["Administration"],
  });
  return { person, session: await signIn(person) };
}
async function createEmployee(actor, roles = ["Clinic Receptionist"]) {
  const profile = syntheticProfile({
    qualification: {
      type: "university",
      level: "Bachelor",
      title: "Synthetic relevant degree",
      institution: "Synthetic institution",
    },
  });
  return success(
    await post(
      "/staff",
      {
        username: `synthetic.${digest(profile.email).slice(0, 12)}`,
        roles,
        profile,
      },
      actor.token,
    ),
  );
}
const setupInput = (created) => ({
  username: created.account.username,
  code: created.setupCode,
  password: syntheticPassword(),
});
const staffPath = (id, action) => `/staff/${encodeURIComponent(id)}/${action}`;
async function invalidTotp(secret) {
  const valid = new Set(
    await Promise.all(
      [-30000, 0, 30000].map((offset) => fixture.totp(secret, offset)),
    ),
  );
  for (let index = 0; index < 10; index += 1) {
    const code = String(index).padStart(6, "0");
    if (!valid.has(code)) return code;
  }
  throw new Error("Could not select an invalid synthetic token.");
}

test("assigned setup concurrent consumption has one winner, no password overwrite and durable replay denial", async () => {
  const actor = await manager();
  const created = await createEmployee(actor.session);
  const inputs = [setupInput(created), setupInput(created)];
  const responses = await Promise.all(
    inputs.map((body) => post("/account/setup", body)),
  );
  assert.equal(
    responses.filter((response) => response.status === 200).length,
    1,
  );
  responses
    .filter((response) => response.status !== 200)
    .forEach((response) => denial(response, "authentication_failed"));
  const winner = responses.findIndex((response) => response.status === 200);
  const account = await fixture.db
    .collection("accounts")
    .findOne({ _id: created.account.id });
  assert.equal(account.status, "active");
  assert.equal(account.version, 2);
  assert.equal(
    await argon2.verify(account.passwordHash, inputs[winner].password),
    true,
  );
  assert.equal(
    await argon2.verify(account.passwordHash, inputs[1 - winner].password),
    false,
  );
  const code = await fixture.db
    .collection("account_setup_codes")
    .findOne({ _id: account._id });
  assert.ok(code.consumedAt instanceof Date);
  assert.equal(
    await fixture.db
      .collection("staff_sessions")
      .countDocuments({ accountId: account._id }),
    1,
  );
  assert.equal(
    await fixture.db.collection("installation_state").countDocuments({}),
    0,
  );
  await fixture.restart({ reconnect: true });
  denial(await post("/account/setup", inputs[winner]), "authentication_failed");
  assert.equal(
    (await fixture.db.collection("accounts").findOne({ _id: account._id }))
      .passwordHash === account.passwordHash,
    true,
  );
});

test("setup consumption racing code replacement commits only one consistent generation", async () => {
  const actor = await manager();
  const created = await createEmployee(actor.session);
  const original = setupInput(created);
  const [claim, replacement] = await Promise.all([
    post("/account/setup", original),
    post(
      staffPath(created.account.id, "setup-code"),
      { expectedVersion: created.account.version },
      actor.session.token,
    ),
  ]);
  assert.equal(
    [claim, replacement].filter((response) => response.status === 200).length,
    1,
  );
  if (claim.status === 200) {
    denial(replacement);
    assert.equal(
      (
        await fixture.db
          .collection("accounts")
          .findOne({ _id: created.account.id })
      ).status,
      "active",
    );
    assert.equal(
      (await fixture.request("/workspace", { token: claim.body.token })).status,
      200,
    );
  } else {
    denial(claim, "authentication_failed");
    const next = success(replacement);
    const record = await fixture.db
      .collection("account_setup_codes")
      .findOne({ _id: created.account.id });
    assert.equal(record.generation, 2);
    assert.equal(record.codeHash === digest(original.code), false);
    const activated = success(
      await post("/account/setup", { ...original, code: next.setupCode }),
    );
    assert.equal(
      (await fixture.request("/workspace", { token: activated.token })).status,
      200,
    );
  }
  assert.equal(
    await fixture.db
      .collection("staff_profiles")
      .countDocuments({ accountId: created.account.id }),
    1,
  );
});

test("assigned password audit failure rolls back consumption/password/version and permits a safe retry", async () => {
  const actor = await manager();
  const created = await createEmployee(actor.session);
  const input = setupInput(created);
  const before = await fixture.db
    .collection("accounts")
    .findOne({ _id: created.account.id });
  const codeBefore = await fixture.db
    .collection("account_setup_codes")
    .findOne({ _id: created.account.id });
  await fixture.restart({ failAudit: true });
  const response = await post("/account/setup", input);
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "authority_unavailable");
  assert.deepEqual(
    await fixture.db.collection("accounts").findOne({ _id: before._id }),
    before,
  );
  assert.deepEqual(
    await fixture.db
      .collection("account_setup_codes")
      .findOne({ _id: before._id }),
    codeBefore,
  );
  assert.equal(
    await fixture.db
      .collection("staff_sessions")
      .countDocuments({ accountId: before._id }),
    0,
  );
  await fixture.restart();
  assert.ok(success(await post("/account/setup", input)).token);
});

test("assigned setup rejects expiry/disabled state and five wrong attempts survive replacement and restart", async () => {
  const actor = await manager();
  const expired = await createEmployee(actor.session);
  await fixture.db
    .collection("account_setup_codes")
    .updateOne(
      { _id: expired.account.id },
      { $set: { expiresAt: fixture.clock() } },
    );
  denial(
    await post("/account/setup", setupInput(expired)),
    "authentication_failed",
  );
  const disabled = await createEmployee(actor.session);
  success(
    await post(
      staffPath(disabled.account.id, "status"),
      { expectedVersion: disabled.account.version, enabled: false },
      actor.session.token,
    ),
  );
  denial(
    await post("/account/setup", setupInput(disabled)),
    "authentication_failed",
  );
  const limited = await createEmployee(actor.session);
  const input = setupInput(limited);
  for (let index = 0; index < 5; index += 1)
    denial(
      await post("/account/setup", {
        ...input,
        code: "wrong synthetic setup code",
      }),
      "authentication_failed",
    );
  const replacement = success(
    await post(
      staffPath(limited.account.id, "setup-code"),
      { expectedVersion: limited.account.version },
      actor.session.token,
    ),
  );
  await fixture.restart({ reconnect: true });
  denial(
    await post("/account/setup", { ...input, code: replacement.setupCode }),
    "try_later",
  );
  assert.equal(
    (
      await fixture.db
        .collection("accounts")
        .findOne({ _id: limited.account.id })
    ).status,
    "setup_pending",
  );
  assert.equal(
    (
      await fixture.db
        .collection("account_setup_codes")
        .findOne({ _id: limited.account.id })
    ).consumedAt,
    null,
  );
});

test("reverification backup double-use across two sessions atomically grants only one proof", async () => {
  const actor = await manager();
  fixture.advance(30000);
  const second = await signIn(actor.person);
  const firstChallenge = success(
    await post(
      "/auth/reverify/start",
      { password: actor.person.password },
      actor.session.token,
    ),
  );
  const secondChallenge = success(
    await post(
      "/auth/reverify/start",
      { password: actor.person.password },
      second.token,
    ),
  );
  const before = await fixture.db
    .collection("staff_sessions")
    .find({ accountId: actor.person.id })
    .toArray();
  const responses = await Promise.all([
    post(
      "/auth/reverify/complete",
      {
        challenge: firstChallenge.challenge,
        code: actor.person.backupCodes[0],
        method: "backup",
      },
      actor.session.token,
    ),
    post(
      "/auth/reverify/complete",
      {
        challenge: secondChallenge.challenge,
        code: actor.person.backupCodes[0],
        method: "backup",
      },
      second.token,
    ),
  ]);
  assert.equal(
    responses.filter((response) => response.status === 200).length,
    1,
  );
  responses
    .filter((response) => response.status !== 200)
    .forEach((response) => denial(response, "verification_failed"));
  responses.forEach((response) =>
    assert.equal(Object.hasOwn(response.body, "token"), false),
  );
  const account = await fixture.db
    .collection("accounts")
    .findOne({ _id: actor.person.id });
  assert.equal(
    account.mfa.backupCodes.filter((code) => code.usedAt !== null).length,
    1,
  );
  assert.equal(
    await fixture.db
      .collection("auth_challenges")
      .countDocuments({ purpose: "reverify", consumedAt: { $ne: null } }),
    1,
  );
  const afterRecords = await fixture.db
    .collection("staff_sessions")
    .find({ accountId: actor.person.id })
    .toArray();
  assert.equal(afterRecords.length, before.length);
  for (const old of before) {
    const current = afterRecords.find((record) => record._id === old._id);
    assert.equal(
      current.lastActivityAt.getTime(),
      old.lastActivityAt.getTime(),
    );
    assert.equal(
      current.absoluteExpiresAt.getTime(),
      old.absoluteExpiresAt.getTime(),
    );
    assert.equal(current.expiresAt.getTime(), old.expiresAt.getTime());
  }
});

test("concurrent reverify TOTP consumption across sessions accepts one factor step only", async () => {
  const actor = await manager();
  fixture.advance(30000);
  const second = await signIn(actor.person);
  const firstChallenge = success(
    await post(
      "/auth/reverify/start",
      { password: actor.person.password },
      actor.session.token,
    ),
  );
  const secondChallenge = success(
    await post(
      "/auth/reverify/start",
      { password: actor.person.password },
      second.token,
    ),
  );
  fixture.advance(30000);
  const code = await fixture.totp(actor.person.secret);
  const responses = await Promise.all([
    post(
      "/auth/reverify/complete",
      { challenge: firstChallenge.challenge, code },
      actor.session.token,
    ),
    post(
      "/auth/reverify/complete",
      { challenge: secondChallenge.challenge, code },
      second.token,
    ),
  ]);
  assert.equal(
    responses.filter((response) => response.status === 200).length,
    1,
  );
  responses
    .filter((response) => response.status !== 200)
    .forEach((response) => denial(response, "verification_failed"));
  const account = await fixture.db
    .collection("accounts")
    .findOne({ _id: actor.person.id });
  assert.equal(
    account.mfa.lastAcceptedStep,
    Math.floor(fixture.clock().getTime() / 30000),
  );
  assert.equal(
    await fixture.db
      .collection("auth_challenges")
      .countDocuments({ purpose: "reverify", consumedAt: { $ne: null } }),
    1,
  );
});

test("reverification is session-bound, single-use, supersedes old proof and preserves failures/cooldown over restart", async () => {
  const actor = await manager();
  fixture.advance(30000);
  const second = await signIn(actor.person);
  const first = success(
    await post(
      "/auth/reverify/start",
      { password: actor.person.password },
      actor.session.token,
    ),
  );
  denial(
    await post(
      "/auth/reverify/complete",
      {
        challenge: first.challenge,
        code: actor.person.backupCodes[0],
        method: "backup",
      },
      second.token,
    ),
    "verification_failed",
  );
  assert.equal(
    (
      await fixture.db
        .collection("auth_challenges")
        .findOne({ _id: digest(first.challenge) })
    ).attempts,
    0,
  );
  const next = success(
    await post(
      "/auth/reverify/start",
      { password: actor.person.password },
      actor.session.token,
    ),
  );
  denial(
    await post(
      "/auth/reverify/complete",
      {
        challenge: first.challenge,
        code: actor.person.backupCodes[0],
        method: "backup",
      },
      actor.session.token,
    ),
    "verification_failed",
  );
  success(
    await post(
      "/auth/reverify/complete",
      {
        challenge: next.challenge,
        code: actor.person.backupCodes[0],
        method: "backup",
      },
      actor.session.token,
    ),
  );
  denial(
    await post(
      "/auth/reverify/complete",
      {
        challenge: next.challenge,
        code: actor.person.backupCodes[1],
        method: "backup",
      },
      actor.session.token,
    ),
    "verification_failed",
  );
  const throttleId = `subject:${digest(actor.person.username)}`;
  assert.equal(
    (await fixture.db.collection("auth_throttles").findOne({ _id: throttleId }))
      .failures,
    3,
  );
  await fixture.restart({ reconnect: true });
  for (let index = 0; index < 2; index += 1)
    denial(
      await post(
        "/auth/reverify/start",
        { password: "wrong synthetic password" },
        actor.session.token,
      ),
      "verification_failed",
    );
  denial(
    await post(
      "/auth/reverify/start",
      { password: actor.person.password },
      actor.session.token,
    ),
    "try_later",
  );
  assert.equal(
    (await fixture.request("/workspace", { token: actor.session.token }))
      .status,
    200,
  );
  assert.equal(
    (await fixture.db.collection("auth_throttles").findOne({ _id: throttleId }))
      .failures,
    5,
  );
});

test("recent actual login proof expires at five minutes; reverify does not extend idle or absolute deadlines", async () => {
  const actor = await manager();
  const record = await fixture.db
    .collection("staff_sessions")
    .findOne({ _id: digest(actor.session.token) });
  const proofExpiry = actor.session.session.recentVerificationExpiresAt;
  assert.equal(
    new Date(proofExpiry).getTime() - record.passwordVerifiedAt.getTime(),
    5 * 60000,
  );
  fixture.advance(5 * 60000);
  const stale = success(
    await fixture.request("/auth/session", { token: actor.session.token }),
  );
  assert.equal(stale.session.recentVerificationExpiresAt, undefined);
  const profile = syntheticProfile({
    qualification: {
      type: "university",
      level: "Bachelor",
      title: "Synthetic relevant degree",
      institution: "Synthetic institution",
    },
  });
  denial(
    await post(
      "/staff",
      {
        username: "synthetic.expired.proof",
        roles: ["Clinic Receptionist"],
        profile,
      },
      actor.session.token,
    ),
    "verification_required",
  );
  const started = success(
    await post(
      "/auth/reverify/start",
      { password: actor.person.password },
      actor.session.token,
    ),
  );
  success(
    await post(
      "/auth/reverify/complete",
      {
        challenge: started.challenge,
        code: actor.person.backupCodes[0],
        method: "backup",
      },
      actor.session.token,
    ),
  );
  const current = await fixture.db
    .collection("staff_sessions")
    .findOne({ _id: record._id });
  assert.equal(
    current.lastActivityAt.getTime(),
    record.lastActivityAt.getTime(),
  );
  assert.equal(
    current.absoluteExpiresAt.getTime(),
    record.absoluteExpiresAt.getTime(),
  );
  success(
    await post(
      "/staff",
      {
        username: "synthetic.fresh.proof",
        roles: ["Clinic Receptionist"],
        profile,
      },
      actor.session.token,
    ),
  );
  fixture.advance(5 * 60000);
  denial(
    await fixture.request("/auth/session", { token: actor.session.token }),
    "authentication_failed",
  );
});

test("reverification audit failure rolls back backup consumption/challenge/session proof on real MongoDB", async () => {
  const actor = await manager();
  const started = success(
    await post(
      "/auth/reverify/start",
      { password: actor.person.password },
      actor.session.token,
    ),
  );
  const original = await fixture.db
    .collection("staff_sessions")
    .findOne({ _id: digest(actor.session.token) });
  await fixture.restart({ failAudit: true });
  const body = {
    challenge: started.challenge,
    code: actor.person.backupCodes[0],
    method: "backup",
  };
  const failed = await post(
    "/auth/reverify/complete",
    body,
    actor.session.token,
  );
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "authority_unavailable");
  assert.equal(
    (await fixture.db.collection("accounts").findOne({ _id: actor.person.id }))
      .mfa.backupCodes[0].usedAt,
    null,
  );
  assert.equal(
    (
      await fixture.db
        .collection("auth_challenges")
        .findOne({ _id: digest(started.challenge) })
    ).consumedAt,
    null,
  );
  const after = await fixture.db
    .collection("staff_sessions")
    .findOne({ _id: original._id });
  assert.equal(
    after.passwordVerifiedAt.getTime(),
    original.passwordVerifiedAt.getTime(),
  );
  assert.equal(after.mfaVerifiedAt.getTime(), original.mfaVerifiedAt.getTime());
  await fixture.restart();
  success(await post("/auth/reverify/complete", body, actor.session.token));
});

test("interrupted assigned MFA preserves chosen password and seed through disable/re-enable and restart", async () => {
  const actor = await manager();
  const created = await createEmployee(actor.session, ["Lab Admin"]);
  const input = setupInput(created);
  const claimed = success(await post("/account/setup", input));
  const enrollment = success(
    await post("/mfa/enroll", { challenge: claimed.challenge }),
  );
  const before = await fixture.db
    .collection("accounts")
    .findOne({ _id: created.account.id });
  assert.equal(before.status, "mfa_pending");
  const disabled = success(
    await post(
      staffPath(before._id, "status"),
      { expectedVersion: before.version, enabled: false },
      actor.session.token,
    ),
  );
  denial(
    await post("/auth/login", {
      username: input.username,
      password: input.password,
    }),
    "authentication_failed",
  );
  denial(
    await post("/mfa/complete", {
      challenge: claimed.challenge,
      code: await fixture.totp(enrollment.secret),
    }),
    "authentication_failed",
  );
  const enabled = success(
    await post(
      staffPath(before._id, "status"),
      { expectedVersion: disabled.account.version, enabled: true },
      actor.session.token,
    ),
  );
  assert.equal(enabled.account.status, "mfa_pending");
  denial(
    await post(
      staffPath(before._id, "setup-code"),
      { expectedVersion: enabled.account.version },
      actor.session.token,
    ),
    "setup_not_available",
  );
  await fixture.restart({ reconnect: true });
  const resumed = success(
    await post("/auth/login", {
      username: input.username,
      password: input.password,
    }),
  );
  const seed = success(
    await post("/mfa/enroll", { challenge: resumed.challenge }),
  );
  assert.equal(seed.secret === enrollment.secret, true);
  const pending = await fixture.db
    .collection("accounts")
    .findOne({ _id: before._id });
  assert.equal(pending.passwordHash === before.passwordHash, true);
  assert.deepEqual(
    pending.pendingMfaSecretCipher,
    before.pendingMfaSecretCipher,
  );
  const completed = success(
    await post("/mfa/complete", {
      challenge: resumed.challenge,
      code: await fixture.totp(seed.secret),
    }),
  );
  assert.equal(completed.needsBackupAcknowledgement, true);
  denial(
    await fixture.request("/workspace", { token: completed.token }),
    "backup_acknowledgement_required",
  );
  success(await post("/mfa/acknowledge", {}, completed.token));
  assert.equal(
    (await fixture.request("/workspace", { token: completed.token })).status,
    200,
  );
});

test("role promotion requires MFA and demotion preserves its factor/ack gate without reviving old authorization", async () => {
  const actor = await manager();
  const employee = await fixture.account({ roles: ["Clinic Receptionist"] });
  const original = await signIn(employee);
  const promoted = success(
    await post(
      staffPath(employee.id, "roles"),
      { expectedVersion: 1, roles: ["Clinic Admin"] },
      actor.session.token,
    ),
  );
  assert.equal(promoted.account.status, "mfa_pending");
  denial(
    await fixture.request("/workspace", { token: original.token }),
    "authentication_failed",
  );
  const challenge = success(
    await post("/auth/login", {
      username: employee.username,
      password: employee.password,
    }),
  );
  const seed = success(
    await post("/mfa/enroll", { challenge: challenge.challenge }),
  );
  const completed = success(
    await post("/mfa/complete", {
      challenge: challenge.challenge,
      code: await fixture.totp(seed.secret),
    }),
  );
  const enrolled = await fixture.db
    .collection("accounts")
    .findOne({ _id: employee.id });
  const demoted = success(
    await post(
      staffPath(employee.id, "roles"),
      {
        expectedVersion: promoted.account.version,
        roles: ["Clinic Receptionist"],
      },
      actor.session.token,
    ),
  );
  assert.equal(demoted.account.status, "active");
  denial(
    await fixture.request("/workspace", { token: completed.token }),
    "authentication_failed",
  );
  const reception = await signIn(employee);
  assert.equal(reception.needsBackupAcknowledgement, true);
  denial(
    await fixture.request("/workspace", { token: reception.token }),
    "backup_acknowledgement_required",
  );
  success(await post("/mfa/acknowledge", {}, reception.token));
  assert.equal(
    (await fixture.request("/workspace", { token: reception.token })).status,
    200,
  );
  const retained = await fixture.db
    .collection("accounts")
    .findOne({ _id: employee.id });
  assert.deepEqual(retained.mfa.secretCipher, enrolled.mfa.secretCipher);
  assert.deepEqual(retained.mfa.backupCodes, enrolled.mfa.backupCodes);
  assert.equal(retained.mfa.version, enrolled.mfa.version);
});
