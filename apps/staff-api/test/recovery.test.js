import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, test } from "node:test";
import { createAuthService } from "../src/auth.js";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { startIsolatedApiProcess } from "./helpers/isolated-api-process.js";
import {
  createSecurityFixture,
  syntheticPassword,
} from "./helpers/security-fixture.js";

let fixture,
  service,
  messages = [];
const provider = {
  mode: "test",
  provider: "gmail",
  async configuration() {
    return {
      approvalId: "11111111-1111-1111-1111-111111111111",
      allowance: 20,
    };
  },
  async send(message) {
    messages.push(message);
  },
};
before(async () => {
  fixture = await createSecurityFixture({
    contactDelivery: { email: provider },
  });
});
beforeEach(async () => {
  await fixture.reset();
  messages = [];
  service = createAuthService({
    db: fixture.db,
    client: fixture.client,
    vault: fixture.vault,
    clock: fixture.clock,
    contactDelivery: { email: provider },
  });
});
after(async () => {
  await fixture?.close();
});
afterEach(async () => {
  await service?.recovery.flushDelivery();
});
async function eligible(roles = ["Clinic Receptionist"]) {
  const person = await fixture.account({
    roles,
    mfa: roles.some((role) => role.includes("Admin")),
  });
  const profile = await fixture.db
    .collection("staff_profiles")
    .findOne({ accountId: person.id });
  await fixture.db.collection("staff_profiles").updateOne(
    { _id: profile._id },
    {
      $set: {
        emailVerification: {
          method: "email_code",
          provider: "gmail",
          mode: "test",
          verifiedAt: fixture.clock(),
          valueDigest: fixture.vault.contactDigest(profile.email),
        },
      },
    },
  );
  return person;
}
async function emailProof(person) {
  const request = await service.recovery.request(
    { username: person.username },
    "test-source",
  );
  await service.recovery.flushDelivery();
  const message = messages.at(-1);
  assert.match(message.code, /^\d{8}$/);
  return service.recovery.verify(
    { challenge: request.challenge, code: message.code },
    "test-source",
  );
}
for (const roles of [
  ["Admin"],
  ["System Admin"],
  ["Clinic Admin"],
  ["Lab Admin"],
  ["Clinic Receptionist"],
  ["Lab Receptionist"],
  ["Admin", "Lab Receptionist"],
]) {
  test(`email recovery preserves profile and uses role MFA: ${roles}`, async () => {
    const person = await eligible(roles);
    const beforeProfile = await fixture.db
      .collection("staff_profiles")
      .findOne({ accountId: person.id });
    let proof = await emailProof(person);
    if (person.secret) {
      assert.equal(proof.kind, "recovery_mfa");
      proof = {
        ...proof,
        ...(await service.recovery.factor(
          {
            challenge: proof.challenge,
            method: "backup",
            code: person.backupCodes[0],
          },
          "test-source",
        )),
      };
    }
    const password = syntheticPassword();
    assert.equal(
      (
        await service.recovery.complete({
          challenge: proof.challenge,
          newPassword: password,
          confirmation: password,
        })
      ).completed,
      true,
    );
    assert.deepEqual(
      await fixture.db
        .collection("staff_profiles")
        .findOne({ accountId: person.id }),
      beforeProfile,
    );
    assert.equal(
      await fixture.db
        .collection("staff_password_history")
        .countDocuments({ accountId: person.id }),
      1,
    );
    await assert.rejects(
      service.recovery.complete({
        challenge: proof.challenge,
        newPassword: syntheticPassword(),
        confirmation: "mismatch",
      }),
    );
  });
}
test("unknown and unverified accounts receive identical response shape and no mail", async () => {
  const person = await fixture.account();
  const known = await service.recovery.request(
    { username: person.username },
    "source",
  );
  const unknown = await service.recovery.request(
    { username: "unknown.staff" },
    "source",
  );
  assert.deepEqual(Object.keys(known), Object.keys(unknown));
  assert.equal(known.message, unknown.message);
  await service.recovery.flushDelivery();
  assert.equal(messages.length, 0);
});

