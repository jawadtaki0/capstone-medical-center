import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import * as argon2 from "argon2";
import { createAuthService } from "../src/auth.js";
import { connectStaffDatabase } from "../src/db.js";
import { createSetupMemoryFixture } from "./helpers/setup-memory-fixture.js";
import {
  assertIsolatedTestTarget,
  createSecurityFixture,
  digest,
  syntheticPassword,
  syntheticProfile,
  TEST_DATABASE,
} from "./helpers/security-fixture.js";

let fixture;
let connection;
let calls;
let pauseHash;
let reachedHash;
let releaseHash;
let auth;
before(async () => {
  // Explicit offline mode is for contract evidence when the approved local
  // database is unavailable, never a substitute for real transaction checks.
  if (process.env.STAFF_SETUP_TEST_MEMORY === "1") {
    fixture = createSetupMemoryFixture();
    connection = { db: fixture.db, client: fixture.client };
    return;
  }
  fixture = await createSecurityFixture();
  connection = await connectStaffDatabase({
    database: TEST_DATABASE,
    demoMode: true,
  });
  assertIsolatedTestTarget(connection);
});
beforeEach(async () => {
  await fixture.reset();
  calls = 0;
  pauseHash = false;
  auth = createAuthService({
    ...connection,
    vault: fixture.vault,
    clock: fixture.clock,
    testSetupHash: async (password, options) => {
      calls += 1;
      assert.deepEqual(options, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      });
      if (pauseHash) {
        reachedHash();
        await new Promise((resolve) => {
          releaseHash = resolve;
        });
      }
      return argon2.hash(password, options);
    },
  });
});
after(async () => {
  await connection?.client.close();
  await fixture?.close();
});

const denied = (operation, code = "authentication_failed") =>
  assert.rejects(operation, (error) => error.code === code);
const bootstrapInput = (code) => ({
  username: "synthetic.bootstrap",
  password: syntheticPassword(),
  profile: syntheticProfile(),
  code,
});
async function pendingAccount(roles = ["Clinic Receptionist"]) {
  const person = await fixture.account({ roles, status: "setup_pending" });
  const code = randomBytes(32).toString("base64url");
  await fixture.db.collection("accounts").updateOne(
    { _id: person.id },
    {
      $unset: { passwordHash: "" },
      $set: { mfa: null, setupGeneration: 1 },
    },
  );
  await fixture.db.collection("account_setup_codes").insertOne({
    _id: person.id,
    accountId: person.id,
    accountVersion: 1,
    generation: 1,
    codeHash: digest(code),
    issuedAt: fixture.clock(),
    expiresAt: new Date(fixture.clock().getTime() + 30 * 60000),
    attempts: 0,
    consumedAt: null,
  });
  return {
    ...person,
    input: { username: person.username, code, password: syntheticPassword() },
  };
}
async function duringHash(operation, mutation) {
  pauseHash = true;
  const reached = new Promise((resolve) => {
    reachedHash = resolve;
  });
  const pending = operation();
  await reached;
  try {
    await mutation();
  } finally {
    releaseHash();
  }
  return pending;
}
async function failureCount(subject) {
  return (
    (
      await fixture.db
        .collection("auth_throttles")
        .findOne({ _id: `subject:${digest(subject)}` })
    )?.failures ?? 0
  );
}

test("bootstrap rejects absent, expired, wrong and cooled-down authorization without hashing or double failures", async () => {
  await denied(auth.claimSetup(bootstrapInput("wrong")));
  assert.equal(calls, 0);
  assert.equal(await failureCount("first-admin"), 1);
  const code = await fixture.issueSetup();
  for (let index = 0; index < 4; index += 1)
    await denied(auth.claimSetup(bootstrapInput("wrong")));
  assert.equal(calls, 0);
  assert.equal(await failureCount("first-admin"), 5);
  await denied(auth.claimSetup(bootstrapInput(code)), "try_later");
  assert.equal(calls, 0);
  assert.equal(await failureCount("first-admin"), 5);
  fixture.advance(31 * 60000);
  await denied(auth.claimSetup(bootstrapInput(code)));
  assert.equal(calls, 0);
});

