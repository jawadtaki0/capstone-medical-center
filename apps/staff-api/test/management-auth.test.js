import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import * as argon2 from "argon2";
import { generate, generateSecret } from "otplib";
import {
  AUTH_POLICY,
  createAuthService,
  digestSecret,
  recentVerificationExpiry,
} from "../src/auth.js";
import { createVault } from "../src/local-security.js";

// These tests never connect to MongoDB, read private runtime configuration or
// provision development users. The serialized fake transaction checks service
// contracts/rollback; the guarded Mongo suites verify real transaction races.
function memoryDatabase() {
  let records = new Map();
  let transactionTail = Promise.resolve();
  let failAuditAction;
  const copy = (value) => structuredClone(value);
  const rows = (name) => {
    if (!records.has(name)) records.set(name, []);
    return records.get(name);
  };
  const valueAt = (record, path) =>
    path.split(".").reduce((value, key) => value?.[key], record);
  function matches(record, filter) {
    return Object.entries(filter).every(([key, expected]) => {
      const actual = valueAt(record, key);
      if (expected === null) return actual == null;
      if (
        expected &&
        typeof expected === "object" &&
        !(expected instanceof Date)
      ) {
        if ("$lt" in expected) return actual < expected.$lt;
        if ("$ne" in expected) return actual !== expected.$ne;
        if ("$exists" in expected)
          return (actual !== undefined) === expected.$exists;
        if ("$in" in expected) return expected.$in.includes(actual);
        if ("$elemMatch" in expected)
          return (
            Array.isArray(actual) &&
            actual.some((item) => matches(item, expected.$elemMatch))
          );
      }
      return actual instanceof Date && expected instanceof Date
        ? actual.getTime() === expected.getTime()
        : actual === expected;
    });
  }
  function setPath(record, path, value, filter) {
    const keys = path.split(".");
    let parent = record;
    for (const key of keys.slice(0, -1)) {
      if (key === "$") {
        const candidate = filter["mfa.backupCodes"].$elemMatch;
        parent = parent.find((item) => matches(item, candidate));
      } else parent = parent[key] ??= {};
    }
    parent[keys.at(-1)] = copy(value);
  }
  function update(record, change, filter) {
    for (const [path, value] of Object.entries(change.$set ?? {}))
      setPath(record, path, value, filter);
    for (const [path, value] of Object.entries(change.$inc ?? {}))
      setPath(record, path, (valueAt(record, path) ?? 0) + value, filter);
    for (const path of Object.keys(change.$unset ?? {})) {
      const keys = path.split(".");
      const parent = valueAt(record, keys.slice(0, -1).join("."));
      if (keys.length === 1) delete record[path];
      else if (parent) delete parent[keys.at(-1)];
    }
  }
  const db = {
    collection(name) {
      return {
        async findOne(filter) {
          return copy(
            rows(name).find((record) => matches(record, filter)) ?? null,
          );
        },
        async insertOne(record) {
          if (name === "security_events" && record.action === failAuditAction)
            throw new Error("Synthetic audit outage");
          if (rows(name).some((item) => item._id === record._id))
            throw Object.assign(new Error("Synthetic duplicate"), {
              code: 11000,
            });
          rows(name).push(copy(record));
          return { insertedId: record._id };
        },
        async updateOne(filter, change) {
          const record = rows(name).find((item) => matches(item, filter));
          if (!record) return { modifiedCount: 0, matchedCount: 0 };
          const before = copy(record);
          update(record, change, filter);
          return {
            modifiedCount: isDeepStrictEqual(before, record) ? 0 : 1,
            matchedCount: 1,
          };
        },
        async updateMany(filter, change) {
          const selected = rows(name).filter((item) => matches(item, filter));
          selected.forEach((record) => update(record, change, filter));
          return {
            modifiedCount: selected.length,
            matchedCount: selected.length,
          };
        },
        async replaceOne(filter, replacement, options = {}) {
          const index = rows(name).findIndex((item) => matches(item, filter));
          if (index >= 0) rows(name)[index] = copy(replacement);
          else if (options.upsert) rows(name).push(copy(replacement));
          return { modifiedCount: index >= 0 ? 1 : 0 };
        },
        async deleteOne(filter) {
          const index = rows(name).findIndex((item) => matches(item, filter));
          if (index >= 0) rows(name).splice(index, 1);
          return { deletedCount: index >= 0 ? 1 : 0 };
        },
      };
    },
  };
  const client = {
    startSession() {
      return {
        async withTransaction(callback) {
          const previous = transactionTail;
          let release;
          transactionTail = new Promise((resolve) => {
            release = resolve;
          });
          await previous;
          const snapshot = copy(records);
          try {
            return await callback();
          } catch (error) {
            records = snapshot;
            throw error;
          } finally {
            release();
          }
        },
        async endSession() {},
      };
    },
  };
  return {
    db,
    client,
    rows,
    seed(name, record) {
      rows(name).push(copy(record));
    },
    find(name, id) {
      return rows(name).find((record) => record._id === id);
    },
    auditFailure(action) {
      failAuditAction = action;
    },
  };
}