async function login(person) {
  const signed = await service.login(
    { username: person.username, password: person.password },
    "test-source",
  );
  if (!person.secret) return signed.token;
  const completed = await service.completeMfa(
    { challenge: signed.challenge, code: await fixture.totp(person.secret) },
    "test-source",
  );
  return completed.token;
}
async function assist(actor, target, scope) {
  const bearer = await login(actor);
  const account = await fixture.db
    .collection("accounts")
    .findOne({ _id: target.id });
  return service.recovery.assist(bearer, target.id, {
    scope,
    version: account.version,
    identityConfirmed: true,
    confirmed: true,
    purpose: "Synthetic in-person review",
  });
}
function pauseWork(stage = "hash") {
  let release, entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  service = createAuthService({
    db: fixture.db,
    client: fixture.client,
    vault: fixture.vault,
    clock: fixture.clock,
    contactDelivery: { email: provider },
    testPasswordWork: async ({ stage: current }) => {
      if (current === stage) {
        entered();
        await waiting;
      }
    },
  });
  return { reached, release };
}
test("MFA-only handoff uses bounded work outside transactions and rechecks revocation", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  const target = await eligible(["Lab Admin"]);
  const issued = await assist(actor, target, "mfa");
  const paused = pauseWork("identity");
  const pending = service.recovery.redeem(
    {
      username: target.username,
      handoff: issued.handoff,
      password: target.password,
    },
    "source",
  );
  const reached = await Promise.race([
    paused.reached.then(() => true),
    pending.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);
  if (!reached) {
    paused.release();
    await pending;
  }
  assert.equal(
    reached,
    true,
    "Password verification must use the bounded outside-transaction seam",
  );
  await fixture.db
    .collection("staff_recovery_requests")
    .updateOne(
      { kind: "assisted", accountId: target.id },
      { $set: { revokedAt: fixture.clock() } },
    );
  paused.release();
  await assert.rejects(pending);
  const stored = await fixture.db
    .collection("accounts")
    .findOne({ _id: target.id });
  assert.equal(stored.recoveryCaseId, undefined);
  assert.equal(stored.mfa.enabled, true);
});
for (const action of ["cancel", "disable", "version", "release", "expire"]) {
  test(`paused recovery hashing rejects ${action} without installing a password`, async () => {
    const target = await eligible();
    const proof = await emailProof(target);
    const original = await fixture.db
      .collection("accounts")
      .findOne({ _id: target.id });
    const pause = pauseWork();
    const password = syntheticPassword();
    const pending = service.recovery.complete({
      challenge: proof.challenge,
      newPassword: password,
      confirmation: password,
    });
    await pause.reached;
    if (action === "cancel")
      await service.recovery.cancel({ challenge: proof.challenge });
    if (action === "disable")
      await fixture.db
        .collection("accounts")
        .updateOne({ _id: target.id }, { $set: { status: "disabled" } });
    if (action === "version")
      await fixture.db
        .collection("accounts")
        .updateOne({ _id: target.id }, { $inc: { version: 1 } });
    if (action === "release")
      await fixture.db
        .collection("staff_profiles")
        .updateOne(
          { accountId: target.id },
          { $set: { "emailVerification.releasedAt": fixture.clock() } },
        );
    if (action === "expire") fixture.advance(300001);
    pause.release();
    await assert.rejects(pending);
    assert.equal(
      (await fixture.db.collection("accounts").findOne({ _id: target.id }))
        .passwordHash,
      original.passwordHash,
    );
    assert.equal(
      await fixture.db.collection("staff_password_history").countDocuments(),
      0,
    );
  });
}
test("assistance is bound to the authorizing Admin's current role/version", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  const target = await eligible();
  const issued = await assist(actor, target, "password");
  await fixture.db
    .collection("accounts")
    .updateOne(
      { _id: actor.id },
      { $set: { roles: ["System Admin"] }, $inc: { version: 1 } },
    );
  await assert.rejects(
    service.recovery.redeem(
      { username: target.username, handoff: issued.handoff },
      "source",
    ),
  );
});
test("email proof survives only in guarded TEST state across separate API processes", async () => {
  const target = await eligible();
  const proof = await emailProof(target);
  const first = await startIsolatedApiProcess();
  try {
    assert.equal(
      (
        await first.request("/recovery/status", {
          body: { challenge: proof.challenge },
        })
      ).status,
      200,
    );
  } finally {
    await first.stop();
  }
  const second = await startIsolatedApiProcess();
  const password = syntheticPassword();
  try {
    assert.equal(
      (
        await second.request("/recovery/complete", {
          body: {
            challenge: proof.challenge,
            newPassword: password,
            confirmation: password,
          },
        })
      ).body.completed,
      true,
    );
    assert.notEqual(
      (
        await second.request("/recovery/status", {
          body: { challenge: proof.challenge },
        })
      ).status,
      200,
    );
  } finally {
    await second.stop();
  }
  const stored = await fixture.db
    .collection("accounts")
    .findOne({ _id: target.id });
  assert.equal(await argon2.verify(stored.passwordHash, password), true);
});
test("recovery audit failure rolls back password, history and session revocation", async () => {
  const target = await eligible();
  const bearer = await login(target);
  const proof = await emailProof(target);
  const original = await fixture.db
    .collection("accounts")
    .findOne({ _id: target.id });
  await fixture.restart({ failAudit: true });
  const password = syntheticPassword();
  const result = await fixture.request("/recovery/complete", {
    method: "POST",
    body: {
      challenge: proof.challenge,
      newPassword: password,
      confirmation: password,
    },
  });
  assert.equal(result.status, 503);
  assert.equal(
    (await fixture.db.collection("accounts").findOne({ _id: target.id }))
      .passwordHash,
    original.passwordHash,
  );
  assert.equal(
    await fixture.db.collection("staff_password_history").countDocuments(),
    0,
  );
  assert.equal((await service.readSession(bearer)).user.id, target.id);
});
test("System Admin alone and self-assistance are denied without superseding authority", async () => {
  const actor = await fixture.account({ roles: ["System Admin"], mfa: true });
  const target = await eligible();
  await assert.rejects(assist(actor, target, "password"), {
    code: "recovery_forbidden",
  });
  const admin = await fixture.account({ roles: ["Admin"], mfa: true });
  await assert.rejects(assist(admin, admin, "both"), {
    code: "recovery_target",
  });
  assert.equal(
    await fixture.db.collection("staff_recovery_requests").countDocuments(),
    0,
  );
});
test("assisted password-only does not bypass target administrative MFA", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  const target = await eligible(["Lab Admin"]);
  const issued = await assist(actor, target, "password");
  const grant = await service.recovery.redeem(
    { username: target.username, handoff: issued.handoff },
    "source",
  );
  assert.equal(grant.kind, "recovery_mfa");
  const password = syntheticPassword();
  await assert.rejects(
    service.recovery.complete({
      challenge: grant.challenge,
      newPassword: password,
      confirmation: password,
    }),
  );
  await service.recovery.factor(
    {
      challenge: grant.challenge,
      method: "backup",
      code: target.backupCodes[0],
    },
    "source",
  );
  assert.equal(
    (
      await service.recovery.complete({
        challenge: grant.challenge,
        newPassword: password,
        confirmation: password,
      })
    ).completed,
    true,
  );
});
test("combined recovery replaces old factors with no workspace; stable seed and acknowledged backups", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  const target = await eligible(["Admin"]);
  const issued = await assist(actor, target, "both");
  const grant = await service.recovery.redeem(
    { username: target.username, handoff: issued.handoff },
    "source",
  );
  const password = syntheticPassword();
  const enrollment = await service.recovery.complete({
    challenge: grant.challenge,
    newPassword: password,
    confirmation: password,
  });
  assert.equal(enrollment.kind, "recovery_enroll");
  const first = await service.recovery.enrollment({
    challenge: enrollment.challenge,
  });
  assert.equal(
    (await service.recovery.enrollment({ challenge: enrollment.challenge }))
      .secret,
    first.secret,
  );
  await assert.rejects(
    service.login({ username: target.username, password }, "source"),
  );
  const backups = await service.recovery.enroll(
    { challenge: enrollment.challenge, code: await fixture.totp(first.secret) },
    "source",
  );
  assert.equal(backups.backupCodes.length, 10);
  await assert.rejects(
    service.login({ username: target.username, password }, "source"),
  );
  await service.recovery.acknowledge({
    challenge: enrollment.challenge,
    confirmed: true,
  });
  const next = await fixture.db
    .collection("accounts")
    .findOne({ _id: target.id });
  assert.equal(next.recoveryCaseId, undefined);
  assert.equal(next.mfa.backupAcknowledged, true);
  assert.notDeepEqual(
    next.mfa.backupCodes.map((item) => item.digest),
    target.backupCodes,
  );
});
test("self replacement requires password AND factor; cancellation before redemption preserves old MFA", async () => {
  const target = await eligible(["Clinic Admin"]);
  const before = await fixture.db
    .collection("accounts")
    .findOne({ _id: target.id });
  const proof = await service.recovery.provePassword(
    {
      username: target.username,
      password: target.password,
      method: "backup",
      code: target.backupCodes[0],
    },
    "source",
  );
  await service.recovery.cancel({ challenge: proof.challenge });
  const after = await fixture.db
    .collection("accounts")
    .findOne({ _id: target.id });
  assert.deepEqual(after.mfa.secretCipher, before.mfa.secretCipher);
  assert.equal(
    after.mfa.backupCodes[0].usedAt.getTime(),
    fixture.clock().getTime(),
  );
  await assert.rejects(
    service.recovery.replace({ challenge: proof.challenge, confirmed: true }),
  );
});
test("recovery code replay, five failures, original resend expiry and cancellation keep passwords unchanged", async () => {
  const target = await eligible();
  const started = await service.recovery.request(
    { username: target.username },
    "source",
  );
  await service.recovery.flushDelivery();
  const first = messages[0].code;
  fixture.advance(60000);
  await service.recovery.resend({ challenge: started.challenge }, "source");
  await service.recovery.flushDelivery();
  assert.equal(
    messages[1].expiresAt.getTime(),
    messages[0].expiresAt.getTime(),
  );
  await assert.rejects(
    service.recovery.verify(
      { challenge: started.challenge, code: first },
      "source",
    ),
  );
  for (let attempt = 0; attempt < 4; attempt++)
    await assert.rejects(
      service.recovery.verify(
        { challenge: started.challenge, code: "invalid" },
        "source",
      ),
    );
  await assert.rejects(
    service.recovery.verify(
      { challenge: started.challenge, code: messages[1].code },
      "source",
    ),
    { code: "recovery_failed" },
  );
  assert.equal(
    (await fixture.db.collection("accounts").findOne({ _id: target.id }))
      .version,
    1,
  );
});
test("current and historical passwords are refused and shared allowance is preserved", async () => {
  const target = await eligible();
  const grant = await emailProof(target);
  await assert.rejects(
    service.recovery.complete({
      challenge: grant.challenge,
      newPassword: target.password,
      confirmation: target.password,
    }),
    { code: "password_reused" },
  );
  assert.equal(
    (
      await fixture.db
        .collection("password_change_counters")
        .findOne({ _id: target.id })
    ).historyAttempts,
    1,
  );
  const stored = await fixture.db
    .collection("accounts")
    .findOne({ _id: target.id });
  await fixture.db.collection("staff_password_history").insertOne({
    accountId: target.id,
    credentialVersion: 0,
    hashCipher: fixture.vault.encrypt(stored.passwordHash),
    retiredAt: new Date("1990-01-01"),
  });
  await assert.rejects(
    service.recovery.complete({
      challenge: grant.challenge,
      newPassword: target.password,
      confirmation: target.password,
    }),
    { code: "password_reused" },
  );
});
test("concurrent code and grant redemption have one winner", async () => {
  const target = await eligible();
  const request = await service.recovery.request(
    { username: target.username },
    "source",
  );
  await service.recovery.flushDelivery();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      service.recovery.verify(
        { challenge: request.challenge, code: messages[0].code },
        "source",
      ),
    ),
  );
  assert.equal(
    outcomes.filter((item) => item.status === "fulfilled").length,
    1,
  );
  const proof = outcomes.find((item) => item.status === "fulfilled").value;
  const password = syntheticPassword();
  const saves = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      service.recovery.complete({
        challenge: proof.challenge,
        newPassword: password,
        confirmation: password,
      }),
    ),
  );
  assert.equal(saves.filter((item) => item.status === "fulfilled").length, 1);
});
test("email release, status/version changes and expiry invalidate pending recovery", async () => {
  const target = await eligible();
  const proof = await emailProof(target);
  await fixture.db
    .collection("staff_profiles")
    .updateOne(
      { accountId: target.id },
      { $set: { "emailVerification.releasedAt": fixture.clock() } },
    );
  await assert.rejects(service.recovery.status({ challenge: proof.challenge }));
  assert.equal(
    (await fixture.db.collection("accounts").findOne({ _id: target.id }))
      .version,
    1,
  );
});
test("emergency key is verifier-only, acknowledged, one-use and installation bound", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  await fixture.db.collection("installation_state").insertOne({
    _id: "first-admin",
    status: "completed",
    firstAccountId: actor.id,
  });
  const bearer = await login(actor);
  const custody = await service.emergency.prepare(bearer, {
    confirmedCEO: true,
  });
  const staged = await fixture.db
    .collection("staff_emergency_state")
    .findOne({ _id: "installation" });
  assert.equal(JSON.stringify(staged).includes(custody.secret), false);
  assert.equal(JSON.stringify(staged).includes(custody.proof), false);
  await service.emergency.acknowledge(bearer, {
    proof: custody.proof,
    custodyConfirmed: true,
  });
  const { randomBytes } = await import("node:crypto");
  const resumeSecret = randomBytes(32).toString("base64url");
  const input = {
    secret: custody.secret,
    username: actor.username,
    scope: "both",
    emergencyAcknowledged: true,
    resumeSecret,
    resumeCustodyConfirmed: true,
  };
  const results = await Promise.allSettled([
    service.emergency.redeem(input),
    service.emergency.redeem(input),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const resumed = await service.emergency.resume({
    resumeSecret,
    emergencyAcknowledged: true,
  });
  assert.equal(typeof resumed.handoff, "string");
  await assert.rejects(service.emergency.redeem(input));
  const events = await fixture.db
    .collection("security_events")
    .find()
    .toArray();
  assert.equal(JSON.stringify(events).includes(custody.secret), false);
  assert.equal(JSON.stringify(events).includes(resumeSecret), false);
});
async function custody(actor) {
  await fixture.db.collection("installation_state").insertOne({
    _id: "first-admin",
    status: "completed",
    firstAccountId: actor.id,
  });
  const bearer = await login(actor);
  const key = await service.emergency.prepare(bearer, { confirmedCEO: true });
  await service.emergency.acknowledge(bearer, {
    proof: key.proof,
    custodyConfirmed: true,
  });
  return { ...key, bearer };
}
test("provision cannot silently rotate an acknowledged emergency key", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  const key = await custody(actor);
  const before = await fixture.db
    .collection("staff_emergency_state")
    .findOne({ _id: "installation" });
  await assert.rejects(
    service.emergency.prepare(key.bearer, { confirmedCEO: true }),
  );
  assert.deepEqual(
    await fixture.db
      .collection("staff_emergency_state")
      .findOne({ _id: "installation" }),
    before,
  );
});
test("emergency combined recovery resumes stable enrollment after grant expiry and completes without old factors", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  const key = await custody(actor),
    resumeSecret = randomBytes(32).toString("base64url");
  const original = await fixture.db
    .collection("accounts")
    .findOne({ _id: actor.id });
  const issued = await service.emergency.redeem({
    secret: key.secret,
    username: actor.username,
    scope: "both",
    emergencyAcknowledged: true,
    resumeSecret,
    resumeCustodyConfirmed: true,
  });
  const proof = await service.recovery.redeem(
    { username: actor.username, handoff: issued.handoff },
    "source",
  );
  const password = syntheticPassword();
  const enrollment = await service.recovery.complete({
    challenge: proof.challenge,
    newPassword: password,
    confirmation: password,
  });
  const initial = await service.recovery.enrollment({
    challenge: enrollment.challenge,
  });
  fixture.advance(600001);
  await assert.rejects(
    service.recovery.enrollment({ challenge: enrollment.challenge }),
  );
  const resumed = await service.emergency.resume({
    resumeSecret,
    emergencyAcknowledged: true,
  });
  const renewed = await service.recovery.redeem(
    { username: actor.username, handoff: resumed.handoff },
    "source",
  );
  assert.equal(
    (await service.recovery.enrollment({ challenge: renewed.challenge }))
      .secret,
    initial.secret,
  );
  const backups = await service.recovery.enroll(
    { challenge: renewed.challenge, code: await fixture.totp(initial.secret) },
    "source",
  );
  await service.recovery.acknowledge({
    challenge: renewed.challenge,
    confirmed: true,
  });
  const stored = await fixture.db
    .collection("accounts")
    .findOne({ _id: actor.id });
  assert.equal(await argon2.verify(stored.passwordHash, password), true);
  assert.notEqual(stored.mfa.secretCipher, original.mfa.secretCipher);
  assert.equal(stored.mfa.backupAcknowledged, true);
  assert.equal(stored.recoveryCaseId, undefined);
  assert.equal(backups.backupCodes.length, 10);
  await assert.rejects(
    service.emergency.resume({ resumeSecret, emergencyAcknowledged: true }),
  );
});
test("emergency rotation/revocation and wrong-key counters persist without a bootstrap bypass", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  const key = await custody(actor),
    resumeSecret = randomBytes(32).toString("base64url");
  const replacement = await service.emergency.prepare(key.bearer, {
    confirmedCEO: true,
    replace: true,
  });
  await service.emergency.acknowledge(key.bearer, {
    proof: replacement.proof,
    custodyConfirmed: true,
  });
  const input = {
    username: actor.username,
    scope: "both",
    emergencyAcknowledged: true,
    resumeSecret,
    resumeCustodyConfirmed: true,
  };
  await assert.rejects(
    service.emergency.redeem({ ...input, secret: key.secret }),
  );
  await service.emergency.revoke(key.bearer, { confirmed: true });
  for (let attempt = 0; attempt < 4; attempt++)
    await assert.rejects(
      service.emergency.redeem({ ...input, secret: replacement.secret }),
    );
  const recreated = createAuthService({
    db: fixture.db,
    client: fixture.client,
    vault: fixture.vault,
    clock: fixture.clock,
  });
  await assert.rejects(
    recreated.emergency.redeem({ ...input, secret: replacement.secret }),
    { code: "recovery_cooldown" },
  );
  assert.equal(
    (
      await fixture.db
        .collection("installation_state")
        .findOne({ _id: "first-admin" })
    ).status,
    "completed",
  );
});
test("emergency targeting rejects receptionist, disabled, pending and System Admin-only accounts", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  const key = await custody(actor);
  for (const options of [
    { roles: ["Clinic Receptionist"] },
    { roles: ["System Admin"], mfa: true },
    { roles: ["Admin"], mfa: true, status: "disabled" },
    { roles: ["Admin"], mfa: true, backupAcknowledged: false },
  ]) {
    const target = await fixture.account(options);
    await assert.rejects(
      service.emergency.redeem({
        secret: key.secret,
        username: target.username,
        scope: "both",
        emergencyAcknowledged: true,
        resumeSecret: randomBytes(32).toString("base64url"),
        resumeCustodyConfirmed: true,
      }),
    );
  }
  assert.equal(
    (
      await fixture.db
        .collection("staff_emergency_state")
        .findOne({ _id: "installation" })
    ).current.consumedAt,
    null,
  );
});
test("very old distinct history is checked without age or count truncation", async () => {
  const target = await eligible(),
    old = syntheticPassword();
  const hash = await argon2.hash(old, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await fixture.db.collection("staff_password_history").insertOne({
    accountId: target.id,
    credentialVersion: -900,
    hashCipher: fixture.vault.encrypt(hash),
    retiredAt: new Date("1990-01-01"),
  });
  const proof = await emailProof(target);
  await assert.rejects(
    service.recovery.complete({
      challenge: proof.challenge,
      newPassword: old,
      confirmation: old,
    }),
    { code: "password_reused" },
  );
});
test("recovery source cooldown leaves ordinary sessions and other-source recovery unaffected", async () => {
  const target = await eligible(),
    bearer = await login(target);
  for (let i = 0; i < 30; i++)
    await service.recovery.request(
      { username: "unknown.staff" },
      "shared-source",
    );
  const blocked = await service.recovery.request(
    { username: target.username },
    "shared-source",
  );
  await service.recovery.flushDelivery();
  assert.equal(messages.length, 0);
  assert.equal((await service.readSession(bearer)).user.id, target.id);
  const allowed = await service.recovery.request(
    { username: target.username },
    "other-source",
  );
  await service.recovery.flushDelivery();
  assert.equal(messages.length, 1);
  assert.deepEqual(Object.keys(allowed), Object.keys(blocked));
});
test("email status/resend/cancel replies do not expose which username was eligible", async () => {
  const target = await eligible();
  const yes = await service.recovery.request(
    { username: target.username },
    "source",
  );
  const no = await service.recovery.request(
    { username: "unknown.staff" },
    "source",
  );
  await service.recovery.flushDelivery();
  for (const action of ["status", "resend", "cancel"])
    assert.deepEqual(
      await service.recovery[action]({ challenge: yes.challenge }, "source"),
      await service.recovery[action]({ challenge: no.challenge }, "source"),
    );
});
test("Admin can revoke assistance without destroying unrelated email authority or resetting counters", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true }),
    target = await eligible();
  const email = await emailProof(target),
    issued = await assist(actor, target, "password");
  fixture.advance(30000);
  const bearer = await login(actor);
  await service.recovery.revokeAssistance(bearer, target.id, {
    version: 1,
    confirmed: true,
  });
  await assert.rejects(
    service.recovery.redeem(
      { username: target.username, handoff: issued.handoff },
      "source",
    ),
  );
  assert.equal(
    (await service.recovery.status({ challenge: email.challenge })).kind,
    "recovery_ready",
  );
  assert.equal(
    await fixture.db
      .collection("security_events")
      .countDocuments({ action: "recovery_assisted_revoked" }),
    1,
  );
});
test("busy refusal does not spend a second history check; quota exhaustion remains distinct", async () => {
  const target = await eligible(),
    proof = await emailProof(target),
    pause = pauseWork();
  const password = syntheticPassword(),
    pending = service.recovery.complete({
      challenge: proof.challenge,
      newPassword: password,
      confirmation: password,
    });
  await pause.reached;
  await assert.rejects(
    service.recovery.complete({
      challenge: proof.challenge,
      newPassword: password,
      confirmation: password,
    }),
    { code: "password_change_busy" },
  );
  assert.equal(
    (
      await fixture.db
        .collection("password_change_counters")
        .findOne({ _id: target.id })
    ).historyAttempts,
    1,
  );
  pause.release();
  await pending;
  const newProof = await emailProof(target);
  for (let i = 0; i < 4; i++)
    await assert.rejects(
      service.recovery.complete({
        challenge: newProof.challenge,
        newPassword: password,
        confirmation: password,
      }),
      { code: "password_reused" },
    );
  await assert.rejects(
    service.recovery.complete({
      challenge: newProof.challenge,
      newPassword: password,
      confirmation: password,
    }),
    { code: "recovery_allowance" },
  );
});
test("recovery shares account/destination send ceilings and concurrent monthly budget admission", async () => {
  const target = await eligible();
  for (let i = 0; i < 4; i++) {
    await service.recovery.request(
      { username: target.username },
      `source-${i}`,
    );
    await service.recovery.flushDelivery();
  }
  assert.equal(messages.length, 3);
  assert.equal(
    await fixture.db
      .collection("staff_recovery_requests")
      .countDocuments({ kind: "email" }),
    3,
  );
  const budget = await fixture.db
    .collection("contact_delivery_budgets")
    .findOne();
  assert.ok(budget);
  await fixture.db
    .collection("contact_delivery_budgets")
    .updateMany({}, { $set: { attempts: 19 } });
  const first = await eligible(),
    second = await eligible();
  await Promise.all([
    service.recovery.request({ username: first.username }, "quota-a"),
    service.recovery.request({ username: second.username }, "quota-b"),
  ]);
  await service.recovery.flushDelivery();
  assert.equal(messages.length, 4);
  const budgets = await fixture.db
    .collection("contact_delivery_budgets")
    .find()
    .toArray();
  assert.equal(budgets.length, 2);
  assert.ok(budgets.every((item) => item.attempts === 20));
});
test("provider failure never changes credentials or creates verified recovery authority", async () => {
  const target = await eligible(),
    original = await fixture.db
      .collection("accounts")
      .findOne({ _id: target.id });
  service = createAuthService({
    db: fixture.db,
    client: fixture.client,
    vault: fixture.vault,
    clock: fixture.clock,
    contactDelivery: {
      email: {
        ...provider,
        async send() {
          throw Error("Synthetic provider failure");
        },
      },
    },
  });
  const request = await service.recovery.request(
    { username: target.username },
    "source",
  );
  await service.recovery.flushDelivery();
  await assert.rejects(
    service.recovery.verify(
      { challenge: request.challenge, code: "00123456" },
      "source",
    ),
  );
  assert.deepEqual(
    await fixture.db.collection("accounts").findOne({ _id: target.id }),
    original,
  );
  assert.equal(
    (
      await fixture.db
        .collection("staff_recovery_requests")
        .findOne({ kind: "email" })
    ).dispatch,
    "failed",
  );
  const budgets = await fixture.db
    .collection("contact_delivery_budgets")
    .find()
    .toArray();
  assert.equal(budgets.length, 2); // Existing monthly and approved-allowance records.
  assert.ok(budgets.every((item) => item.attempts === 1));
});
test("interrupted replacement backup acknowledgement resumes with new password/factor, never old factors", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true }),
    target = await eligible(["Lab Admin"]);
  const issued = await assist(actor, target, "both");
  const proof = await service.recovery.redeem(
    { username: target.username, handoff: issued.handoff },
    "source",
  );
  const password = syntheticPassword(),
    enrollment = await service.recovery.complete({
      challenge: proof.challenge,
      newPassword: password,
      confirmation: password,
    });
  const seed = await service.recovery.enrollment({
    challenge: enrollment.challenge,
  });
  const backups = await service.recovery.enroll(
    { challenge: enrollment.challenge, code: await fixture.totp(seed.secret) },
    "source",
  );
  await service.recovery.cancel({ challenge: enrollment.challenge });
  fixture.advance(30000);
  const resumed = await service.recovery.provePassword(
    {
      username: target.username,
      password,
      method: "totp",
      code: await fixture.totp(seed.secret),
      resume: true,
    },
    "source",
  );
  assert.equal(resumed.kind, "recovery_backups");
  assert.deepEqual(
    (await service.recovery.backups({ challenge: resumed.challenge }))
      .backupCodes,
    backups.backupCodes,
  );
  await service.recovery.acknowledge({
    challenge: resumed.challenge,
    confirmed: true,
  });
  assert.equal(
    (await fixture.db.collection("accounts").findOne({ _id: target.id })).mfa
      .backupAcknowledged,
    true,
  );
});
test("a separate API process cannot bypass the account work lease or spend busy history allowance", async () => {
  const target = await eligible(),
    proof = await emailProof(target),
    pause = pauseWork();
  const password = syntheticPassword(),
    pending = service.recovery.complete({
      challenge: proof.challenge,
      newPassword: password,
      confirmation: password,
    });
  await pause.reached;
  const process = await startIsolatedApiProcess();
  try {
    const result = await process.request("/recovery/complete", {
      body: {
        challenge: proof.challenge,
        newPassword: password,
        confirmation: password,
      },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "recovery_busy");
    assert.equal(
      (
        await fixture.db
          .collection("password_change_counters")
          .findOne({ _id: target.id })
      ).historyAttempts,
      1,
    );
  } finally {
    await process.stop();
    pause.release();
  }
  assert.equal((await pending).completed, true);
});
test("new combined assistance can replace a lost interrupted password without regenerating its pending factor", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true }),
    target = await eligible(["Lab Admin"]);
  const first = await assist(actor, target, "both");
  const proof = await service.recovery.redeem(
    { username: target.username, handoff: first.handoff },
    "source",
  );
  const password = syntheticPassword(),
    enrollment = await service.recovery.complete({
      challenge: proof.challenge,
      newPassword: password,
      confirmation: password,
    });
  const seed = await service.recovery.enrollment({
    challenge: enrollment.challenge,
  });
  await service.recovery.cancel({ challenge: enrollment.challenge });
  fixture.advance(30000);
  const replacement = await assist(actor, target, "both");
  const fresh = await service.recovery.redeem(
    { username: target.username, handoff: replacement.handoff },
    "source",
  );
  assert.equal(fresh.kind, "recovery_ready");
  assert.equal(
    Date.parse(fresh.expiresAt) - Date.parse(fresh.serverNow),
    300000,
  );
  const next = syntheticPassword(),
    resumed = await service.recovery.complete({
      challenge: fresh.challenge,
      newPassword: next,
      confirmation: next,
    });
  assert.equal(
    (await service.recovery.enrollment({ challenge: resumed.challenge }))
      .secret,
    seed.secret,
  );
  assert.equal(
    await argon2.verify(
      (await fixture.db.collection("accounts").findOne({ _id: target.id }))
        .passwordHash,
      next,
    ),
    true,
  );
});
test("ineligible saved contacts/accounts stay indistinguishable and never reserve delivery", async () => {
  for (const reason of [
    "disabled",
    "pending",
    "unverified",
    "released",
    "legacy",
    "contested",
  ]) {
    const person = await eligible();
    if (reason === "disabled" || reason === "pending")
      await fixture.db.collection("accounts").updateOne(
        { _id: person.id },
        {
          $set: {
            status: reason === "pending" ? "setup_pending" : "disabled",
          },
        },
      );
    if (reason === "unverified" || reason === "legacy")
      await fixture.db
        .collection("staff_profiles")
        .updateOne(
          { accountId: person.id },
          { $unset: { emailVerification: "" }, $set: { emailVerified: true } },
        );
    if (reason === "released")
      await fixture.db
        .collection("staff_profiles")
        .updateOne(
          { accountId: person.id },
          { $set: { "emailVerification.releasedAt": fixture.clock() } },
        );
    if (reason === "contested") {
      const other = await eligible();
      const profile = await fixture.db
        .collection("staff_profiles")
        .findOne({ accountId: person.id });
      await fixture.db.collection("staff_profiles").updateOne(
        { accountId: other.id },
        {
          $set: {
            email: profile.email,
            emailVerification: profile.emailVerification,
          },
        },
      );
    }
    const reply = await service.recovery.request(
      { username: person.username },
      reason,
    );
    const unknown = await service.recovery.request(
      { username: "unknown.staff" },
      reason,
    );
    assert.deepEqual(Object.keys(reply), Object.keys(unknown));
    assert.equal(reply.message, unknown.message);
  }
  await service.recovery.flushDelivery();
  assert.equal(messages.length, 0);
  assert.equal(
    await fixture.db.collection("contact_delivery_budgets").countDocuments(),
    0,
  );
});
test("concurrent recovery MFA consumes only one backup and rejects missing/invalid proof", async () => {
  const target = await eligible(["Admin", "Clinic Receptionist"]),
    proof = await emailProof(target);
  await assert.rejects(
    service.recovery.factor(
      { challenge: proof.challenge, method: "backup", code: "bad" },
      "source",
    ),
  );
  const result = await Promise.allSettled(
    [0, 1].map(() =>
      service.recovery.factor(
        {
          challenge: proof.challenge,
          method: "backup",
          code: target.backupCodes[0],
        },
        "source",
      ),
    ),
  );
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    (
      await fixture.db.collection("accounts").findOne({ _id: target.id })
    ).mfa.backupCodes.filter((item) => item.usedAt).length,
    1,
  );
});
test("emergency key consumption rolls back on audit failure and resumes after a separate process restart", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true }),
    key = await custody(actor),
    resumeSecret = randomBytes(32).toString("base64url");
  const original = await fixture.db
    .collection("staff_emergency_state")
    .findOne({ _id: "installation" });
  const failingDb = {
    databaseName: fixture.db.databaseName,
    collection(name) {
      if (name !== "security_events") return fixture.db.collection(name);
      return {
        insertOne: async () => {
          throw Error("Synthetic rollback failure");
        },
      };
    },
  };
  const failing = createAuthService({
    db: failingDb,
    client: fixture.client,
    vault: fixture.vault,
    clock: fixture.clock,
  });
  const input = {
    secret: key.secret,
    username: actor.username,
    scope: "both",
    resumeSecret,
    emergencyAcknowledged: true,
    resumeCustodyConfirmed: true,
  };
  await assert.rejects(failing.emergency.redeem(input));
  assert.deepEqual(
    await fixture.db
      .collection("staff_emergency_state")
      .findOne({ _id: "installation" }),
    original,
  );
  const issued = await service.emergency.redeem(input);
  const first = await startIsolatedApiProcess();
  try {
    assert.equal(
      (
        await first.request("/recovery/redeem", {
          body: { username: actor.username, handoff: issued.handoff },
        })
      ).status,
      200,
    );
  } finally {
    await first.stop();
  }
  const resumed = await service.emergency.resume({
    resumeSecret,
    emergencyAcknowledged: true,
  });
  const second = await startIsolatedApiProcess();
  try {
    const stale = await second.request("/recovery/redeem", {
      body: { username: actor.username, handoff: issued.handoff },
    });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error.code, "recovery_failed");
    assert.equal(
      (
        await second.request("/recovery/redeem", {
          body: { username: actor.username, handoff: resumed.handoff },
        })
      ).status,
      200,
    );
  } finally {
    await second.stop();
  }
});
test("expiry of an unacknowledged rotation leaves the existing emergency verifier unchanged", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true }),
    key = await custody(actor);
  const current = (
    await fixture.db
      .collection("staff_emergency_state")
      .findOne({ _id: "installation" })
  ).current;
  const candidate = await service.emergency.prepare(key.bearer, {
    confirmedCEO: true,
    replace: true,
  });
  fixture.advance(60001);
  await assert.rejects(
    service.emergency.acknowledge(key.bearer, {
      proof: candidate.proof,
      custodyConfirmed: true,
    }),
  );
  assert.deepEqual(
    (
      await fixture.db
        .collection("staff_emergency_state")
        .findOne({ _id: "installation" })
    ).current,
    current,
  );
});