test("assigned setup rejects missing, wrong, disabled, expired and consumed states before hashing", async () => {
  await denied(
    auth.assignedAccountSetup({
      username: "synthetic.missing",
      code: "wrong",
      password: syntheticPassword(),
    }),
  );
  const person = await pendingAccount();
  await denied(auth.assignedAccountSetup({ ...person.input, code: "wrong" }));
  assert.equal(await failureCount(person.username), 1);
  await fixture.db
    .collection("accounts")
    .updateOne({ _id: person.id }, { $set: { status: "disabled" } });
  await denied(auth.assignedAccountSetup(person.input));
  await fixture.db
    .collection("accounts")
    .updateOne({ _id: person.id }, { $set: { status: "setup_pending" } });
  await fixture.db
    .collection("account_setup_codes")
    .updateOne({ _id: person.id }, { $set: { consumedAt: fixture.clock() } });
  await denied(auth.assignedAccountSetup(person.input));
  await fixture.db
    .collection("account_setup_codes")
    .updateOne(
      { _id: person.id },
      { $set: { consumedAt: null, expiresAt: fixture.clock() } },
    );
  await denied(auth.assignedAccountSetup(person.input));
  assert.equal(calls, 0);
});

test("bootstrap rejects closed, exhausted and inconsistent markers before hashing", async () => {
  const code = await fixture.issueSetup();
  const markers = fixture.db.collection("installation_state");
  await markers.updateOne(
    { _id: "first-admin" },
    { $set: { status: "claimed" } },
  );
  await denied(auth.claimSetup(bootstrapInput(code)));
  await markers.updateOne(
    { _id: "first-admin" },
    { $set: { status: "issued", attempts: 5 } },
  );
  await denied(auth.claimSetup(bootstrapInput(code)));
  await markers.updateOne({ _id: "first-admin" }, { $set: { attempts: 0 } });
  await fixture.account();
  await denied(auth.claimSetup(bootstrapInput(code)), "authority_unavailable");
  assert.equal(calls, 0);
});

test("assigned failures and replacement preserve cooldown without hashing or double-counting", async () => {
  const person = await pendingAccount();
  for (let index = 0; index < 5; index += 1)
    await denied(
      auth.assignedAccountSetup({
        ...person.input,
        code: index === 0 ? "" : "wrong",
      }),
    );
  assert.equal(calls, 0);
  assert.equal(await failureCount(person.username), 5);
  const setup = fixture.db.collection("account_setup_codes");
  assert.equal((await setup.findOne({ _id: person.id })).attempts, 5);
  await setup.updateOne(
    { _id: person.id },
    { $set: { attempts: 0 }, $inc: { generation: 1 } },
  );
  await denied(auth.assignedAccountSetup(person.input), "try_later");
  assert.equal(calls, 0);
  assert.equal(await failureCount(person.username), 5);
  assert.equal((await setup.findOne({ _id: person.id })).attempts, 0);
});

for (const change of ["replace", "revoke", "expire", "existing-account"]) {
  test(`bootstrap final authorization rejects ${change} during hashing without creating account/profile`, async () => {
    const code = await fixture.issueSetup();
    await denied(
      duringHash(
        () => auth.claimSetup(bootstrapInput(code)),
        async () => {
          const marker = fixture.db.collection("installation_state");
          if (change === "replace")
            await marker.updateOne(
              { _id: "first-admin" },
              {
                $set: {
                  codeHash: digest("replacement"),
                  issuedAt: new Date(fixture.clock().getTime() + 1),
                },
              },
            );
          if (change === "revoke")
            await marker.updateOne(
              { _id: "first-admin" },
              { $set: { status: "revoked" } },
            );
          if (change === "expire") fixture.advance(30 * 60000);
          if (change === "existing-account") await fixture.account();
        },
      ),
      change === "existing-account"
        ? "authority_unavailable"
        : "authentication_failed",
    );
    assert.equal(calls, 1);
    assert.equal(
      await fixture.db
        .collection("accounts")
        .countDocuments({ username: "synthetic.bootstrap" }),
      0,
    );
    assert.equal(
      (
        await fixture.db
          .collection("installation_state")
          .findOne({ _id: "first-admin" })
      ).status === "claimed",
      false,
    );
  });
}