function fixture(t) {
  const memory = memoryDatabase();
  const vault = createVault(randomBytes(32).toString("base64"));
  t.after(() => vault.destroy());
  let at = new Date("2040-10-02T08:00:00Z");
  memory.seed("staff_management_state", { _id: "staff-controls", revision: 0 });
  const service = createAuthService({
    db: memory.db,
    client: memory.client,
    vault,
    clock: () => new Date(at),
  });
  return {
    ...memory,
    vault,
    service,
    now: () => new Date(at),
    advance(ms) {
      at = new Date(at.getTime() + ms);
    },
    rewind(ms) {
      at = new Date(at.getTime() - ms);
    },
  };
}

const password = () =>
  `Synthetic only ${randomBytes(24).toString("base64url")}`;
async function activeAccount(
  f,
  { roles = ["Admin"], acknowledged = true } = {},
) {
  const accountId = `account:synthetic-${randomUUID()}`;
  const secret = generateSecret();
  const backup = randomBytes(16).toString("hex");
  const passphrase = password();
  const account = {
    _id: accountId,
    username: `synthetic.${randomBytes(6).toString("hex")}`,
    passwordHash: await argon2.hash(passphrase, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    }),
    roles,
    status: "active",
    version: 1,
    mfa: {
      enabled: true,
      version: 1,
      secretCipher: f.vault.encrypt(secret),
      lastAcceptedStep: Math.floor(f.now().getTime() / 30000) - 2,
      backupAcknowledged: acknowledged,
      backupCodes: [{ digest: digestSecret(backup), usedAt: null }],
    },
  };
  f.seed("accounts", account);
  f.seed("staff_profiles", {
    _id: `profile:${randomUUID()}`,
    accountId,
    firstName: "Synthetic",
    lastName: "Staff",
  });
  return {
    account: f.find("accounts", accountId),
    password: passphrase,
    secret,
    backup,
  };
}
function existingSession(f, account, proof = {}) {
  const token = randomBytes(32).toString("base64url");
  const record = {
    _id: digestSecret(token),
    accountId: account._id,
    version: account.version,
    revokedAt: null,
    createdAt: f.now(),
    lastActivityAt: f.now(),
    absoluteExpiresAt: new Date(f.now().getTime() + AUTH_POLICY.absoluteMs),
    expiresAt: new Date(f.now().getTime() + AUTH_POLICY.absoluteMs),
    ...proof,
  };
  f.seed("staff_sessions", record);
  return { token, record: f.find("staff_sessions", record._id) };
}
function pendingAccount(f, roles = ["Clinic Receptionist"]) {
  const accountId = `account:synthetic-${randomUUID()}`;
  const code = randomBytes(32).toString("base64url");
  const account = {
    _id: accountId,
    username: `synthetic.${randomBytes(6).toString("hex")}`,
    roles,
    status: "setup_pending",
    version: 1,
    passwordHash: null,
    mfa: null,
  };
  f.seed("accounts", account);
  f.seed("staff_profiles", {
    _id: `profile:${randomUUID()}`,
    accountId,
    firstName: "Synthetic",
    lastName: "New Staff",
  });
  f.seed("account_setup_codes", {
    _id: accountId,
    accountId,
    accountVersion: 1,
    generation: 1,
    codeHash: digestSecret(code),
    issuedAt: f.now(),
    expiresAt: new Date(f.now().getTime() + 30 * 60000),
    attempts: 0,
    consumedAt: null,
  });
  return { account: f.find("accounts", accountId), code, password: password() };
}
async function totp(secret, at) {
  return generate({ secret, epoch: Math.floor(at.getTime() / 1000) });
}
async function wrongTotp(secret, at) {
  const valid = new Set(
    await Promise.all(
      [-30000, 0, 30000].map((offset) =>
        totp(secret, new Date(at.getTime() + offset)),
      ),
    ),
  );
  for (let index = 0; index < 10; index += 1) {
    const candidate = String(index).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error("Could not select a synthetic invalid token.");
}
const rejectsCode = (operation, code) =>
  assert.rejects(operation, (error) => error.code === code);
const deadlines = (record) => [
  record.lastActivityAt.toISOString(),
  record.absoluteExpiresAt.toISOString(),
  record.expiresAt.toISOString(),
];

test("recent verification uses both real timestamps, current factor/version, and a strict five-minute boundary", () => {
  const at = new Date("2040-10-02T08:04:00Z");
  const account = {
    status: "active",
    version: 2,
    mfa: { enabled: true, version: 3, backupAcknowledged: true },
  };
  const record = {
    version: 2,
    passwordVerifiedAt: new Date("2040-10-02T08:00:00Z"),
    mfaVerifiedAt: at,
    verificationMfaVersion: 3,
  };
  assert.equal(
    recentVerificationExpiry(record, account, at).toISOString(),
    "2040-10-02T08:05:00.000Z",
  );
  for (const changed of [
    {},
    { ...record, passwordVerifiedAt: undefined },
    { ...record, mfaVerifiedAt: undefined },
    { ...record, passwordVerifiedAt: new Date("invalid") },
    { ...record, passwordVerifiedAt: new Date("2040-10-02T08:04:01Z") },
    { ...record, version: 1 },
    { ...record, verificationMfaVersion: 2 },
  ])
    assert.equal(recentVerificationExpiry(changed, account, at), null);
  assert.equal(
    recentVerificationExpiry(record, account, new Date("2040-10-02T08:05:00Z")),
    null,
  );
  assert.equal(
    recentVerificationExpiry(
      record,
      { ...account, mfa: { ...account.mfa, backupAcknowledged: false } },
      at,
    ),
    null,
  );
});

test("login proof retains password time before delayed MFA and expired proof cannot revive after clock rewind", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const login = await f.service.login({
    username: user.account.username,
    password: user.password,
  });
  const challenge = f.find("auth_challenges", digestSecret(login.challenge));
  assert.equal(challenge.passwordVerifiedAt.getTime(), f.now().getTime());
  f.advance(4 * 60000);
  const authenticated = await f.service.completeMfa({
    challenge: login.challenge,
    code: await totp(user.secret, f.now()),
  });
  assert.equal(
    authenticated.session.recentVerificationExpiresAt,
    "2040-10-02T08:05:00.000Z",
  );
  const record = f.find("staff_sessions", digestSecret(authenticated.token));
  const before = deadlines(record);
  f.advance(60000);
  assert.equal(
    (await f.service.readSession(authenticated.token)).session
      .recentVerificationExpiresAt,
    undefined,
  );
  assert.equal(Object.hasOwn(record, "passwordVerifiedAt"), false);
  f.rewind(30000);
  assert.equal(
    (await f.service.readSession(authenticated.token)).session
      .recentVerificationExpiresAt,
    undefined,
  );
  assert.deepEqual(deadlines(record), before);
});

