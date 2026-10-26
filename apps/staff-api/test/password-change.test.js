import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import argon2 from "argon2";
import { createAuthService } from "../src/auth.js";
import {
  createSecurityFixture,
  syntheticPassword,
} from "./helpers/security-fixture.js";
import { startIsolatedApiProcess } from "./helpers/isolated-api-process.js";

let fixture;
before(async () => {
  fixture = await createSecurityFixture();
});
after(async () => {
  await fixture?.close();
});
beforeEach(async () => {
  await fixture.reset();
});
const post = (path, token, body) =>
  fixture.request(`/password/change/${path}`, { method: "POST", token, body });
async function login(account) {
  const result = await fixture.request("/auth/login", {
    method: "POST",
    body: { username: account.username, password: account.password },
  });
  assert.equal(result.status, 200);
  if (!account.secret) return result.body.token;
  const factor = await fixture.request("/mfa/complete", {
    method: "POST",
    body: {
      challenge: result.body.challenge,
      code: await fixture.totp(account.secret),
    },
  });
  assert.equal(factor.status, 200);
  return factor.body.token;
}
async function ready(account, token) {
  const started = await post("start", token, { password: account.password });
  assert.equal(started.status, 200);
  if (started.body.kind === "password_mfa") {
    fixture.advance(30000);
    const result = await post("identity", token, {
      challenge: started.body.challenge,
      method: "totp",
      code: await fixture.totp(account.secret),
    });
    assert.equal(result.status, 200);
  }
  return started.body.challenge;
}
const input = (challenge, password = syntheticPassword()) => ({
  challenge,
  newPassword: password,
  confirmation: password,
});
function service(testWork) {
  return createAuthService({
    db: fixture.db,
    client: fixture.client,
    vault: fixture.vault,
    clock: fixture.clock,
    testPasswordWork: testWork,
  }).passwordChange;
}
function pause(stage) {
  let announce, finish;
  const entered = new Promise((resolve) => {
    announce = resolve;
  });
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  return {
    entered,
    finish,
    observe: async (work) => {
      if (work.stage === stage) {
        announce();
        await wait;
      }
    },
  };
}