for (const change of [
  "replace",
  "revoke",
  "disable",
  "expire",
  "version",
  "same-digest-generation",
]) {
  test(`assigned setup final authorization rejects ${change} during hashing without installing password`, async () => {
    const person = await pendingAccount();
    await denied(
      duringHash(
        () => auth.assignedAccountSetup(person.input),
        async () => {
          const setup = fixture.db.collection("account_setup_codes");
          if (change === "replace")
            await setup.updateOne(
              { _id: person.id },
              {
                $set: { codeHash: digest("replacement") },
                $inc: { generation: 1 },
              },
            );
          if (change === "same-digest-generation")
            await setup.updateOne(
              { _id: person.id },
              { $inc: { generation: 1 } },
            );
          if (change === "revoke")
            await setup.updateOne(
              { _id: person.id },
              { $set: { revokedAt: fixture.clock() } },
            );
          if (change === "disable")
            await fixture.db
              .collection("accounts")
              .updateOne({ _id: person.id }, { $set: { status: "disabled" } });
          if (change === "version") {
            await fixture.db
              .collection("accounts")
              .updateOne({ _id: person.id }, { $inc: { version: 1 } });
            await setup.updateOne(
              { _id: person.id },
              { $inc: { accountVersion: 1 } },
            );
          }
          if (change === "expire") fixture.advance(30 * 60000);
        },
      ),
    );
    const account = await fixture.db
      .collection("accounts")
      .findOne({ _id: person.id });
    assert.equal(account.passwordHash, undefined);
    assert.equal(
      (
        await fixture.db
          .collection("account_setup_codes")
          .findOne({ _id: person.id })
      ).consumedAt,
      null,
    );
    assert.equal(await failureCount(person.username), 1);
  });
}

test("eligible bootstrap hashes once, atomically creates linked records and preserves interrupted enrollment", async () => {
  const code = await fixture.issueSetup();
  const input = bootstrapInput(code);
  const result = await auth.claimSetup(input);
  assert.equal(result.kind, "enroll");
  assert.equal(result.serverNow, fixture.clock().toISOString());
  assert.equal(calls, 1);
  const account = await fixture.db
    .collection("accounts")
    .findOne({ username: input.username });
  assert.equal(await argon2.verify(account.passwordHash, input.password), true);
  assert.equal(
    await fixture.db
      .collection("staff_profiles")
      .countDocuments({ accountId: account._id }),
    1,
  );
  await denied(auth.claimSetup(input));
  assert.equal(calls, 1);
  const enrollment = await auth.enroll({ challenge: result.challenge });
  const resumed = await auth.login({
    username: input.username,
    password: input.password,
  });
  const again = await auth.enroll({ challenge: resumed.challenge });
  assert.equal(again.secret, enrollment.secret);
});

test("assigned concurrent redemption hashes eligible requests but has one durable winner", async () => {
  const person = await pendingAccount();
  pauseHash = true;
  let reached = 0;
  let allow;
  const ready = new Promise((resolve) => {
    allow = resolve;
  });
  const releases = [];
  reachedHash = () => {
    reached += 1;
    if (reached === 2) allow();
  };
  // Each suspended invocation obtains its own release callback.
  auth = createAuthService({
    ...connection,
    vault: fixture.vault,
    clock: fixture.clock,
    testSetupHash: async (password, options) => {
      calls += 1;
      await new Promise((resolve) => {
        releases.push(resolve);
        reachedHash();
      });
      return argon2.hash(password, options);
    },
  });
  const pending = [
    auth.assignedAccountSetup(person.input),
    auth.assignedAccountSetup({
      ...person.input,
      password: syntheticPassword(),
    }),
  ];
  await ready;
  releases.forEach((release) => release());
  const results = await Promise.allSettled(pending);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason.code === "authentication_failed",
    ).length,
    1,
  );
  assert.equal(
    (await fixture.db.collection("accounts").findOne({ _id: person.id }))
      .version,
    2,
  );
  assert.equal(
    await fixture.db
      .collection("staff_sessions")
      .countDocuments({ accountId: person.id }),
    1,
  );
  await denied(auth.assignedAccountSetup(person.input));
  assert.equal(calls, 2);
});

test("bootstrap concurrent redemption has one linked-account winner and replay performs no hashing", async () => {
  const code = await fixture.issueSetup();
  const first = bootstrapInput(code);
  const second = { ...bootstrapInput(code), username: "synthetic.other" };
  const outcomes = await Promise.allSettled([
    auth.claimSetup(first),
    auth.claimSetup(second),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason.code === "authentication_failed",
    ).length,
    1,
  );
  assert.equal(await fixture.db.collection("accounts").countDocuments({}), 1);
  assert.equal(
    await fixture.db.collection("staff_profiles").countDocuments({}),
    1,
  );
  const beforeReplay = calls;
  await denied(auth.claimSetup(first));
  assert.equal(calls, beforeReplay);
});

test("setup hashing seam refuses non-test databases and non-isolated clients", () => {
  for (const input of [
    { ...connection, db: { databaseName: "capstone_staff_dev" } },
    {
      ...connection,
      client: {
        startSession() {},
        options: {
          hosts: [{ host: "remote", port: 27018 }],
          replicaSet: "capstoneStaffDev",
        },
      },
    },
  ])
    assert.throws(() =>
      createAuthService({
        ...input,
        vault: fixture.vault,
        testSetupHash: async () => "not-a-hash",
      }),
    );
});