test("assigned receptionist setup consumes its own code without bootstrap reuse or invented password proof", async (t) => {
  const f = fixture(t);
  const user = pendingAccount(f);
  f.seed("installation_state", {
    _id: "first-admin",
    status: "completed",
    firstAccountId: "account:original",
  });
  const originalMarker = structuredClone(
    f.find("installation_state", "first-admin"),
  );
  const result = await f.service.assignedAccountSetup({
    username: user.account.username.toUpperCase(),
    code: user.code,
    password: user.password,
  });
  assert.equal(user.account.status, "active");
  assert.equal(user.account.version, 2);
  assert.equal(
    await argon2.verify(user.account.passwordHash, user.password),
    true,
  );
  assert.ok(
    f.find("account_setup_codes", user.account._id).consumedAt instanceof Date,
  );
  assert.equal(result.session.recentVerificationExpiresAt, undefined);
  assert.equal(
    Object.hasOwn(
      f.find("staff_sessions", digestSecret(result.token)),
      "passwordVerifiedAt",
    ),
    false,
  );
  const chosenHash = user.account.passwordHash;
  await rejectsCode(
    () =>
      f.service.assignedAccountSetup({
        username: user.account.username,
        code: user.code,
        password: password(),
      }),
    "authentication_failed",
  );
  assert.equal(user.account.passwordHash === chosenHash, true);
  assert.deepEqual(f.find("installation_state", "first-admin"), originalMarker);
});

