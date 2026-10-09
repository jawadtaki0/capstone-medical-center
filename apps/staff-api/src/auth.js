import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import * as argon2 from "argon2";
import { generateSecret, generateURI, verify } from "otplib";
import { StaffError, denied, limited, unavailable } from "./errors.js";
import {
  hasPermission,
  permissionsFor,
  requiresMfa,
  validRoles,
} from "./permissions.js";
import {
  boundedSecret,
  normalizeUsername,
  validatePassword,
  validateProfile,
} from "./validation.js";
import { createManagementService } from "./management.js";
import { createContactService } from "./contacts.js";

export const AUTH_COLLECTIONS = Object.freeze({
  installation: "installation_state",
  accounts: "accounts",
  profiles: "staff_profiles",
  challenges: "auth_challenges",
  sessions: "staff_sessions",
  throttles: "auth_throttles",
  events: "security_events",
  setupCodes: "account_setup_codes",
  managementState: "staff_management_state",
});
export const AUTH_POLICY = Object.freeze({
  idleMs: 10 * 60000,
  absoluteMs: 8 * 60 * 60000,
  challengeMs: 5 * 60000,
  enrollmentMs: 10 * 60000,
  failureWindowMs: 15 * 60000,
  maxFailures: 5,
});

export const AUTH_THROTTLE_POLICIES = Object.freeze({
  account: Object.freeze({
    maxFailures: AUTH_POLICY.maxFailures,
    windowMs: AUTH_POLICY.failureWindowMs,
    cooldownMs: AUTH_POLICY.failureWindowMs,
  }),
  source: Object.freeze({
    maxFailures: 30,
    windowMs: 15 * 60000,
    cooldownMs: 15 * 60000,
  }),
});
const hashOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};
export const digestSecret = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
const normalizeBackup = (value) =>
  boundedSecret(value, 64).replaceAll("-", "").toLowerCase();
const validInstant = (value) =>
  value instanceof Date && Number.isFinite(value.getTime());
const validCounter = (value) => Number.isInteger(value) && value >= 0;
const verificationFailed = () =>
  new StaffError(
    "verification_failed",
    "Verification could not be completed. Check your details or request a new challenge.",
    401,
  );

export function recentVerificationExpiry(record, account, at) {
  if (
    !validInstant(at) ||
    !validInstant(record?.passwordVerifiedAt) ||
    !validInstant(record?.mfaVerifiedAt) ||
    account?.status !== "active" ||
    record.version !== account.version ||
    account.mfa?.enabled !== true ||
    account.mfa.backupAcknowledged !== true ||
    !Number.isInteger(account.mfa.version) ||
    account.mfa.version < 1 ||
    record.verificationMfaVersion !== account.mfa.version ||
    record.passwordVerifiedAt > at ||
    record.mfaVerifiedAt > at
  )
    return null;
  const expiry = new Date(
    Math.min(
      record.passwordVerifiedAt.getTime(),
      record.mfaVerifiedAt.getTime(),
    ) + AUTH_POLICY.challengeMs,
  );
  return expiry > at ? expiry : null;
}

function matchesDigest(value, expected) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))
    return false;
  return timingSafeEqual(
    Buffer.from(digestSecret(value), "hex"),
    Buffer.from(expected, "hex"),
  );
}

function allowFields(input, fields) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !fields.includes(key))
  ) {
    throw new StaffError(
      "invalid_input",
      "Send only the fields supported by this action.",
    );
  }
}