for (const roles of [
  ["Admin"],
  ["Clinic Admin"],
  ["Clinic Admin"],
  ["Lab Admin"],
  ["Receptionist"],
  ["Receptionist"],
  ["Receptionist", "Lab Admin"],
]) {
  test(`own password change and preserved profile/factors: ${roles.join(" + ")}`, async () => {
    const admin = roles.some((role) => role.includes("Admin"));
    const account = await fixture.account({ roles, mfa: admin });
    const token = await login(account);
    const profile = await fixture.db
      .collection("staff_profiles")
      .findOne({ accountId: account.id });
    const stored = await fixture.db
      .collection("accounts")
      .findOne({ _id: account.id });
    const challenge = await ready(account, token),
      body = input(challenge);
    const response = await post("complete", token, body);
    assert.equal(response.status, 200);
    const next = await fixture.db
      .collection("accounts")
      .findOne({ _id: account.id });
    assert.ok(await argon2.verify(next.passwordHash, body.newPassword));
    assert.equal(next.version, stored.version + 1);
    assert.equal(
      next.mfa.secretCipher?.ciphertext,
      stored.mfa.secretCipher?.ciphertext,
    );
    assert.deepEqual(next.mfa.backupCodes, stored.mfa.backupCodes);
    assert.deepEqual(
      await fixture.db
        .collection("staff_profiles")
        .findOne({ accountId: account.id }),
      profile,
    );
    assert.equal((await fixture.request("/workspace", { token })).status, 401);
    const entry = await fixture.db
      .collection("staff_password_history")
      .findOne({ accountId: account.id });
    assert.equal(fixture.vault.decrypt(entry.hashCipher), stored.passwordHash);
    assert.equal(entry.passwordHash, undefined);
    assert.equal(entry.password, undefined);
  });
}
test("wrong current-password cooldown is distinct, persistent and isolated from login/other accounts", async () => {
  const a = await fixture.account(),
    b = await fixture.account();
  const token = await login(a),
    other = await login(b);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await post("start", token, { password: syntheticPassword() })).body.error
        .code,
      "password_change_failed",
    );
  assert.equal(
    (await post("start", token, { password: a.password })).body.error.code,
    "password_change_cooldown",
  );
  assert.equal(
    (await post("start", other, { password: b.password })).status,
    200,
  );
  assert.equal(
    (
      await fixture.request("/auth/login", {
        method: "POST",
        body: { username: a.username, password: a.password },
      })
    ).status,
    200,
  );
  const child = await startIsolatedApiProcess();
  try {
    assert.equal(
      (
        await child.request("/password/change/start", {
          token,
          body: { password: a.password },
        })
      ).body.error.code,
      "password_change_cooldown",
    );
  } finally {
    await child.stop();
  }
});
test("administrative flow requires fresh MFA; replay and wrong factors cannot authorize", async () => {
  const a = await fixture.account({ roles: ["Admin"], mfa: true }),
    token = await login(a);
  const start = await post("start", token, { password: a.password });
  assert.equal(
    (await post("complete", token, input(start.body.challenge))).body.error
      .code,
    "password_change_expired",
  );
  assert.equal(
    (
      await post("identity", token, {
        challenge: start.body.challenge,
        code: await fixture.totp(a.secret),
        method: "totp",
      })
    ).body.error.code,
    "password_change_failed",
  );
  assert.equal(
    (
      await post("identity", token, {
        challenge: start.body.challenge,
        code: "000000",
        method: "unknown",
      })
    ).body.error.code,
    "password_change_failed",
  );
  fixture.advance(30000);
  assert.equal(
    (
      await post("identity", token, {
        challenge: start.body.challenge,
        code: await fixture.totp(a.secret),
        method: "totp",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post("identity", token, {
        challenge: start.body.challenge,
        code: await fixture.totp(a.secret),
        method: "totp",
      })
    ).body.error.code,
    "password_change_expired",
  );
});
test("unused backup code is consumed atomically once without regenerating factors", async () => {
  const a = await fixture.account({ roles: ["Admin"], mfa: true }),
    token = await login(a);
  const start = await post("start", token, { password: a.password });
  const payload = {
    challenge: start.body.challenge,
    method: "backup",
    code: a.backupCodes[0],
  };
  const results = await Promise.all([
    post("identity", token, payload),
    post("identity", token, payload),
  ]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  const account = await fixture.db
    .collection("accounts")
    .findOne({ _id: a.id });
  assert.equal(account.mfa.backupCodes.filter((code) => code.usedAt).length, 1);
  assert.equal(account.mfa.backupCodes.length, 10);
});
test("basic validation and manager-field injection do not spend history allowance", async () => {
  const a = await fixture.account(),
    token = await login(a),
    challenge = await ready(a, token);
  for (const body of [
    { challenge, newPassword: "short", confirmation: "short" },
    { ...input(challenge), confirmation: "different" },
    { ...input(challenge), accountId: "other" },
  ]) {
    assert.equal((await post("complete", token, body)).status, 400);
  }
  assert.equal(
    (
      await fixture.db
        .collection("password_change_counters")
        .findOne({ _id: a.id })
    ).historyAttempts,
    0,
  );
});
test("current reuse and full history including a much older entry are rejected", async () => {
  const a = await fixture.account(),
    token = await login(a),
    challenge = await ready(a, token);
  const old = syntheticPassword(),
    hash = await argon2.hash(old, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
  // This old entry must still be checked, irrespective of its recorded age.
  await fixture.db.collection("staff_password_history").insertOne({
    accountId: a.id,
    credentialVersion: 0,
    hashCipher: fixture.vault.encrypt(hash),
    retiredAt: new Date("1990-01-01"),
  });
  assert.equal(
    (await post("complete", token, input(challenge, a.password))).body.error
      .code,
    "password_reused",
  );
  assert.equal(
    (await post("complete", token, input(challenge, old))).body.error.code,
    "password_reused",
  );
  assert.equal((await post("complete", token, input(challenge))).status, 200);
  assert.equal(
    await fixture.db
      .collection("staff_password_history")
      .countDocuments({ accountId: a.id }),
    2,
  );
});
test("history allowance survives replacement/restart and remains distinct from cooldown", async () => {
  const a = await fixture.account(),
    token = await login(a);
  for (let i = 0; i < 5; i++) {
    const challenge = await ready(a, token);
    assert.equal(
      (await post("complete", token, input(challenge, a.password))).body.error
        .code,
      "password_reused",
    );
    await post("cancel", token, {});
  }
  const challenge = await ready(a, token),
    child = await startIsolatedApiProcess();
  try {
    assert.equal(
      (
        await child.request("/password/change/complete", {
          token,
          body: input(challenge),
        })
      ).body.error.code,
      "password_change_allowance",
    );
  } finally {
    await child.stop();
  }
  assert.equal(
    (
      await fixture.db
        .collection("password_change_counters")
        .findOne({ _id: a.id })
    ).failures,
    0,
  );
});
test("two-job busy refusals neither queue nor reserve another account's allowance", async () => {
  const a = await fixture.account(),
    b = await fixture.account(),
    c = await fixture.account();
  const ta = await login(a),
    tb = await login(b),
    tc = await login(c);
  const ca = await ready(a, ta),
    cb = await ready(b, tb),
    cc = await ready(c, tc);
  let count = 0,
    release,
    entered;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const both = new Promise((resolve) => {
    entered = resolve;
  });
  const slow = service(async ({ stage }) => {
    if (stage === "history-current") {
      if (++count === 2) entered();
      await hold;
    }
  });
  const jobs = [slow.complete(ta, input(ca)), slow.complete(tb, input(cb))];
  try {
    await both;
    assert.equal(
      (await post("complete", tc, input(cc))).body.error.code,
      "password_change_busy",
    );
    assert.equal(
      (
        await fixture.db
          .collection("password_change_counters")
          .findOne({ _id: c.id })
      ).historyAttempts,
      0,
    );
    const child = await startIsolatedApiProcess();
    try {
      assert.equal(
        (
          await child.request("/password/change/complete", {
            token: ta,
            body: input(ca),
          })
        ).body.error.code,
        "password_change_busy",
      );
    } finally {
      await child.stop();
    }
  } finally {
    release();
    await Promise.all(jobs);
  }
});
for (const action of ["cancel", "expire", "disable", "version", "revoke"]) {
  test(`authoritative ${action} during paused hashing refuses without installing password`, async () => {
    const a = await fixture.account(),
      token = await login(a),
      challenge = await ready(a, token);
    const before = await fixture.db
      .collection("accounts")
      .findOne({ _id: a.id });
    const hold = pause("hash"),
      slow = service(hold.observe);
    const job = slow.complete(token, input(challenge)).then(
      () => "allowed",
      (error) => error.code,
    );
    await hold.entered;
    try {
      if (action === "cancel") await post("cancel", token, {});
      if (action === "expire") fixture.advance(5 * 60000);
      if (action === "disable")
        await fixture.db
          .collection("accounts")
          .updateOne({ _id: a.id }, { $set: { status: "disabled" } });
      if (action === "version")
        await fixture.db
          .collection("accounts")
          .updateOne({ _id: a.id }, { $inc: { version: 1 } });
      if (action === "revoke")
        await fixture.db
          .collection("staff_sessions")
          .updateMany(
            { accountId: a.id },
            { $set: { revokedAt: fixture.clock() } },
          );
    } finally {
      hold.finish();
    }
    assert.notEqual(await job, "allowed");
    assert.equal(
      (await fixture.db.collection("accounts").findOne({ _id: a.id }))
        .passwordHash,
      before.passwordHash,
    );
    assert.equal(
      await fixture.db
        .collection("staff_password_history")
        .countDocuments({ accountId: a.id }),
      0,
    );
  });
}
test("cancellation while current-password work is pending cannot create a late authorization", async () => {
  const a = await fixture.account(),
    token = await login(a),
    hold = pause("current"),
    slow = service(hold.observe);
  const job = slow.start(token, { password: a.password }).then(
    () => "allowed",
    (error) => error.code,
  );
  await hold.entered;
  try {
    await post("cancel", token, {});
  } finally {
    hold.finish();
  }
  assert.equal(await job, "password_change_expired");
  assert.equal(
    await fixture.db
      .collection("auth_challenges")
      .countDocuments({ purpose: "password-change" }),
    0,
  );
});
test("concurrent completion has one winner and revokes every session/challenge", async () => {
  const a = await fixture.account(),
    t1 = await login(a),
    t2 = await login(a);
  const c1 = await ready(a, t1),
    c2 = await ready(a, t2);
  const results = await Promise.all([
    post("complete", t1, input(c1)),
    post("complete", t2, input(c2)),
  ]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(
    await fixture.db
      .collection("staff_password_history")
      .countDocuments({ accountId: a.id }),
    1,
  );
  assert.equal(
    (await fixture.request("/workspace", { token: t1 })).status,
    401,
  );
  assert.equal(
    (await fixture.request("/workspace", { token: t2 })).status,
    401,
  );
  assert.equal(
    await fixture.db
      .collection("auth_challenges")
      .countDocuments({ accountId: a.id, consumedAt: null, revokedAt: null }),
    0,
  );
});
test("audit failure rolls back hash/history/revocation and permits safe retry", async () => {
  const a = await fixture.account(),
    token = await login(a),
    challenge = await ready(a, token);
  const before = await fixture.db.collection("accounts").findOne({ _id: a.id });
  await fixture.restart({ failAudit: true });
  assert.equal((await post("complete", token, input(challenge))).status, 503);
  assert.equal(
    (await fixture.db.collection("accounts").findOne({ _id: a.id }))
      .passwordHash,
    before.passwordHash,
  );
  assert.equal(
    await fixture.db
      .collection("staff_password_history")
      .countDocuments({ accountId: a.id }),
    0,
  );
  assert.equal((await fixture.request("/workspace", { token })).status, 200);
  await fixture.restart();
  assert.equal((await post("complete", token, input(challenge))).status, 200);
});
test("separate API restart persists password, complete history and revoked sessions", async () => {
  const a = await fixture.account(),
    token = await login(a),
    challenge = await ready(a, token),
    body = input(challenge);
  let child = await startIsolatedApiProcess();
  try {
    assert.equal(
      (await child.request("/password/change/complete", { token, body }))
        .status,
      200,
    );
  } finally {
    await child.stop();
  }
  child = await startIsolatedApiProcess();
  try {
    assert.equal((await child.request("/workspace", { token })).status, 401);
    const signIn = await child.request("/auth/login", {
      body: { username: a.username, password: body.newPassword },
    });
    assert.equal(signIn.status, 200);
    const start = await child.request("/password/change/start", {
      token: signIn.body.token,
      body: { password: body.newPassword },
    });
    assert.equal(
      (
        await child.request("/password/change/complete", {
          token: signIn.body.token,
          body: input(start.body.challenge, a.password),
        })
      ).body.error.code,
      "password_reused",
    );
  } finally {
    await child.stop();
  }
});