test("assigned setup is strict, denies disabled/expired records, and replacement cannot erase cooldowns", async (t) => {
  const f = fixture(t);
  const invalid = pendingAccount(f);
  const before = f.find("staff_management_state", "staff-controls").revision;
  await rejectsCode(
    () =>
      f.service.assignedAccountSetup({
        username: invalid.account.username,
        code: invalid.code,
        password: invalid.password,
        roles: ["Admin"],
      }),
    "invalid_input",
  );
  assert.equal(
    f.find("staff_management_state", "staff-controls").revision,
    before,
  );
  invalid.account.status = "disabled";
  await rejectsCode(
    () =>
      f.service.assignedAccountSetup({
        username: invalid.account.username,
        code: invalid.code,
        password: invalid.password,
      }),
    "authentication_failed",
  );
  assert.equal(
    f.find("account_setup_codes", invalid.account._id).consumedAt,
    null,
  );
  const expired = pendingAccount(f);
  f.find("account_setup_codes", expired.account._id).expiresAt = f.now();
  await rejectsCode(
    () =>
      f.service.assignedAccountSetup({
        username: expired.account.username,
        code: expired.code,
        password: expired.password,
      }),
    "authentication_failed",
  );
  const user = pendingAccount(f);
  for (let attempt = 0; attempt < 5; attempt += 1)
    await rejectsCode(
      () =>
        f.service.assignedAccountSetup({
          username: user.account.username,
          code: "wrong synthetic code",
          password: user.password,
        }),
      "authentication_failed",
    );
  const replacement = randomBytes(32).toString("base64url");
  Object.assign(f.find("account_setup_codes", user.account._id), {
    generation: 2,
    attempts: 0,
    codeHash: digestSecret(replacement),
  });
  await rejectsCode(
    () =>
      f.service.assignedAccountSetup({
        username: user.account.username,
        code: replacement,
        password: user.password,
      }),
    "try_later",
  );
  assert.equal(user.account.status, "setup_pending");
});