test("assisted recovery requests the existing fresh-verification dialog after five minutes", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  const target = await eligible();
  const bearer = await login(actor);
  fixture.advance(300001);
  await assert.rejects(
    service.recovery.assist(bearer, target.id, {
      version: 1,
      scope: "password",
      identityConfirmed: true,
      confirmed: true,
      purpose: "Synthetic identity check",
    }),
    { code: "verification_required" },
  );
  assert.equal(
    await fixture.db.collection("staff_recovery_requests").countDocuments(),
    0,
  );
});

test("emergency password recovery of interrupted MFA preserves resumption until backup acknowledgement", async () => {
  const actor = await fixture.account({ roles: ["Admin"], mfa: true });
  const target = await eligible(["Admin"]);
  const assisted = await assist(actor, target, "both");
  const initial = await service.recovery.redeem(
    { username: target.username, handoff: assisted.handoff },
    "source",
  );
  const firstPassword = syntheticPassword();
  const enrollment = await service.recovery.complete({
    challenge: initial.challenge,
    newPassword: firstPassword,
    confirmation: firstPassword,
  });
  const seed = await service.recovery.enrollment({
    challenge: enrollment.challenge,
  });
  await service.recovery.enroll(
    { challenge: enrollment.challenge, code: await fixture.totp(seed.secret) },
    "source",
  );
  fixture.advance(30000);
  const key = await custody(actor),
    resumeSecret = randomBytes(32).toString("base64url");
  const handoff = await service.emergency.redeem({
    secret: key.secret,
    username: target.username,
    scope: "password",
    resumeSecret,
    emergencyAcknowledged: true,
    resumeCustodyConfirmed: true,
  });
  const proof = await service.recovery.redeem(
    { username: target.username, handoff: handoff.handoff },
    "source",
  );
  fixture.advance(30000);
  await service.recovery.factor(
    {
      challenge: proof.challenge,
      method: "totp",
      code: await fixture.totp(seed.secret),
    },
    "source",
  );
  const nextPassword = syntheticPassword();
  const backups = await service.recovery.complete({
    challenge: proof.challenge,
    newPassword: nextPassword,
    confirmation: nextPassword,
  });
  assert.equal(backups.kind, "recovery_backups");
  await service.recovery.cancel({ challenge: backups.challenge });
  const resumed = await service.emergency.resume({
    resumeSecret,
    emergencyAcknowledged: true,
  });
  const ready = await service.recovery.redeem(
    { username: target.username, handoff: resumed.handoff },
    "source",
  );
  assert.equal(ready.kind, "recovery_backups");
  await service.recovery.acknowledge({
    challenge: ready.challenge,
    confirmed: true,
  });
  await assert.rejects(
    service.emergency.resume({ resumeSecret, emergencyAcknowledged: true }),
  );
});

test("contact replacement or release invalidates an emergency case's old resume authority", async () => {
  for (const change of ["replace", "release"]) {
    await fixture.reset();
    const actor = await eligible(["Admin"]);
    const key = await custody(actor),
      resumeSecret = randomBytes(32).toString("base64url");
    await service.emergency.redeem({
      secret: key.secret,
      username: actor.username,
      scope: "both",
      resumeSecret,
      emergencyAcknowledged: true,
      resumeCustodyConfirmed: true,
    });
    await fixture.db.collection("staff_profiles").updateOne(
      { accountId: actor.id },
      {
        $set:
          change === "replace"
            ? { email: "changed@example.invalid" }
            : { "emailVerification.releasedAt": fixture.clock() },
        $inc: { revision: 1 },
      },
    );
    const before = await fixture.db
      .collection("staff_recovery_requests")
      .countDocuments();
    await assert.rejects(
      service.emergency.resume({ resumeSecret, emergencyAcknowledged: true }),
      { code: "emergency_denied" },
    );
    assert.equal(
      await fixture.db.collection("staff_recovery_requests").countDocuments(),
      before,
    );
  }
});