export function createAuthService({
  db,
  client,
  vault,
  clock = () => new Date(),
  contactDelivery,
  testSetupHash,
}) {
  if (!db || !client?.startSession || !vault?.encrypt || !vault?.decrypt)
    throw unavailable();
  // A test-only observer/pause seam is never wired by an HTTP route or server.
  // Refuse it outside the existing isolated synthetic MongoDB target.
  if (testSetupHash !== undefined) {
    const hosts = client?.options?.hosts ?? [];
    if (
      typeof testSetupHash !== "function" ||
      db.databaseName !== "capstone_staff_test" ||
      hosts.length !== 1 ||
      hosts[0].host !== "127.0.0.1" ||
      hosts[0].port !== 27018 ||
      client.options.replicaSet !== "capstoneStaffDev"
    )
      throw unavailable();
  }
  const hashSetupPassword = (password) =>
    (testSetupHash ?? argon2.hash)(password, hashOptions);
  const collection = (key) => db.collection(AUTH_COLLECTIONS[key]);
  const now = () => {
    const value = clock();
    if (!validInstant(value)) throw unavailable();
    return value;
  };
  let dummyHash;
  async function dummyPasswordHash() {
    dummyHash ??= argon2.hash(randomToken(), hashOptions);
    return dummyHash;
  }

  async function transaction(callback) {
    const session = client.startSession();
    try {
      const result = await session.withTransaction(() => callback(session), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      });
      // User failures are returned inside the transaction so attempts/events
      // persist. Throwing inside it would roll those security updates back.
      if (result?.failure) throw result.failure;
      return result;
    } finally {
      await session.endSession();
    }
  }

  async function audit(
    session,
    action,
    accountId = null,
    outcome = "success",
    reason = null,
  ) {
    await collection("events").insertOne(
      {
        _id: randomUUID(),
        occurredAt: now(),
        action,
        accountId,
        outcome,
        ...(reason ? { reason } : {}),
      },
      { session },
    );
  }

  async function guard(session) {
    // ensureIndexes creates this additive singleton before serving. Every
    // eligibility mutation shares its write, so stale snapshot decisions retry.
    const result = await collection("managementState").updateOne(
      { _id: "staff-controls" },
      { $inc: { revision: 1 } },
      { session },
    );
    if (result.modifiedCount !== 1) throw unavailable();
  }

  function throttleBuckets(subject, source) {
    // Retain existing keys and recorded blockedUntil values across restarts;
    // no migration, counter reset or shortened cooldown is necessary.
    return [
      {
        _id: `subject:${digestSecret(subject)}`,
        policy: AUTH_THROTTLE_POLICIES.account,
      },
      {
        _id: `source:${digestSecret(source ?? "unknown")}`,
        policy: AUTH_THROTTLE_POLICIES.source,
      },
    ];
  }
  async function throttleBlocked(session, subject, source, at) {
    for (const { _id } of throttleBuckets(subject, source)) {
      const record = await collection("throttles").findOne(
        { _id },
        { session },
      );
      if (
        record &&
        (!validCounter(record.failures) ||
          !validInstant(record.windowStartedAt) ||
          (record.blockedUntil !== null && !validInstant(record.blockedUntil)))
      )
        throw unavailable();
      if (validInstant(record?.blockedUntil) && record.blockedUntil > at)
        return true;
    }
    return false;
  }
  async function failedAttempts(session, subject, source, at) {
    for (const { _id, policy } of throttleBuckets(subject, source)) {
      const prior = await collection("throttles").findOne({ _id }, { session });
      if (
        prior &&
        (!validCounter(prior.failures) || !validInstant(prior.windowStartedAt))
      )
        throw unavailable();
      const fresh =
        !prior ||
        at.getTime() - prior.windowStartedAt.getTime() >= policy.windowMs;
      const failures = fresh ? 1 : prior.failures + 1;
      const windowStartedAt = fresh ? at : prior.windowStartedAt;
      const blockedUntil =
        failures >= policy.maxFailures
          ? new Date(at.getTime() + policy.cooldownMs)
          : null;
      await collection("throttles").replaceOne(
        { _id },
        {
          _id,
          failures,
          windowStartedAt,
          blockedUntil,
          // TTL is eventual cleanup, not enforcement; retain data through both
          // the observation window and any cooldown started by its final failure.
          expiresAt: new Date(
            at.getTime() + policy.windowMs + policy.cooldownMs,
          ),
        },
        { session, upsert: true },
      );
    }
  }
  async function clearAttempts(session, subject, source) {
    // A successful account does not erase shared source failures for others.
    await collection("throttles").deleteOne(
      { _id: throttleBuckets(subject, source)[0]._id },
      { session },
    );
  }
  async function fail(
    session,
    subject,
    source,
    action,
    accountId,
    at,
    error = denied(),
  ) {
    await failedAttempts(session, subject, source, at);
    await audit(session, action, accountId, "denied", error.code);
    return { failure: error };
  }

  function setupBinding(record, account = null) {
    return {
      id: record._id,
      codeHash: record.codeHash,
      expiresAt: record.expiresAt.getTime(),
      issuedAt: validInstant(record.issuedAt)
        ? record.issuedAt.getTime()
        : null,
      generation: record.generation ?? null,
      accountId: account?._id ?? null,
      accountVersion: account?.version ?? null,
    };
  }
  function sameSetupAuthorization(record, account, binding) {
    const current = setupBinding(record, account);
    return Object.keys(current).every((key) => current[key] === binding[key]);
  }

  async function bootstrapAuthority(session, code, source, at, binding) {
    if (await throttleBlocked(session, "first-admin", source, at))
      return { failure: limited() };
    const marker = await collection("installation").findOne(
      { _id: "first-admin" },
      { session },
    );
    if (
      !marker ||
      marker.status !== "issued" ||
      marker.revokedAt ||
      !validInstant(marker.expiresAt) ||
      marker.expiresAt <= at ||
      !validCounter(marker.attempts) ||
      marker.attempts >= AUTH_POLICY.maxFailures ||
      (binding && !sameSetupAuthorization(marker, null, binding))
    )
      return fail(
        session,
        "first-admin",
        source,
        "bootstrap_rejected",
        null,
        at,
      );
    if (!code || !matchesDigest(code, marker.codeHash)) {
      await collection("installation").updateOne(
        { _id: marker._id },
        { $inc: { attempts: 1 } },
        { session },
      );
      return fail(
        session,
        "first-admin",
        source,
        "bootstrap_rejected",
        null,
        at,
      );
    }
    // Existing accounts make bootstrap inconsistent, not reusable. Check this
    // before hashing and again after hashing; never reconstruct installation.
    if (await collection("accounts").findOne({}, { session }))
      throw unavailable();
    return { marker, binding: setupBinding(marker) };
  }

  async function assignedSetupAuthority(
    session,
    username,
    code,
    source,
    at,
    binding,
  ) {
    if (await throttleBlocked(session, username, source, at))
      return { failure: limited() };
    const account = await collection("accounts").findOne(
      { username },
      { session },
    );
    const setup = account
      ? await collection("setupCodes").findOne(
          { _id: account._id },
          { session },
        )
      : null;
    if (
      !account ||
      !validRoles(account.roles) ||
      !Number.isInteger(account.version) ||
      account.version < 1 ||
      account.status !== "setup_pending" ||
      account.passwordHash ||
      account.mfa?.enabled === true ||
      !setup ||
      setup.accountId !== account._id ||
      setup.accountVersion !== account.version ||
      !Number.isInteger(setup.generation) ||
      setup.generation < 1 ||
      setup.consumedAt !== null ||
      setup.revokedAt ||
      !validInstant(setup.issuedAt) ||
      setup.issuedAt > at ||
      !validInstant(setup.expiresAt) ||
      setup.expiresAt <= at ||
      !validCounter(setup.attempts) ||
      setup.attempts >= AUTH_POLICY.maxFailures ||
      (binding && !sameSetupAuthorization(setup, account, binding))
    )
      return fail(
        session,
        username,
        source,
        "assigned_setup_rejected",
        account?._id,
        at,
      );
    if (!code || !matchesDigest(code, setup.codeHash)) {
      const changed = await collection("setupCodes").updateOne(
        {
          _id: setup._id,
          accountVersion: account.version,
          generation: setup.generation,
          consumedAt: null,
          attempts: setup.attempts,
        },
        { $inc: { attempts: 1 } },
        { session },
      );
      if (changed.modifiedCount !== 1) throw unavailable();
      return fail(
        session,
        username,
        source,
        "assigned_setup_rejected",
        account._id,
        at,
      );
    }
    return { account, setup, binding: setupBinding(setup, account) };
  }

  function usableAccount(account, challenge = false) {
    return (
      account &&
      validRoles(account.roles) &&
      Number.isInteger(account.version) &&
      account.version >= 1 &&
      (account.status === "active" ||
        (challenge && account.status === "mfa_pending"))
    );
  }
  async function issueChallenge(session, account, purpose, at, metadata = {}) {
    const challenge = randomToken();
    const expiresAt =
      metadata.expiresAt ??
      new Date(
        at.getTime() +
          (purpose === "enroll"
            ? AUTH_POLICY.enrollmentMs
            : AUTH_POLICY.challengeMs),
      );
    await collection("challenges").insertOne(
      {
        _id: digestSecret(challenge),
        accountId: account._id,
        version: account.version,
        purpose,
        createdAt: at,
        expiresAt,
        attempts: 0,
        consumedAt: null,
        ...metadata,
      },
      { session },
    );
    return {
      challenge,
      kind: purpose,
      expiresAt: expiresAt.toISOString(),
      serverNow: at.toISOString(),
    };
  }
  async function challengeContext(session, token, source, at, expected) {
    const text = boundedSecret(token);
    const challenge = text
      ? await collection("challenges").findOne(
          { _id: digestSecret(text) },
          { session },
        )
      : null;
    const account = challenge
      ? await collection("accounts").findOne(
          { _id: challenge.accountId },
          { session },
        )
      : null;
    const subject =
      account?.username ?? `unknown-challenge:${digestSecret(text)}`;
    if (await throttleBlocked(session, subject, source, at))
      return { failure: limited() };
    if (
      !challenge ||
      !account ||
      !usableAccount(account, true) ||
      challenge.version !== account.version ||
      challenge.consumedAt ||
      challenge.revokedAt ||
      !validInstant(challenge.expiresAt) ||
      challenge.expiresAt <= at ||
      !validCounter(challenge.attempts) ||
      challenge.attempts >= AUTH_POLICY.maxFailures ||
      !expected.includes(challenge.purpose)
    ) {
      return fail(
        session,
        subject,
        source,
        "challenge_rejected",
        account?._id,
        at,
      );
    }
    return { challenge, account, subject };
  }
  async function challengeFailure(session, context, source, at) {
    await collection("challenges").updateOne(
      { _id: context.challenge._id },
      { $inc: { attempts: 1 } },
      { session },
    );
    return fail(
      session,
      context.subject,
      source,
      "mfa_rejected",
      context.account._id,
      at,
    );
  }

  async function profileFor(session, account) {
    const profile = await collection("profiles").findOne(
      { accountId: account._id },
      { session },
    );
    if (
      !profile ||
      typeof profile.firstName !== "string" ||
      !profile.firstName.trim() ||
      typeof profile.lastName !== "string" ||
      !profile.lastName.trim()
    )
      throw unavailable();
    return profile;
  }
  function sessionPayload(account, profile, record, at) {
    const idle = Math.min(
      record.lastActivityAt.getTime() + AUTH_POLICY.idleMs,
      record.absoluteExpiresAt.getTime(),
    );
    const recentExpiry = recentVerificationExpiry(record, account, at);
    return {
      user: {
        id: account._id,
        username: account.username,
        roles: [...account.roles],
        name: `${profile.firstName} ${profile.lastName}`,
      },
      session: {
        idleExpiresAt: new Date(idle).toISOString(),
        absoluteExpiresAt: record.absoluteExpiresAt.toISOString(),
        serverNow: at.toISOString(),
        ...(recentExpiry
          ? { recentVerificationExpiresAt: recentExpiry.toISOString() }
          : {}),
      },
      needsBackupAcknowledgement:
        account.mfa?.enabled === true &&
        account.mfa?.backupAcknowledged !== true,
    };
  }
  async function newSession(session, account, at, proof = {}) {
    const token = randomToken();
    const record = {
      _id: digestSecret(token),
      accountId: account._id,
      version: account.version,
      createdAt: at,
      lastActivityAt: at,
      absoluteExpiresAt: new Date(at.getTime() + AUTH_POLICY.absoluteMs),
      expiresAt: new Date(at.getTime() + AUTH_POLICY.absoluteMs),
      revokedAt: null,
      ...(validInstant(proof.passwordVerifiedAt)
        ? { passwordVerifiedAt: proof.passwordVerifiedAt }
        : {}),
      ...(validInstant(proof.mfaVerifiedAt)
        ? {
            mfaVerifiedAt: proof.mfaVerifiedAt,
            verificationMfaVersion: account.mfa.version,
          }
        : {}),
    };
    await collection("sessions").insertOne(record, { session });
    return {
      token,
      ...sessionPayload(
        account,
        await profileFor(session, account),
        record,
        at,
      ),
    };
  }
  async function authenticated(session, token, at, allowPending = false) {
    const text = boundedSecret(token);
    const record = text
      ? await collection("sessions").findOne(
          { _id: digestSecret(text) },
          { session },
        )
      : null;
    const account = record
      ? await collection("accounts").findOne(
          { _id: record.accountId },
          { session },
        )
      : null;
    if (!record || record.revokedAt) throw denied();
    let rejection;
    if (
      !usableAccount(account) ||
      (requiresMfa(account.roles) && account.mfa?.enabled !== true)
    )
      rejection = "account_unavailable";
    else if (record.version !== account.version)
      rejection = "security_version_changed";
    else if (
      !validInstant(record.lastActivityAt) ||
      !validInstant(record.absoluteExpiresAt)
    )
      rejection = "invalid_session";
    else if (record.absoluteExpiresAt <= at) rejection = "absolute_expired";
    else if (
      record.lastActivityAt.getTime() + AUTH_POLICY.idleMs <=
      at.getTime()
    )
      rejection = "idle_expired";
    if (rejection) {
      await guard(session);
      const revoked = await collection("sessions").updateOne(
        { _id: record._id, revokedAt: null },
        {
          $set: { revokedAt: at, revocationReason: rejection },
        },
        { session },
      );
      // A permanent revocation writes one event, not one for every subsequent
      // status poll. Return the failure so transaction commit retains the audit.
      if (revoked.modifiedCount === 1)
        await audit(
          session,
          "session_rejected",
          record.accountId,
          "denied",
          rejection,
        );
      return { failure: denied() };
    }
    if (
      validInstant(record.passwordVerifiedAt) &&
      validInstant(record.mfaVerifiedAt) &&
      (record.passwordVerifiedAt > at ||
        record.mfaVerifiedAt > at ||
        Math.min(
          record.passwordVerifiedAt.getTime(),
          record.mfaVerifiedAt.getTime(),
        ) +
          AUTH_POLICY.challengeMs <=
          at.getTime() ||
        record.verificationMfaVersion !== account.mfa?.version)
    ) {
      await guard(session);
      await collection("sessions").updateOne(
        { _id: record._id, version: account.version, revokedAt: null },
        {
          $unset: {
            passwordVerifiedAt: "",
            mfaVerifiedAt: "",
            verificationMfaVersion: "",
          },
        },
        { session },
      );
      delete record.passwordVerifiedAt;
      delete record.mfaVerifiedAt;
      delete record.verificationMfaVersion;
    }
    if (
      !allowPending &&
      account.mfa?.enabled === true &&
      account.mfa.backupAcknowledged !== true
    ) {
      throw new StaffError(
        "backup_acknowledgement_required",
        "Acknowledge the private backup-code information before entering the workspace.",
        403,
      );
    }
    return { account, record, profile: await profileFor(session, account) };
  }

  const management = createManagementService({
    db,
    collection,
    transaction,
    now,
    authenticated,
    audit,
    vault,
    failedAttempts,
    throttleBlocked,
    clearAttempts,
    digestSecret,
    guard,
    requiresMfa,
    recentVerificationExpiry,
  });
  async function consumeContactFactor(session, account, method, code, at) {
    let filter = {
        _id: account._id,
        version: account.version,
        status: "active",
        "mfa.version": account.mfa.version,
      },
      update;
    if (method === "totp") {
      const result = /^\d{6}$/.test(code)
        ? await verify({
            secret: vault.decrypt(account.mfa.secretCipher),
            token: code,
            epoch: Math.floor(+at / 1000),
            epochTolerance: 30,
            ...(Number.isInteger(account.mfa.lastAcceptedStep)
              ? { afterTimeStep: account.mfa.lastAcceptedStep }
              : {}),
          })
        : { valid: false };
      if (!result.valid) return false;
      filter = { ...filter, "mfa.lastAcceptedStep": { $lt: result.timeStep } };
      update = { $set: { "mfa.lastAcceptedStep": result.timeStep } };
    } else {
      const canonical = normalizeBackup(code),
        digest = digestSecret(canonical);
      if (
        !/^[a-f0-9]{32}$/.test(canonical) ||
        !account.mfa.backupCodes?.some(
          (item) =>
            item.usedAt === null && matchesDigest(canonical, item.digest),
        )
      )
        return false;
      filter = {
        ...filter,
        "mfa.backupCodes": { $elemMatch: { digest, usedAt: null } },
      };
      update = { $set: { "mfa.backupCodes.$.usedAt": at } };
    }
    return (
      (await collection("accounts").updateOne(filter, update, { session }))
        .modifiedCount === 1
    );
  }
  const contacts = createContactService({
    db,
    client,
    vault,
    transaction,
    guard,
    authenticated,
    now,
    checkPassword: (account, password) =>
      argon2.verify(account.passwordHash, password),
    consumeFactor: consumeContactFactor,
    requiresMfa,
    delivery: contactDelivery,
    recentVerificationExpiry,
  });

  return {
    management,
    contacts,
    async health() {
      await db.command({ ping: 1 });
      return {
        status: "ok",
        service: "medical-center-staff-api",
        database: "connected",
        serverNow: now().toISOString(),
      };
    },
    async setupStatus() {
      const marker = await collection("installation").findOne({
        _id: "first-admin",
      });
      return {
        available: Boolean(
          marker?.status === "issued" &&
          validInstant(marker.expiresAt) &&
          marker.expiresAt > now() &&
          validCounter(marker.attempts) &&
          marker.attempts < AUTH_POLICY.maxFailures,
        ),
      };
    },
    async claimSetup(input, source = "local") {
      const username = normalizeUsername(input?.username);
      const password = validatePassword(input?.password, { username });
      const profile = validateProfile(
        input?.profile,
        now().toISOString().slice(0, 10),
      );
      const code = boundedSecret(input?.code);
      const authorization = await transaction(async (session) => {
        await guard(session);
        return bootstrapAuthority(session, code, source, now());
      });
      // The short precheck records refusals but never consumes authorization.
      // Hash only eligible input, outside MongoDB's retryable transaction.
      const passwordHash = await hashSetupPassword(password);
      try {
        return await transaction(async (session) => {
          await guard(session);
          const at = now();
          const checked = await bootstrapAuthority(
            session,
            code,
            source,
            at,
            authorization.binding,
          );
          if (checked.failure) return checked;
          const accountId = `account:${randomUUID()}`;
          const account = {
            _id: accountId,
            username,
            passwordHash,
            roles: ["Admin"],
            status: "mfa_pending",
            version: 1,
            createdAt: at,
            mfa: null,
          };
          await collection("accounts").insertOne(account, { session });
          await collection("profiles").insertOne(
            {
              _id: `profile:${randomUUID()}`,
              accountId,
              ...profile,
              createdAt: at,
            },
            { session },
          );
          const claim = await collection("installation").updateOne(
            { _id: "first-admin", status: "issued" },
            {
              $set: {
                status: "claimed",
                firstAccountId: accountId,
                claimedAt: at,
              },
              $unset: { codeHash: "" },
            },
            { session },
          );
          if (claim.modifiedCount !== 1) throw unavailable();
          await clearAttempts(session, "first-admin", source);
          await audit(session, "bootstrap_claimed", accountId);
          return issueChallenge(session, account, "enroll", at);
        });
      } catch (error) {
        if (error?.code === 11000)
          throw new StaffError(
            "username_unavailable",
            "That username is unavailable. Choose another username.",
          );
        throw error;
      }
    },
    async login(input, source = "local") {
      const username = normalizeUsername(input?.username);
      const password = boundedSecret(input?.password, 512);
      return transaction(async (session) => {
        const at = now();
        if (await throttleBlocked(session, username, source, at))
          return { failure: limited() };
        await guard(session);
        const account = await collection("accounts").findOne(
          { username },
          { session },
        );
        const passwordMatch = await argon2.verify(
          account?.passwordHash ?? (await dummyPasswordHash()),
          password,
        );
        if (!passwordMatch || !usableAccount(account, true))
          return fail(
            session,
            username,
            source,
            "password_rejected",
            account?._id,
            at,
          );
        const passwordVerifiedAt = now();
        if (requiresMfa(account.roles)) {
          const purpose = account.mfa?.enabled === true ? "mfa" : "enroll";
          await audit(session, "password_verified", account._id);
          return issueChallenge(session, account, purpose, passwordVerifiedAt, {
            passwordVerifiedAt,
          });
        }
        if (account.status !== "active")
          return fail(
            session,
            username,
            source,
            "password_rejected",
            account._id,
            at,
          );
        await clearAttempts(session, username, source);
        await audit(session, "sign_in", account._id);
        return newSession(session, account, passwordVerifiedAt, {
          passwordVerifiedAt,
        });
      });
    },
    async assignedAccountSetup(input, source = "local") {
      allowFields(input, ["username", "code", "password"]);
      const username = normalizeUsername(input.username);
      const password = validatePassword(input.password, { username });
      const code = boundedSecret(input.code, 128);
      const authorization = await transaction(async (session) => {
        await guard(session);
        return assignedSetupAuthority(session, username, code, source, now());
      });
      const passwordHash = await hashSetupPassword(password);
      return transaction(async (session) => {
        await guard(session);
        const at = now();
        const checked = await assignedSetupAuthority(
          session,
          username,
          code,
          source,
          at,
          authorization.binding,
        );
        if (checked.failure) return checked;
        const { account, setup } = checked;
        const consumed = await collection("setupCodes").updateOne(
          {
            _id: setup._id,
            accountVersion: account.version,
            generation: setup.generation,
            codeHash: setup.codeHash,
            consumedAt: null,
          },
          { $set: { consumedAt: at } },
          { session },
        );
        if (consumed.modifiedCount !== 1) throw unavailable();
        const status = requiresMfa(account.roles) ? "mfa_pending" : "active";
        const changed = await collection("accounts").updateOne(
          {
            _id: account._id,
            version: account.version,
            status: "setup_pending",
          },
          {
            $set: { passwordHash, status, passwordSetAt: at },
            $inc: { version: 1 },
          },
          { session },
        );
        if (changed.modifiedCount !== 1) throw unavailable();
        account.passwordHash = passwordHash;
        account.status = status;
        account.version += 1;
        await audit(session, "assigned_password_set", account._id);
        // Selecting a password is not proof of verifying the stored password.
        // Preserve failures through setup and pending MFA; no replacement reset.
        return requiresMfa(account.roles)
          ? issueChallenge(session, account, "enroll", at)
          : newSession(session, account, at);
      });
    },
    async enroll(input, source = "local") {
      return transaction(async (session) => {
        await guard(session);
        const context = await challengeContext(
          session,
          input?.challenge,
          source,
          now(),
          ["enroll"],
        );
        if (context.failure) return context;
        const { account, challenge } = context;
        if (
          account.status !== "mfa_pending" ||
          !requiresMfa(account.roles) ||
          account.mfa?.enabled
        )
          return challengeFailure(session, context, source, now());
        // Pending enrollment survives an app restart/password-based resume.
        // Repeated enrollment never silently changes an already scanned secret.
        let secretCipher =
          account.pendingMfaSecretCipher ?? challenge.secretCipher;
        let secret;
        if (secretCipher) secret = await vault.decrypt(secretCipher);
        else {
          secret = generateSecret();
          secretCipher = await vault.encrypt(secret);
        }
        if (!account.pendingMfaSecretCipher)
          await collection("accounts").updateOne(
            {
              _id: account._id,
              version: account.version,
              status: "mfa_pending",
            },
            { $set: { pendingMfaSecretCipher: secretCipher } },
            { session },
          );
        if (!challenge.secretCipher)
          await collection("challenges").updateOne(
            { _id: challenge._id },
            {
              $set: { secretCipher },
            },
            { session },
          );
        return {
          secret,
          otpauthUri: generateURI({
            issuer: "Cedar Staff",
            label: account.username,
            secret,
          }),
        };
      });
    },
    async completeMfa(input, source = "local") {
      return transaction(async (session) => {
        await guard(session);
        const at = now();
        const context = await challengeContext(
          session,
          input?.challenge,
          source,
          at,
          ["enroll", "mfa"],
        );
        if (context.failure) return context;
        const { account, challenge } = context;
        const enrolling = challenge.purpose === "enroll";
        if (
          !requiresMfa(account.roles) ||
          (enrolling
            ? account.status !== "mfa_pending" ||
              account.mfa?.enabled ||
              !challenge.secretCipher
            : account.status !== "active" || !account.mfa?.enabled)
        )
          return challengeFailure(session, context, source, at);
        const secretCipher = enrolling
          ? challenge.secretCipher
          : account.mfa.secretCipher;
        const secret = await vault.decrypt(secretCipher);
        const code = boundedSecret(input?.code, 6);
        let verification = { valid: false };
        if (/^\d{6}$/.test(code))
          verification = await verify({
            secret,
            token: code,
            epoch: Math.floor(at.getTime() / 1000),
            epochTolerance: 30,
            ...(!enrolling && Number.isInteger(account.mfa.lastAcceptedStep)
              ? { afterTimeStep: account.mfa.lastAcceptedStep }
              : {}),
          });
        if (!verification.valid)
          return challengeFailure(session, context, source, at);
        let backupCodes;
        let update;
        let filter = {
          _id: account._id,
          version: account.version,
          status: account.status,
        };
        if (enrolling) {
          backupCodes = Array.from({ length: 10 }, () =>
            randomBytes(16).toString("hex").match(/.{4}/g).join("-"),
          );
          const mfa = {
            enabled: true,
            version: 1,
            secretCipher,
            lastAcceptedStep: verification.timeStep,
            backupAcknowledged: false,
            backupCodes: backupCodes.map((codeValue) => ({
              digest: digestSecret(normalizeBackup(codeValue)),
              usedAt: null,
            })),
          };
          account.status = "active";
          account.mfa = mfa;
          update = {
            $set: { status: "active", mfa },
            $unset: { pendingMfaSecretCipher: "" },
          };
        } else {
          filter = {
            ...filter,
            "mfa.version": account.mfa.version,
            "mfa.lastAcceptedStep": { $lt: verification.timeStep },
          };
          update = { $set: { "mfa.lastAcceptedStep": verification.timeStep } };
        }
        const changed = await collection("accounts").updateOne(filter, update, {
          session,
        });
        if (changed.modifiedCount !== 1)
          return challengeFailure(session, context, source, at);
        const consumed = await collection("challenges").updateOne(
          { _id: challenge._id, consumedAt: null },
          { $set: { consumedAt: at } },
          { session },
        );
        if (consumed.modifiedCount !== 1) throw unavailable();
        if (enrolling)
          await collection("installation").updateOne(
            {
              _id: "first-admin",
              firstAccountId: account._id,
              status: "claimed",
            },
            {
              $set: { status: "mfa_enrolled", mfaEnrolledAt: at },
            },
            { session },
          );
        await clearAttempts(session, account.username, source);
        await audit(
          session,
          enrolling ? "mfa_enrolled" : "sign_in",
          account._id,
        );
        return {
          ...(await newSession(session, account, at, {
            passwordVerifiedAt: challenge.passwordVerifiedAt,
            mfaVerifiedAt: at,
          })),
          ...(backupCodes ? { backupCodes } : {}),
        };
      });
    },
    async useBackup(input, source = "local") {
      return transaction(async (session) => {
        await guard(session);
        const at = now();
        const context = await challengeContext(
          session,
          input?.challenge,
          source,
          at,
          ["mfa"],
        );
        if (context.failure) return context;
        const { account, challenge } = context;
        const candidate = normalizeBackup(input?.code);
        const digest = digestSecret(candidate);
        const code = account.mfa?.backupCodes?.find(
          (item) =>
            item.usedAt === null && matchesDigest(candidate, item.digest),
        );
        if (
          account.status !== "active" ||
          !requiresMfa(account.roles) ||
          !account.mfa?.enabled ||
          !code ||
          !/^[a-f0-9]{32}$/.test(candidate)
        ) {
          return challengeFailure(session, context, source, at);
        }
        const used = await collection("accounts").updateOne(
          {
            _id: account._id,
            version: account.version,
            status: "active",
            "mfa.version": account.mfa.version,
            "mfa.backupCodes": { $elemMatch: { digest, usedAt: null } },
          },
          {
            $set: { "mfa.backupCodes.$.usedAt": at },
          },
          { session },
        );
        if (used.modifiedCount !== 1)
          return challengeFailure(session, context, source, at);
        const consumed = await collection("challenges").updateOne(
          { _id: challenge._id, consumedAt: null },
          { $set: { consumedAt: at } },
          { session },
        );
        if (consumed.modifiedCount !== 1) throw unavailable();
        await clearAttempts(session, account.username, source);
        await audit(session, "backup_code_used", account._id);
        return newSession(session, account, at, {
          passwordVerifiedAt: challenge.passwordVerifiedAt,
          mfaVerifiedAt: at,
        });
      });
    },
    async reverifyStart(token, input, source = "local") {
      allowFields(input, ["password"]);
      const password = boundedSecret(input.password, 512);
      return transaction(async (session) => {
        await guard(session);
        const at = now();
        const context = await authenticated(session, token, at);
        if (context.failure) return context;
        const { account, record } = context;
        if (
          !account.roles.some((role) =>
            ["Admin", "System Admin"].includes(role),
          )
        ) {
          throw new StaffError(
            "permission_denied",
            "Staff management requires an authorized manager.",
            403,
          );
        }
        if (await throttleBlocked(session, account.username, source, at))
          return { failure: limited() };
        if (
          !(await argon2.verify(
            account.passwordHash ?? (await dummyPasswordHash()),
            password,
          ))
        ) {
          return fail(
            session,
            account.username,
            source,
            "reverification_rejected",
            account._id,
            at,
            verificationFailed(),
          );
        }
        if (
          account.mfa?.enabled !== true ||
          !Number.isInteger(account.mfa.version) ||
          account.mfa.version < 1
        )
          throw unavailable();
        const passwordVerifiedAt = now();
        await collection("challenges").updateMany(
          {
            accountId: account._id,
            sessionId: record._id,
            purpose: "reverify",
            consumedAt: null,
            revokedAt: null,
          },
          {
            $set: {
              revokedAt: passwordVerifiedAt,
              revocationReason: "superseded",
            },
          },
          { session },
        );
        await audit(session, "reverification_password_verified", account._id);
        // Issuing another challenge never clears accumulated failure buckets.
        return issueChallenge(
          session,
          account,
          "reverify",
          passwordVerifiedAt,
          {
            sessionId: record._id,
            mfaVersion: account.mfa.version,
            passwordVerifiedAt,
            revokedAt: null,
            expiresAt: new Date(
              Math.min(
                passwordVerifiedAt.getTime() + AUTH_POLICY.challengeMs,
                record.absoluteExpiresAt.getTime(),
              ),
            ),
          },
        );
      });
    },
    async reverifyComplete(token, input, source = "local") {
      allowFields(input, ["challenge", "code", "method"]);
      const method = input.method ?? "totp";
      if (!["totp", "backup"].includes(method))
        throw new StaffError(
          "invalid_input",
          "Choose authenticator or backup-code verification.",
        );
      const text = boundedSecret(input.challenge);
      const code = boundedSecret(input.code, 128);
      return transaction(async (session) => {
        await guard(session);
        const at = now();
        const context = await authenticated(session, token, at);
        if (context.failure) return context;
        const { account, record, profile } = context;
        if (
          !account.roles.some((role) =>
            ["Admin", "System Admin"].includes(role),
          )
        ) {
          throw new StaffError(
            "permission_denied",
            "Staff management requires an authorized manager.",
            403,
          );
        }
        if (await throttleBlocked(session, account.username, source, at))
          return { failure: limited() };
        const challenge = text
          ? await collection("challenges").findOne(
              { _id: digestSecret(text) },
              { session },
            )
          : null;
        if (
          !challenge ||
          challenge.purpose !== "reverify" ||
          challenge.accountId !== account._id ||
          challenge.sessionId !== record._id ||
          challenge.version !== account.version ||
          challenge.mfaVersion !== account.mfa?.version ||
          account.mfa?.enabled !== true ||
          challenge.consumedAt ||
          challenge.revokedAt ||
          !validInstant(challenge.createdAt) ||
          challenge.createdAt > at ||
          !validInstant(challenge.passwordVerifiedAt) ||
          challenge.passwordVerifiedAt > at ||
          !validInstant(challenge.expiresAt) ||
          challenge.expiresAt <= at ||
          !validCounter(challenge.attempts) ||
          challenge.attempts >= AUTH_POLICY.maxFailures
        ) {
          return fail(
            session,
            account.username,
            source,
            "reverification_rejected",
            account._id,
            at,
            verificationFailed(),
          );
        }
        const rejectFactor = async () => {
          const changed = await collection("challenges").updateOne(
            {
              _id: challenge._id,
              sessionId: record._id,
              consumedAt: null,
              revokedAt: null,
              attempts: challenge.attempts,
            },
            { $inc: { attempts: 1 } },
            { session },
          );
          if (changed.modifiedCount !== 1) throw unavailable();
          return fail(
            session,
            account.username,
            source,
            "reverification_rejected",
            account._id,
            at,
            verificationFailed(),
          );
        };
        let update;
        let filter = {
          _id: account._id,
          version: account.version,
          status: "active",
          "mfa.version": account.mfa.version,
        };
        if (method === "totp") {
          const secret = await vault.decrypt(account.mfa.secretCipher);
          const verification = /^\d{6}$/.test(code)
            ? await verify({
                secret,
                token: code,
                epoch: Math.floor(at.getTime() / 1000),
                epochTolerance: 30,
                ...(Number.isInteger(account.mfa.lastAcceptedStep)
                  ? { afterTimeStep: account.mfa.lastAcceptedStep }
                  : {}),
              })
            : { valid: false };
          if (!verification.valid) return rejectFactor();
          filter = {
            ...filter,
            "mfa.lastAcceptedStep": { $lt: verification.timeStep },
          };
          update = { $set: { "mfa.lastAcceptedStep": verification.timeStep } };
        } else {
          const canonical = normalizeBackup(code);
          const digest = digestSecret(canonical);
          if (
            !/^[a-f0-9]{32}$/.test(canonical) ||
            !account.mfa.backupCodes?.some(
              (item) =>
                item.usedAt === null && matchesDigest(canonical, item.digest),
            )
          ) {
            return rejectFactor();
          }
          filter = {
            ...filter,
            "mfa.backupCodes": { $elemMatch: { digest, usedAt: null } },
          };
          update = { $set: { "mfa.backupCodes.$.usedAt": at } };
        }
        if (
          (await collection("accounts").updateOne(filter, update, { session }))
            .modifiedCount !== 1
        )
          return rejectFactor();
        const consumed = await collection("challenges").updateOne(
          {
            _id: challenge._id,
            sessionId: record._id,
            version: account.version,
            consumedAt: null,
            revokedAt: null,
          },
          { $set: { consumedAt: at } },
          { session },
        );
        if (consumed.modifiedCount !== 1) throw unavailable();
        const proof = {
          passwordVerifiedAt: challenge.passwordVerifiedAt,
          mfaVerifiedAt: at,
          verificationMfaVersion: account.mfa.version,
        };
        // A valid recent login and immediate reverify can have identical factor
        // timestamps. The version-bound session must match, but a no-op proof
        // write is legitimate; factor/challenge consumption remains strict.
        if (
          (
            await collection("sessions").updateOne(
              { _id: record._id, version: account.version, revokedAt: null },
              { $set: proof },
              { session },
            )
          ).matchedCount !== 1
        ) {
          throw unavailable();
        }
        Object.assign(record, proof);
        await audit(
          session,
          "reverification_completed",
          account._id,
          "success",
          method,
        );
        return sessionPayload(account, profile, record, at);
      });
    },
    async acknowledge(token) {
      return transaction(async (session) => {
        await guard(session);
        const at = now();
        const context = await authenticated(session, token, at, true);
        if (context.failure) return context;
        const { account, record } = context;
        if (account.mfa?.enabled !== true) throw denied();
        if (account.mfa.backupAcknowledged !== true) {
          await collection("accounts").updateOne(
            {
              _id: account._id,
              version: account.version,
              status: "active",
              "mfa.version": account.mfa.version,
            },
            {
              $set: { "mfa.backupAcknowledged": true },
            },
            { session },
          );
          await collection("installation").updateOne(
            {
              _id: "first-admin",
              firstAccountId: account._id,
              status: "mfa_enrolled",
            },
            {
              $set: { status: "completed", completedAt: at },
            },
            { session },
          );
          await audit(session, "backup_codes_acknowledged", account._id);
          account.mfa.backupAcknowledged = true;
        }
        return sessionPayload(
          account,
          await profileFor(session, account),
          record,
          at,
        );
      });
    },
    async readSession(token) {
      return transaction(async (session) => {
        const at = now();
        const context = await authenticated(session, token, at, true);
        if (context.failure) return context;
        const { account, profile, record } = context;
        return sessionPayload(account, profile, record, at);
      });
    },
    async activity(token) {
      return transaction(async (session) => {
        await guard(session);
        const at = now();
        const context = await authenticated(session, token, at);
        if (context.failure) return context;
        const { account, profile, record } = context;
        // Only this explicitly invoked route advances server activity. GETs,
        // health polling, timers and expired sessions cannot renew a session.
        await collection("sessions").updateOne(
          { _id: record._id, version: account.version, revokedAt: null },
          { $set: { lastActivityAt: at } },
          { session },
        );
        record.lastActivityAt = at;
        return sessionPayload(account, profile, record, at);
      });
    },
    async logout(token) {
      return transaction(async (session) => {
        await guard(session);
        const at = now();
        const context = await authenticated(session, token, at, true);
        if (context.failure) return context;
        const { account, record } = context;
        await collection("sessions").updateOne(
          { _id: record._id },
          { $set: { revokedAt: at } },
          { session },
        );
        await audit(session, "sign_out", account._id);
        return { signedOut: true };
      });
    },
    async workspace(token) {
      return transaction(async (session) => {
        const context = await authenticated(session, token, now());
        if (context.failure) return context;
        const { account } = context;
        if (!hasPermission(account.roles, "workspace:view"))
          throw new StaffError(
            "permission_denied",
            "You do not have access to this workspace.",
            403,
          );
        return {
          heading: "Staff workspace",
          description:
            "Staff access foundation. Operational workflows are not implemented yet.",
          roles: [...account.roles],
          permissions: permissionsFor(account.roles),
        };
      });
    },
  };
}