test("assigned Admin requires MFA/ack, password selection is not verification, and retained factors remain gated after demotion", async (t) => {
  const f = fixture(t);
  const user = pendingAccount(f, ["Admin"]);
  const setup = await f.service.assignedAccountSetup({
    username: user.account.username,
    code: user.code,
    password: user.password,
  });
  assert.equal(user.account.status, "mfa_pending");
  assert.equal(setup.kind, "enroll");
  assert.equal(
    f.find("auth_challenges", digestSecret(setup.challenge)).passwordVerifiedAt,
    undefined,
  );
  const enrollment = await f.service.enroll({ challenge: setup.challenge });
  const completed = await f.service.completeMfa({
    challenge: setup.challenge,
    code: await totp(enrollment.secret, f.now()),
  });
  assert.equal(completed.needsBackupAcknowledgement, true);
  assert.equal(completed.session.recentVerificationExpiresAt, undefined);
  await rejectsCode(
    () => f.service.workspace(completed.token),
    "backup_acknowledgement_required",
  );
  user.account.roles = ["Clinic Receptionist"];
  await rejectsCode(
    () => f.service.workspace(completed.token),
    "backup_acknowledgement_required",
  );
  assert.equal(
    (await f.service.acknowledge(completed.token)).needsBackupAcknowledgement,
    false,
  );
  assert.ok(
    (await f.service.workspace(completed.token)).permissions.includes(
      "profile:own:view",
    ),
  );
  assert.equal(
    (await f.service.readSession(completed.token)).session
      .recentVerificationExpiresAt,
    undefined,
  );
});

test("interrupted MFA resumes the same pending seed through an actually verified password", async (t) => {
  const f = fixture(t);
  const user = pendingAccount(f, ["System Admin"]);
  const setup = await f.service.assignedAccountSetup({
    username: user.account.username,
    code: user.code,
    password: user.password,
  });
  const first = await f.service.enroll({ challenge: setup.challenge });
  const resumed = await f.service.login({
    username: user.account.username,
    password: user.password,
  });
  const second = await f.service.enroll({ challenge: resumed.challenge });
  assert.equal(first.secret === second.secret, true);
  const complete = await f.service.completeMfa({
    challenge: resumed.challenge,
    code: await totp(second.secret, f.now()),
  });
  const acknowledged = await f.service.acknowledge(complete.token);
  assert.equal(
    acknowledged.session.recentVerificationExpiresAt,
    "2040-10-02T08:05:00.000Z",
  );
});

test("wrong reverification password retains the valid session and its original deadlines", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const session = existingSession(f, user.account);
  const before = deadlines(session.record);
  await rejectsCode(
    () =>
      f.service.reverifyStart(session.token, {
        password: "wrong synthetic password",
      }),
    "verification_failed",
  );
  assert.equal(
    (await f.service.readSession(session.token)).user.id,
    user.account._id,
  );
  assert.deepEqual(deadlines(session.record), before);
  assert.equal(session.record.revokedAt, null);
  assert.equal(
    f.find("auth_throttles", `subject:${digestSecret(user.account.username)}`)
      .failures,
    1,
  );
});

test("new reverification supersedes only pending proof, retains failures, and completion renews no session deadline", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const session = existingSession(f, user.account);
  const before = deadlines(session.record);
  const first = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  await rejectsCode(
    async () =>
      f.service.reverifyComplete(session.token, {
        challenge: first.challenge,
        code: await wrongTotp(user.secret, f.now()),
      }),
    "verification_failed",
  );
  const second = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  assert.equal(
    f.find("auth_challenges", digestSecret(first.challenge)).revocationReason,
    "superseded",
  );
  assert.equal(
    f.find("auth_throttles", `subject:${digestSecret(user.account.username)}`)
      .failures,
    1,
  );
  await rejectsCode(
    async () =>
      f.service.reverifyComplete(session.token, {
        challenge: first.challenge,
        code: await totp(user.secret, f.now()),
      }),
    "verification_failed",
  );
  const result = await f.service.reverifyComplete(session.token, {
    challenge: second.challenge,
    code: await totp(user.secret, f.now()),
  });
  assert.equal(Object.hasOwn(result, "token"), false);
  assert.equal(
    result.session.recentVerificationExpiresAt,
    "2040-10-02T08:05:00.000Z",
  );
  assert.equal(
    f.find("auth_throttles", `subject:${digestSecret(user.account.username)}`)
      .failures,
    2,
  );
  assert.deepEqual(deadlines(session.record), before);
  assert.equal(f.rows("staff_sessions").length, 1);
});

test("reverification challenges are bound to one bearer session and cannot grant proof to another", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const firstSession = existingSession(f, user.account);
  const secondSession = existingSession(f, user.account);
  const challenge = await f.service.reverifyStart(firstSession.token, {
    password: user.password,
  });
  await rejectsCode(
    async () =>
      f.service.reverifyComplete(secondSession.token, {
        challenge: challenge.challenge,
        code: await totp(user.secret, f.now()),
      }),
    "verification_failed",
  );
  const record = f.find("auth_challenges", digestSecret(challenge.challenge));
  assert.equal(record.consumedAt, null);
  assert.equal(record.attempts, 0);
  await f.service.reverifyComplete(firstSession.token, {
    challenge: challenge.challenge,
    code: await totp(user.secret, f.now()),
  });
  assert.ok(firstSession.record.mfaVerifiedAt instanceof Date);
  assert.equal(secondSession.record.mfaVerifiedAt, undefined);
});

test("reverification shares TOTP replay prevention with sign-in and consumes backup codes once", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const login = await f.service.login({
    username: user.account.username,
    password: user.password,
  });
  const code = await totp(user.secret, f.now());
  const session = await f.service.completeMfa({
    challenge: login.challenge,
    code,
  });
  const challenge = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  await rejectsCode(
    () =>
      f.service.reverifyComplete(session.token, {
        challenge: challenge.challenge,
        code,
      }),
    "verification_failed",
  );
  const result = await f.service.reverifyComplete(session.token, {
    challenge: challenge.challenge,
    code: user.backup,
    method: "backup",
  });
  assert.equal(Object.hasOwn(result, "token"), false);
  assert.ok(user.account.mfa.backupCodes[0].usedAt instanceof Date);
  const next = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  await rejectsCode(
    () =>
      f.service.reverifyComplete(session.token, {
        challenge: next.challenge,
        code: user.backup,
        method: "backup",
      }),
    "verification_failed",
  );
  assert.equal(
    f.find("auth_challenges", digestSecret(next.challenge)).consumedAt,
    null,
  );
});

test("immediate backup reverification accepts a matched no-op proof write while consuming factor and challenge", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const session = existingSession(f, user.account, {
    passwordVerifiedAt: f.now(),
    mfaVerifiedAt: f.now(),
    verificationMfaVersion: 1,
  });
  const before = deadlines(session.record);
  const challenge = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  const result = await f.service.reverifyComplete(session.token, {
    challenge: challenge.challenge,
    code: user.backup,
    method: "backup",
  });
  assert.ok(result.session.recentVerificationExpiresAt);
  assert.ok(user.account.mfa.backupCodes[0].usedAt instanceof Date);
  assert.ok(
    f.find("auth_challenges", digestSecret(challenge.challenge))
      .consumedAt instanceof Date,
  );
  assert.deepEqual(deadlines(session.record), before);
  assert.equal(Object.hasOwn(result, "token"), false);
});

test("reverification expires at five minutes, caps failures, and cannot bypass account cooldown", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const session = existingSession(f, user.account);
  const expired = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  f.advance(5 * 60000);
  await rejectsCode(
    async () =>
      f.service.reverifyComplete(session.token, {
        challenge: expired.challenge,
        code: await totp(user.secret, f.now()),
      }),
    "verification_failed",
  );
  const challenge = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  const wrong = await wrongTotp(user.secret, f.now());
  for (let attempt = 0; attempt < 4; attempt += 1)
    await rejectsCode(
      () =>
        f.service.reverifyComplete(session.token, {
          challenge: challenge.challenge,
          code: wrong,
        }),
      "verification_failed",
    );
  await rejectsCode(
    () => f.service.reverifyStart(session.token, { password: user.password }),
    "try_later",
  );
  await rejectsCode(
    async () =>
      f.service.reverifyComplete(session.token, {
        challenge: challenge.challenge,
        code: await totp(user.secret, f.now()),
      }),
    "try_later",
  );
  assert.equal(
    (await f.service.readSession(session.token)).user.id,
    user.account._id,
  );
  assert.equal(
    f.find("auth_challenges", digestSecret(challenge.challenge)).consumedAt,
    null,
  );
});

test("reverification is bounded by original absolute expiry and never revives an expired session", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const session = existingSession(f, user.account);
  session.record.absoluteExpiresAt = new Date(f.now().getTime() + 60000);
  session.record.expiresAt = session.record.absoluteExpiresAt;
  const challenge = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  assert.equal(
    challenge.expiresAt,
    session.record.absoluteExpiresAt.toISOString(),
  );
  f.advance(60000);
  await rejectsCode(
    async () =>
      f.service.reverifyComplete(session.token, {
        challenge: challenge.challenge,
        code: await totp(user.secret, f.now()),
      }),
    "authentication_failed",
  );
  assert.ok(session.record.revokedAt instanceof Date);
  f.rewind(30000);
  await rejectsCode(
    () => f.service.readSession(session.token),
    "authentication_failed",
  );
});

test("account security-version changes invalidate outstanding proof and manager permissions remain authoritative", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const session = existingSession(f, user.account);
  const challenge = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  user.account.version += 1;
  await rejectsCode(
    async () =>
      f.service.reverifyComplete(session.token, {
        challenge: challenge.challenge,
        code: await totp(user.secret, f.now()),
      }),
    "authentication_failed",
  );
  const reception = await activeAccount(f, { roles: ["Clinic Receptionist"] });
  const ordinary = existingSession(f, reception.account);
  await rejectsCode(
    () =>
      f.service.reverifyStart(ordinary.token, { password: reception.password }),
    "permission_denied",
  );
  assert.equal(
    (await f.service.workspace(ordinary.token)).permissions.includes(
      "staff:directory",
    ),
    false,
  );
});

test("reverification audit failure rolls back factor consumption, challenge and proof together", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const session = existingSession(f, user.account);
  const challenge = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  const step = user.account.mfa.lastAcceptedStep;
  const guardRevision = f.find(
    "staff_management_state",
    "staff-controls",
  ).revision;
  const code = await totp(user.secret, f.now());
  f.auditFailure("reverification_completed");
  await assert.rejects(() =>
    f.service.reverifyComplete(session.token, {
      challenge: challenge.challenge,
      code,
    }),
  );
  assert.equal(f.find("accounts", user.account._id).mfa.lastAcceptedStep, step);
  assert.equal(
    f.find("auth_challenges", digestSecret(challenge.challenge)).consumedAt,
    null,
  );
  assert.equal(
    f.find("staff_sessions", session.record._id).mfaVerifiedAt,
    undefined,
  );
  assert.equal(
    f.find("staff_management_state", "staff-controls").revision,
    guardRevision,
  );
  f.auditFailure(undefined);
  assert.ok(
    (
      await f.service.reverifyComplete(session.token, {
        challenge: challenge.challenge,
        code,
      })
    ).session.recentVerificationExpiresAt,
  );
});

test("explicit activity updates idle time but never password/MFA freshness, and logout invalidates reverify", async (t) => {
  const f = fixture(t);
  const user = await activeAccount(f);
  const session = existingSession(f, user.account, {
    passwordVerifiedAt: f.now(),
    mfaVerifiedAt: f.now(),
    verificationMfaVersion: 1,
  });
  const expiry = (await f.service.readSession(session.token)).session
    .recentVerificationExpiresAt;
  f.advance(60000);
  assert.equal(
    (await f.service.activity(session.token)).session
      .recentVerificationExpiresAt,
    expiry,
  );
  const challenge = await f.service.reverifyStart(session.token, {
    password: user.password,
  });
  await f.service.logout(session.token);
  await rejectsCode(
    async () =>
      f.service.reverifyComplete(session.token, {
        challenge: challenge.challenge,
        code: await totp(user.secret, f.now()),
      }),
    "authentication_failed",
  );
});
