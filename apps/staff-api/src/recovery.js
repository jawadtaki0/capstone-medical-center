import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import * as argon2 from "argon2";
import { generateSecret, generateURI, verify } from "otplib";
import { StaffError, unavailable } from "./errors.js";
import { normalizeUsername, boundedSecret } from "./validation.js";
import { validRoles, requiresMfa } from "./permissions.js";
import { reservesEmail } from "./contact-status.js";
import { normalizeEmail } from "./contact-delivery.js";
import { passwordChangeInput, passwordProcessGate } from "./password-change.js";
import {
  archiveCurrentPassword,
  checkRecordedPasswords,
  revokeCredentialAuthorities,
} from "./password-history.js";

export const RECOVERY_POLICY = Object.freeze({
  codeMs: 600000,
  grantMs: 300000,
  enrollmentMs: 600000,
  assistedMs: 1800000,
  windowMs: 900000,
  cooldownMs: 900000,
  failures: 5,
  sourceSubmissions: 30,
  resendMs: 60000,
  resends: 2,
});
export const RECOVERY_MESSAGE =
  "If this account is eligible, an email with recovery instructions will be sent. Otherwise, contact an authorized Admin.";
const token = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const instant = (value) => value instanceof Date && Number.isFinite(+value);
const fault = (code, message, status = 409) =>
  new StaffError(`recovery_${code}`, message, status);
const expired = () =>
  fault(
    "expired",
    "Recovery authorization expired or is no longer valid. Start again.",
  );
const rejected = () =>
  fault(
    "failed",
    "Recovery could not be verified. Check the details or contact an authorized Admin.",
    401,
  );
const limited = () =>
  fault(
    "cooldown",
    "Recovery is temporarily limited. Wait 15 minutes; ordinary sign-in is unaffected.",
    429,
  );
function fields(input, allowed) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw new StaffError(
      "invalid_input",
      "Send only the fields supported by this recovery action.",
    );
}
function opaque(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
function equal(left, right) {
  return (
    typeof right === "string" &&
    /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

// Restricted grants are never staff sessions. All state-changing decisions share
// the existing transaction guard with account management and contact release.
export function createRecoveryService({
  db,
  client,
  vault,
  transaction,
  guard,
  authenticated,
  now,
  consumeFactor,
  recentVerificationExpiry,
  deliverySupport,
  hashOptions,
  testWork,
}) {
  if (
    testWork !== undefined &&
    (typeof testWork !== "function" ||
      db.databaseName !== "capstone_staff_test" ||
      client.options?.hosts?.length !== 1 ||
      client.options.hosts[0].host !== "127.0.0.1" ||
      client.options.hosts[0].port !== 27018 ||
      client.options.replicaSet !== "capstoneStaffDev")
  )
    throw unavailable();
  const records = () => db.collection("staff_recovery_requests"),
    counters = () => db.collection("staff_recovery_counters"),
    cases = () => db.collection("staff_recovery_cases"),
    accounts = () => db.collection("accounts");
  const testing = db.databaseName === "capstone_staff_test";
  const provider = () => deliverySupport.providerFor("email");
  const seal = (...parts) => vault.contactDigest(JSON.stringify(parts));
  async function event(
    session,
    action,
    accountId,
    actorId = null,
    outcome = "allowed",
  ) {
    await db.collection("security_events").insertOne(
      {
        _id: randomUUID(),
        occurredAt: now(),
        action: `recovery_${action}`,
        targetId: accountId,
        actorId,
        outcome,
      },
      { session },
    );
  }
  async function counted(
    session,
    key,
    at,
    submit = false,
    wrong = false,
    max = 5,
  ) {
    let count = await counters().findOne({ _id: key }, { session });
    if (
      count &&
      (!instant(count.windowAt) ||
        !Number.isInteger(count.attempts) ||
        count.attempts < 0 ||
        (count.blockedUntil && !instant(count.blockedUntil)))
    )
      throw unavailable();
    count ??= { _id: key, windowAt: at, attempts: 0 };
    if (count.blockedUntil > at) return { failure: limited() };
    if (at - count.windowAt >= RECOVERY_POLICY.windowMs)
      count = { _id: key, windowAt: at, attempts: 0 };
    if (submit || wrong) {
      count.attempts++;
      if (count.attempts >= max)
        count.blockedUntil = new Date(+at + RECOVERY_POLICY.cooldownMs);
      count.expiresAt = new Date(
        Math.max(+at + RECOVERY_POLICY.windowMs, +(count.blockedUntil ?? at)),
      );
      await counters().replaceOne({ _id: key }, count, {
        session,
        upsert: true,
      });
      // The last permitted submission may proceed; subsequent ones are blocked.
    }
    return count;
  }
  const sourceCheck = (session, source, at) =>
    counted(session, `source:${digest(String(source))}`, at, true, false, 30);
  async function wrong(session, accountId, at) {
    const count = await counted(
      session,
      `account:${accountId}`,
      at,
      false,
      true,
    );
    await event(session, "proof", accountId, null, "denied");
    return count.failure ? count : { failure: rejected() };
  }
  async function profile(session, account) {
    const result = await db
      .collection("staff_profiles")
      .findOne({ accountId: account._id }, { session });
    if (!result || (account.profileId && account.profileId !== result._id))
      throw unavailable();
    return result;
  }
  const bindProfile = (saved) =>
    seal(
      saved._id,
      saved.revision ?? 1,
      saved.email,
      saved.emailVerification ?? null,
      saved.phone,
    );
  function activated(account) {
    return (
      account &&
      account.status === "active" &&
      typeof account.passwordHash === "string" &&
      Number.isInteger(account.version) &&
      validRoles(account.roles) &&
      !account.recoveryCaseId &&
      (!requiresMfa(account.roles) ||
        (account.mfa?.enabled === true &&
          account.mfa.backupAcknowledged === true))
    );
  }
  async function emailOwner(session, account) {
    if (!activated(account)) return null;
    const saved = await profile(session, account);
    if (!reservesEmail(saved, vault, testing)) return null;
    let destination;
    try {
      destination = normalizeEmail(saved.email);
    } catch {
      return null;
    }
    const candidates = await db
      .collection("staff_profiles")
      .find(
        { emailVerification: { $exists: true } },
        {
          session,
          projection: { accountId: 1, email: 1, emailVerification: 1 },
        },
      )
      .toArray();
    const owners = candidates.filter(
      (item) =>
        reservesEmail(item, vault, testing) &&
        String(item.email).trim().toLowerCase() === destination,
    );
    if (owners.length !== 1 || owners[0].accountId !== account._id) return null;
    return {
      saved,
      destination,
      binding: seal(
        saved._id,
        saved.revision ?? 1,
        destination,
        saved.emailVerification,
      ),
    };
  }
  async function live(session, secret, states) {
    if (!opaque(secret)) return { failure: expired() };
    const at = now(),
      request = await records().findOne({ _id: digest(secret) }, { session });
    if (
      !request ||
      request.revokedAt ||
      request.consumedAt ||
      !instant(request.expiresAt) ||
      request.expiresAt <= at ||
      (states && !states.includes(request.state))
    )
      return { failure: expired() };
    const count = await counted(session, `account:${request.accountId}`, at);
    if (count.failure) return count;
    const account = await accounts().findOne(
      { _id: request.accountId },
      { session },
    );
    if (
      !account ||
      account.version !== request.version ||
      account.status !== "active" ||
      !validRoles(account.roles) ||
      (account.mfa?.version ?? null) !== request.mfaVersion
    )
      return { failure: expired() };
    const saved = await profile(session, account);
    if (request.actorId) {
      const actor = await accounts().findOne(
        { _id: request.actorId },
        { session },
      );
      if (
        !activated(actor) ||
        !actor.roles.includes("Admin") ||
        actor.version !== request.actorVersion
      )
        return { failure: expired() };
    }
    if (request.profileBinding !== bindProfile(saved))
      return { failure: expired() };
    if (request.emergencyCase) {
      const emergency = await db
        .collection("staff_emergency_state")
        .findOne({ _id: "installation" }, { session });
      const item = emergency?.emergencyCase;
      if (
        !item ||
        item.id !== request.emergencyCase ||
        item.accountId !== account._id ||
        item.version !== account.version ||
        item.closedAt ||
        item.revokedAt
      )
        return { failure: expired() };
    }
    if (request.kind === "email") {
      const owner = await emailOwner(session, account);
      if (!owner || owner.binding !== request.emailBinding)
        return { failure: expired() };
    } else if (request.caseId) {
      const recoveryCase = await cases().findOne(
        { _id: request.caseId, accountId: account._id },
        { session },
      );
      if (
        !recoveryCase ||
        recoveryCase.closedAt ||
        recoveryCase.revokedAt ||
        account.recoveryCaseId !== request.caseId ||
        recoveryCase.generation !== request.caseGeneration
      )
        return { failure: expired() };
    } else if (!activated(account)) return { failure: expired() };
    return { request, account, at };
  }
  function view(request, at, challenge) {
    return {
      ...(challenge ? { challenge } : {}),
      kind: `recovery_${request.state}`,
      scope: request.scope,
      expiresAt: request.expiresAt.toISOString(),
      serverNow: at.toISOString(),
    };
  }
  async function grant(session, account, kind, scope, metadata = {}) {
    const challenge = token(),
      at = now();
    const saved = await profile(session, account);
    const request = {
      _id: digest(challenge),
      accountId: account._id,
      version: account.version,
      mfaVersion: account.mfa?.version ?? null,
      kind,
      scope,
      state:
        scope === "password" && requiresMfa(account.roles) ? "mfa" : "ready",
      expiresAt: new Date(+at + RECOVERY_POLICY.grantMs),
      createdAt: at,
      revokedAt: null,
      consumedAt: null,
      profileBinding: bindProfile(saved),
      ...metadata,
    };
    await records().insertOne(request, { session });
    return view(request, at, challenge);
  }
  async function manager(session, bearer) {
    const at = now(),
      actor = await authenticated(session, bearer, at);
    if (actor.failure) return actor;
    if (!actor.account.roles.includes("Admin"))
      return {
        failure: fault(
          "forbidden",
          "Another Admin must authorize assisted recovery.",
          403,
        ),
      };
    if (!recentVerificationExpiry(actor.record, actor.account, at))
      return {
        failure: new StaffError(
          "verification_required",
          "Verify your current password and MFA again before continuing.",
          403,
        ),
      };
    return { ...actor, at };
  }
  // Persistent dispatch is claimed before touching the provider. An unknown
  // outcome is never retried automatically after a crash or restart.
  let draining;
  async function drain() {
    if (draining) return draining;
    draining = (async () => {
      while (true) {
        const job = await transaction(async (session) => {
          await guard(session);
          const request = await records().findOne(
            {
              dispatch: { $in: ["queued", "notification_pending"] },
              revokedAt: null,
              consumedAt: null,
            },
            { session },
          );
          if (!request) return null;
          const account = await accounts().findOne(
            { _id: request.accountId },
            { session },
          );
          const owner =
            account?.version === request.version
              ? await emailOwner(session, account)
              : null;
          if (
            !owner ||
            owner.binding !== request.emailBinding ||
            request.expiresAt <= now()
          ) {
            await records().updateOne(
              { _id: request._id },
              { $set: { dispatch: "cancelled" }, $unset: { codeCipher: "" } },
              { session },
            );
            return { skip: true };
          }
          if (request.dispatch === "notification_pending") {
            try {
              const config = await provider().configuration(owner.destination);
              await deliverySupport.reserveBudget(
                session,
                { account },
                "email",
                owner.destination,
                provider(),
                config,
                now(),
                true,
              );
            } catch (error) {
              if (!(error instanceof StaffError)) throw error;
              await records().updateOne(
                { _id: request._id },
                { $set: { dispatch: "limited" } },
                { session },
              );
              await event(
                session,
                "notification_unavailable",
                account._id,
                null,
                "denied",
              );
              return { skip: true };
            }
          }
          const code = request.codeCipher
            ? vault.decrypt(request.codeCipher)
            : undefined;
          await records().updateOne(
            { _id: request._id },
            { $set: { dispatch: "sending" }, $unset: { codeCipher: "" } },
            { session },
          );
          return {
            id: request._id,
            code,
            destination: owner.destination,
            expiresAt: request.expiresAt,
            notification: request.kind === "notification",
            purpose:
              request.kind === "notification" ? "recovery_notice" : "recovery",
          };
        });
        if (!job) break;
        if (job.skip) continue;
        let outcome = "sent";
        try {
          await provider().send(job);
        } catch {
          outcome = "failed";
        }
        await transaction(async (session) => {
          await guard(session);
          await records().updateOne(
            { _id: job.id, dispatch: "sending" },
            { $set: { dispatch: outcome } },
            { session },
          );
          await event(session, `delivery_${outcome}`, null, null, outcome);
        });
      }
    })().finally(() => {
      draining = null;
    });
    return draining;
  }
  function dispatch() {
    void drain().catch(() => {
      /* No secret-bearing provider/database errors logged. */
    });
  }
  async function notificationIntent(session, account) {
    const owner = await emailOwner(session, account);
    if (!owner) return;
    await records().insertOne(
      {
        _id: randomUUID(),
        accountId: account._id,
        version: account.version,
        kind: "notification",
        state: "notice",
        emailBinding: owner.binding,
        dispatch: "notification_pending",
        expiresAt: new Date(+now() + 600000),
        consumedAt: null,
        revokedAt: null,
      },
      { session },
    );
  }
  async function codeJob(session, account, owner, challenge, previous) {
    const at = now(),
      delivery = provider(),
      config = await delivery.configuration(owner.destination);
    await deliverySupport.reserveBudget(
      session,
      { account },
      "email",
      owner.destination,
      delivery,
      config,
      at,
    );
    let code;
    do {
      code = String(randomInt(100000000)).padStart(8, "0");
    } while (
      previous &&
      equal(
        seal("recovery-code", account._id, previous.generation, code),
        previous.codeDigest,
      )
    );
    const generation = randomUUID();
    const request = {
      _id: digest(challenge),
      accountId: account._id,
      version: account.version,
      mfaVersion: account.mfa?.version ?? null,
      kind: "email",
      scope: "password",
      state: "email",
      emailBinding: owner.binding,
      generation,
      codeDigest: seal("recovery-code", account._id, generation, code),
      profileBinding: bindProfile(owner.saved),
      codeCipher: vault.encrypt(code),
      expiresAt: previous?.expiresAt ?? new Date(+at + RECOVERY_POLICY.codeMs),
      lastSendAt: at,
      resends: previous ? previous.resends + 1 : 0,
      dispatch: "queued",
      revokedAt: null,
      consumedAt: null,
    };
    if (previous)
      await records().replaceOne({ _id: previous._id }, request, { session });
    else {
      await records().updateMany(
        { accountId: account._id, kind: "email", revokedAt: null },
        { $set: { revokedAt: at }, $unset: { codeCipher: "" } },
        { session },
      );
      await records().insertOne(request, { session });
    }
  }
  async function releaseLease(accountId, jobId) {
    await transaction(async (session) => {
      await guard(session);
      await db
        .collection("password_change_counters")
        .updateOne(
          { _id: accountId, jobId },
          { $unset: { jobId: "", jobExpiresAt: "" } },
          { session },
        );
    });
  }
  async function reserveLease(session, account, expiresAt, history = false) {
    const at = now(),
      collection = db.collection("password_change_counters");
    let count = await collection.findOne({ _id: account._id }, { session });
    count ??= {
      _id: account._id,
      failureWindow: at,
      failures: 0,
      historyWindow: at,
      historyAttempts: 0,
    };
    if (
      !instant(count.historyWindow) ||
      !Number.isInteger(count.historyAttempts) ||
      count.historyAttempts < 0 ||
      (count.jobId && !instant(count.jobExpiresAt))
    )
      throw unavailable();
    if (count.jobId && count.jobExpiresAt > at)
      throw fault(
        "busy",
        "The server is busy checking passwords. Try again shortly. Your entries have been kept; no history-check allowance was used.",
      );
    if (at - count.historyWindow >= 900000) {
      count.historyWindow = at;
      count.historyAttempts = 0;
    }
    if (history && count.historyAttempts >= 5)
      throw fault(
        "allowance",
        "Your five password-history checks for this 15-minute window have been used. Wait for the window to end.",
        429,
      );
    if (history) count.historyAttempts++;
    count.jobId = randomUUID();
    count.jobExpiresAt = expiresAt;
    count.expiresAt = new Date(
      Math.max(+at + 900000, +(count.blockedUntil ?? at), +expiresAt),
    );
    await collection.replaceOne({ _id: count._id }, count, {
      session,
      upsert: true,
    });
    return count.jobId;
  }
  async function startReplacement(session, current) {
    const at = now(),
      account = current.account;
    const id = randomUUID(),
      version = account.version + 1,
      generation = randomUUID();
    const secret = generateSecret();
    await accounts().updateOne(
      { _id: account._id, version: account.version },
      {
        $set: {
          recoveryCaseId: id,
          pendingMfaSecretCipher: vault.encrypt(secret),
          mfa: {
            enabled: false,
            version: (account.mfa?.version ?? 0) + 1,
            backupAcknowledged: false,
            backupCodes: [],
          },
        },
        $inc: { version: 1 },
      },
      { session },
    );
    await revokeCredentialAuthorities(
      db,
      session,
      account._id,
      at,
      "mfa_recovery",
    );
    await cases().insertOne(
      {
        _id: id,
        accountId: account._id,
        generation,
        state: "enroll",
        createdAt: at,
        origin: current.request.kind,
        scope: current.request.scope,
      },
      { session },
    );
    if (current.request.emergencyCase)
      await db.collection("staff_emergency_state").updateOne(
        {
          _id: "installation",
          "emergencyCase.id": current.request.emergencyCase,
        },
        {
          $set: {
            "emergencyCase.version": version,
            "emergencyCase.recoveryCaseId": id,
          },
        },
        { session },
      );
    const next = await accounts().findOne(
      { _id: account._id, version },
      { session },
    );
    return grant(session, next, "replacement", "mfa", {
      state: "enroll",
      caseId: id,
      caseGeneration: generation,
      expiresAt: new Date(+at + RECOVERY_POLICY.enrollmentMs),
      emergencyCase: current.request.emergencyCase ?? null,
      ...(current.request.actorId
        ? {
            actorId: current.request.actorId,
            actorVersion: current.request.actorVersion,
          }
        : {}),
    });
  }
  const api = {
    // TEST-only wait seam; it neither exposes codes nor enables mock production.
    async flushDelivery() {
      if (!testing) throw unavailable();
      await drain();
    },
    async provePassword(input, source) {
      fields(input, ["username", "password", "method", "code", "resume"]);
      const username = normalizeUsername(input.username);
      const initial = await transaction(async (session) => {
        await guard(session);
        const sourceCount = await sourceCheck(session, source, now());
        if (sourceCount.failure) return sourceCount;
        const account = await accounts().findOne({ username }, { session });
        if (
          !account ||
          account.status !== "active" ||
          !requiresMfa(account.roles) ||
          !account.mfa?.enabled ||
          (account.recoveryCaseId && input.resume !== true) ||
          (!account.recoveryCaseId && !activated(account))
        )
          return { failure: rejected() };
        const count = await counted(session, `account:${account._id}`, now());
        if (count.failure) return count;
        return { account, expiresAt: new Date(+now() + 300000) };
      });
      const free = passwordProcessGate.acquire(initial.account._id);
      let job;
      try {
        job = await transaction(async (session) => {
          await guard(session);
          return reserveLease(session, initial.account, initial.expiresAt);
        });
        const matched = await argon2.verify(
          initial.account.passwordHash,
          boundedSecret(input.password, 512),
        );
        return await transaction(async (session) => {
          await guard(session);
          const account = await accounts().findOne(
            { _id: initial.account._id },
            { session },
          );
          if (!account) return { failure: expired() };
          const count = await counted(session, `account:${account._id}`, now());
          if (count.failure) return count;
          const lease = await db
            .collection("password_change_counters")
            .findOne({ _id: account._id, jobId: job }, { session });
          if (
            !lease ||
            lease.jobExpiresAt <= now() ||
            account.version !== initial.account.version ||
            account.passwordHash !== initial.account.passwordHash ||
            account.status !== "active"
          )
            return { failure: expired() };
          if (
            !matched ||
            !["totp", "backup"].includes(input.method) ||
            !(await consumeFactor(
              session,
              account,
              input.method,
              input.code,
              now(),
            ))
          )
            return wrong(session, account._id, now());
          if (account.recoveryCaseId) {
            const item = await cases().findOne(
              {
                _id: account.recoveryCaseId,
                state: "backups",
                closedAt: { $exists: false },
              },
              { session },
            );
            if (!item) return { failure: expired() };
            return grant(session, account, "replacement", "mfa", {
              state: "backups",
              caseId: item._id,
              caseGeneration: item.generation,
              expiresAt: new Date(+now() + 600000),
            });
          }
          return grant(session, account, "self", "mfa");
        });
      } finally {
        try {
          if (job) await releaseLease(initial.account._id, job);
        } finally {
          free();
        }
      }
    },
    async replace(input) {
      fields(input, ["challenge", "confirmed"]);
      if (input.confirmed !== true)
        throw fault(
          "acknowledgement",
          "Confirm replacement will revoke the old authenticator, backups and all sessions.",
        );
      return transaction(async (session) => {
        await guard(session);
        const current = await live(session, input.challenge, ["ready"]);
        if (current.failure) return current;
        if (current.request.scope !== "mfa" || current.request.kind !== "self")
          return { failure: expired() };
        return startReplacement(session, current);
      });
    },
    async request(input, source) {
      fields(input, ["username"]);
      const username = normalizeUsername(input.username),
        challenge = token();
      try {
        await transaction(async (session) => {
          await guard(session);
          const sourceCount = await sourceCheck(session, source, now());
          if (sourceCount.failure) return null;
          const account = await accounts().findOne({ username }, { session });
          if (
            !account ||
            (await counted(session, `account:${account._id}`, now())).failure
          )
            return null;
          const owner = await emailOwner(session, account);
          if (owner) await codeJob(session, account, owner, challenge);
        });
      } catch (error) {
        if (!(error instanceof StaffError)) throw error;
        // Quota/configuration/eligibility never change the public reply.
      }
      dispatch();
      return {
        message: RECOVERY_MESSAGE,
        challenge,
        kind: "recovery_email",
        expiresAt: new Date(+now() + RECOVERY_POLICY.codeMs).toISOString(),
        serverNow: now().toISOString(),
      };
    },
    async verify(input, source) {
      fields(input, ["challenge", "code"]);
      return transaction(async (session) => {
        await guard(session);
        const sourceCount = await sourceCheck(session, source, now());
        if (sourceCount.failure) return sourceCount;
        const current = await live(session, input.challenge, ["email"]);
        if (current.failure) return { failure: rejected() };
        if (
          current.request.dispatch !== "sent" ||
          !/^\d{8}$/.test(String(input.code)) ||
          !equal(
            seal(
              "recovery-code",
              current.account._id,
              current.request.generation,
              input.code,
            ),
            current.request.codeDigest,
          )
        )
          return wrong(session, current.account._id, current.at);
        await records().updateOne(
          { _id: current.request._id },
          { $set: { consumedAt: current.at }, $unset: { codeCipher: "" } },
          { session },
        );
        return grant(session, current.account, "email", "password", {
          emailBinding: current.request.emailBinding,
        });
      });
    },
    async resend(input, source) {
      fields(input, ["challenge"]);
      try {
        await transaction(async (session) => {
          await guard(session);
          const sourceCount = await sourceCheck(session, source, now());
          if (sourceCount.failure) return sourceCount;
          const current = await live(session, input.challenge, ["email"]);
          if (current.failure) return current;
          if (
            current.at - current.request.lastSendAt < 60000 ||
            current.request.resends >= 2 ||
            ["queued", "sending"].includes(current.request.dispatch)
          )
            return {
              failure: fault(
                "resend_limit",
                "Wait at least 60 seconds. At most two resends are allowed; the original deadline stays unchanged.",
              ),
            };
          const owner = await emailOwner(session, current.account);
          await codeJob(
            session,
            current.account,
            owner,
            input.challenge,
            current.request,
          );
          return null;
        });
      } catch (error) {
        if (!(error instanceof StaffError)) throw error;
      }
      dispatch();
      return { message: RECOVERY_MESSAGE };
    },
    async factor(input, source) {
      fields(input, ["challenge", "method", "code"]);
      return transaction(async (session) => {
        await guard(session);
        const sourceCount = await sourceCheck(session, source, now());
        if (sourceCount.failure) return sourceCount;
        const current = await live(session, input.challenge, ["mfa"]);
        if (current.failure) return current;
        if (
          !["totp", "backup"].includes(input.method) ||
          !(await consumeFactor(
            session,
            current.account,
            input.method,
            input.code,
            current.at,
          ))
        )
          return wrong(session, current.account._id, current.at);
        await records().updateOne(
          { _id: current.request._id },
          { $set: { state: "ready", mfaVerifiedAt: current.at } },
          { session },
        );
        return view({ ...current.request, state: "ready" }, current.at);
      });
    },
    async assist(bearer, targetId, input) {
      fields(input, [
        "scope",
        "identityConfirmed",
        "purpose",
        "confirmed",
        "version",
      ]);
      if (
        !["password", "mfa", "both"].includes(input.scope) ||
        input.identityConfirmed !== true ||
        input.confirmed !== true ||
        typeof input.purpose !== "string" ||
        !input.purpose.trim() ||
        input.purpose.length > 200
      )
        throw fault(
          "acknowledgement",
          "Confirm the in-person identity check and recovery purpose.",
        );
      return transaction(async (session) => {
        await guard(session);
        const actor = await manager(session, bearer);
        if (actor.failure) return actor;
        const account = await accounts().findOne(
          { _id: targetId },
          { session },
        );
        if (
          !account ||
          targetId === actor.account._id ||
          input.version !== account.version ||
          account.status !== "active" ||
          !account.passwordHash ||
          !validRoles(account.roles) ||
          (!account.recoveryCaseId && !activated(account)) ||
          (account.recoveryCaseId &&
            input.scope === "password" &&
            !account.mfa?.enabled) ||
          (input.scope !== "password" && !requiresMfa(account.roles))
        )
          return {
            failure: fault(
              "target",
              "Choose another active, previously activated eligible employee.",
              403,
            ),
          };
        const secret = token();
        const saved = await profile(session, account);
        const superseded = await records().updateMany(
          { accountId: targetId, actorId: { $exists: true }, revokedAt: null },
          { $set: { revokedAt: now() } },
          { session },
        );
        if (superseded.modifiedCount)
          await event(
            session,
            "assisted_superseded",
            targetId,
            actor.account._id,
          );
        await records().insertOne(
          {
            _id: digest(secret),
            kind: "assisted",
            state: "handoff",
            scope: input.scope,
            accountId: targetId,
            version: account.version,
            mfaVersion: account.mfa?.version ?? null,
            createdAt: now(),
            expiresAt: new Date(+now() + RECOVERY_POLICY.assistedMs),
            revokedAt: null,
            consumedAt: null,
            actorId: actor.account._id,
            actorVersion: actor.account.version,
            purpose: input.purpose.trim(),
            identityConfirmedAt: now(),
            profileBinding: bindProfile(saved),
            ...(account.recoveryCaseId
              ? {
                  caseId: account.recoveryCaseId,
                  caseGeneration: (
                    await cases().findOne(
                      { _id: account.recoveryCaseId },
                      { session },
                    )
                  )?.generation,
                }
              : {}),
          },
          { session },
        );
        await event(
          session,
          "assisted_authorized",
          targetId,
          actor.account._id,
        );
        return {
          handoff: secret,
          expiresAt: new Date(
            +now() + RECOVERY_POLICY.assistedMs,
          ).toISOString(),
          displayExpiresAt: new Date(
            Math.min(
              +actor.record.absoluteExpiresAt,
              +actor.record.lastActivityAt + 600000,
              +now() + 60000,
            ),
          ).toISOString(),
          scope: input.scope,
          serverNow: now().toISOString(),
        };
      });
    },
    async revokeAssistance(bearer, targetId, input) {
      fields(input, ["version", "confirmed"]);
      if (input.confirmed !== true)
        throw fault(
          "acknowledgement",
          "Confirm revocation of private recovery handoffs.",
        );
      return transaction(async (session) => {
        await guard(session);
        const actor = await manager(session, bearer);
        if (actor.failure) return actor;
        const account = await accounts().findOne(
          { _id: targetId },
          { session },
        );
        if (
          !account ||
          account._id === actor.account._id ||
          account.version !== input.version
        )
          return {
            failure: fault(
              "target",
              "Select another employee's current account.",
              403,
            ),
          };
        await records().updateMany(
          { accountId: targetId, actorId: { $exists: true }, revokedAt: null },
          {
            $set: { revokedAt: now(), revocationReason: "assistance_revoked" },
          },
          { session },
        );
        await event(session, "assisted_revoked", targetId, actor.account._id);
        return { revoked: true };
      });
    },
    async redeem(input, source) {
      fields(input, ["username", "handoff", "password"]);
      const username = normalizeUsername(input.username);
      const initial = await transaction(async (session) => {
        await guard(session);
        const sourceCount = await sourceCheck(session, source, now());
        if (sourceCount.failure) return sourceCount;
        const target = await accounts().findOne({ username }, { session });
        const current = await live(session, input.handoff, ["handoff"]);
        if (current.failure || !target || current.account._id !== target._id) {
          if (target) return wrong(session, target._id, now());
          return { failure: rejected() };
        }
        return current;
      });
      let free, job;
      try {
        // An MFA-only handoff is not forgotten-password authority. Verify the
        // password outside the transaction, using the shared process/account
        // work limits, then recheck the exact original authorization.
        let matched = true;
        if (initial.request.scope === "mfa") {
          const password = boundedSecret(input.password, 512);
          free = passwordProcessGate.acquire(initial.account._id);
          job = await transaction(async (session) => {
            await guard(session);
            const current = await live(session, input.handoff, ["handoff"]);
            if (current.failure) return current;
            return reserveLease(
              session,
              current.account,
              current.request.expiresAt,
            );
          });
          await testWork?.({
            stage: "identity",
            accountId: initial.account._id,
          });
          matched = await argon2.verify(initial.account.passwordHash, password);
        }
        return await transaction(async (session) => {
          await guard(session);
          const current = await live(session, input.handoff, ["handoff"]);
          if (current.failure) return current;
          const { account: target, request } = current;
          if (
            target._id !== initial.account._id ||
            target.version !== initial.account.version ||
            target.passwordHash !== initial.account.passwordHash ||
            request._id !== initial.request._id
          )
            return { failure: expired() };
          if (job) {
            const lease = await db
              .collection("password_change_counters")
              .findOne({ _id: target._id, jobId: job }, { session });
            if (!lease || lease.jobExpiresAt <= now())
              return { failure: expired() };
          }
          if (!matched) return wrong(session, target._id, now());
          await records().updateOne(
            { _id: request._id },
            { $set: { consumedAt: now() } },
            { session },
          );
          if (request.caseId) {
            const existing = await cases().findOne(
              { _id: request.caseId },
              { session },
            );
            const resumingFactor =
              request.resumeOnly || request.scope === "mfa";
            const nextState = resumingFactor
              ? existing.state
              : request.scope === "password"
                ? "mfa"
                : "ready";
            return grant(
              session,
              target,
              request.resumeOnly || request.scope === "mfa"
                ? "replacement"
                : request.kind,
              request.resumeOnly || request.scope === "mfa"
                ? "mfa"
                : request.scope,
              {
                state: nextState,
                caseId: existing._id,
                caseGeneration: existing.generation,
                expiresAt: new Date(
                  +now() +
                    (["enroll", "backups"].includes(nextState)
                      ? RECOVERY_POLICY.enrollmentMs
                      : RECOVERY_POLICY.grantMs),
                ),
                emergencyCase: request.emergencyCase ?? null,
                ...(request.actorId
                  ? {
                      actorId: request.actorId,
                      actorVersion: request.actorVersion,
                    }
                  : {}),
              },
            );
          }
          if (request.scope === "mfa")
            return startReplacement(session, current);
          return grant(session, target, request.kind, request.scope, {
            emergencyCase: request.emergencyCase ?? null,
            ...(request.actorId
              ? { actorId: request.actorId, actorVersion: request.actorVersion }
              : {}),
          });
        });
      } finally {
        try {
          if (job) await releaseLease(initial.account._id, job);
        } finally {
          free?.();
        }
      }
    },
    async complete(input, source = "internal") {
      const password = passwordChangeInput(input);
      await transaction(async (session) => {
        await guard(session);
        return sourceCheck(session, source, now());
      });
      const initial = await transaction(async (session) => {
        await guard(session);
        return live(session, input.challenge, ["ready"]);
      });
      passwordChangeInput(input, initial.account.username);
      if (initial.request.scope === "mfa") throw expired();
      const free = passwordProcessGate.acquire(initial.account._id);
      let jobId;
      try {
        jobId = await transaction(async (session) => {
          await guard(session);
          const current = await live(session, input.challenge, ["ready"]);
          if (current.failure) return current;
          return reserveLease(
            session,
            current.account,
            current.request.expiresAt,
            true,
          );
        });
        async function check(session) {
          const current = await live(session, input.challenge, ["ready"]);
          if (current.failure) return current;
          const lease = await db
            .collection("password_change_counters")
            .findOne({ _id: initial.account._id, jobId }, { session });
          if (
            !lease ||
            lease.jobExpiresAt <= now() ||
            current.account.version !== initial.account.version ||
            current.account.passwordHash !== initial.account.passwordHash
          )
            return { failure: expired() };
          return current;
        }
        const authoritative = () =>
          transaction(async (session) => {
            await guard(session);
            return check(session);
          });
        const work = async (stage, operation) => {
          await testWork?.({ stage, accountId: initial.account._id });
          await authoritative();
          return operation();
        };
        const reused = await checkRecordedPasswords({
          password,
          currentHash: initial.account.passwordHash,
          cursor: db
            .collection("staff_password_history")
            .find({ accountId: initial.account._id })
            .sort({ credentialVersion: 1 })
            .batchSize(16),
          vault,
          check: authoritative,
          work,
        });
        if (reused)
          throw new StaffError(
            "password_reused",
            "Choose a password you have never used for this account.",
          );
        const hash = await work("hash", () =>
          argon2.hash(password, hashOptions),
        );
        const result = await transaction(async (session) => {
          await guard(session);
          const current = await check(session);
          if (current.failure) return current;
          await archiveCurrentPassword(
            db,
            vault,
            session,
            current.account,
            current.at,
          );
          const saved = await accounts().updateOne(
            {
              _id: current.account._id,
              version: current.account.version,
              passwordHash: current.account.passwordHash,
              status: "active",
            },
            {
              $set: { passwordHash: hash, passwordChangedAt: current.at },
              $inc: { version: 1 },
            },
            { session },
          );
          if (saved.modifiedCount !== 1) throw expired();
          if (current.request.emergencyCase)
            await db.collection("staff_emergency_state").updateOne(
              {
                _id: "installation",
                "emergencyCase.id": current.request.emergencyCase,
              },
              {
                $set: {
                  "emergencyCase.version": current.account.version + 1,
                  ...(current.request.scope !== "both" &&
                  !current.request.caseId
                    ? { "emergencyCase.closedAt": current.at }
                    : {}),
                },
                ...(current.request.scope !== "both" && !current.request.caseId
                  ? { $unset: { "emergencyCase.resumeVerifier": "" } }
                  : {}),
              },
              { session },
            );
          await revokeCredentialAuthorities(
            db,
            session,
            current.account._id,
            current.at,
            "password_recovered",
          );
          await event(session, "password_installed", current.account._id);
          if (current.request.caseId) {
            const existing = await cases().findOne(
              { _id: current.request.caseId },
              { session },
            );
            const updated = await accounts().findOne(
              { _id: current.account._id },
              { session },
            );
            return grant(session, updated, "replacement", "mfa", {
              state: existing.state,
              caseId: existing._id,
              caseGeneration: existing.generation,
              expiresAt: new Date(+now() + RECOVERY_POLICY.enrollmentMs),
              emergencyCase: current.request.emergencyCase ?? null,
              ...(current.request.actorId
                ? {
                    actorId: current.request.actorId,
                    actorVersion: current.request.actorVersion,
                  }
                : {}),
            });
          }
          if (current.request.scope === "both") {
            const updated = await accounts().findOne(
              { _id: current.account._id },
              { session },
            );
            return startReplacement(session, { ...current, account: updated });
          }
          await notificationIntent(
            session,
            await accounts().findOne({ _id: current.account._id }, { session }),
          );
          return {
            completed: true,
            message:
              "Password saved. Sign in with your new password and required MFA.",
          };
        });
        dispatch();
        return result;
      } finally {
        try {
          if (jobId) await releaseLease(initial.account._id, jobId);
        } catch {
          /* A bounded cleanup failure cannot undo a committed save. */
        } finally {
          free();
        }
      }
    },
    async enrollment(input) {
      fields(input, ["challenge"]);
      return transaction(async (session) => {
        await guard(session);
        const current = await live(session, input.challenge, ["enroll"]);
        if (current.failure) return current;
        const secret = vault.decrypt(current.account.pendingMfaSecretCipher);
        return {
          ...view(current.request, current.at),
          secret,
          uri: generateURI({
            issuer: "Cedar Staff",
            label: current.account.username,
            secret,
          }),
        };
      });
    },
    async enroll(input, source) {
      fields(input, ["challenge", "code"]);
      return transaction(async (session) => {
        await guard(session);
        const sourceCount = await sourceCheck(session, source, now());
        if (sourceCount.failure) return sourceCount;
        const current = await live(session, input.challenge, ["enroll"]);
        if (current.failure) return current;
        const result = await verify({
          secret: vault.decrypt(current.account.pendingMfaSecretCipher),
          token: String(input.code),
          epoch: Math.floor(+now() / 1000),
          epochTolerance: 30,
        });
        if (!result.valid)
          return wrong(session, current.account._id, current.at);
        const backups = Array.from({ length: 10 }, () =>
          randomBytes(16).toString("hex"),
        );
        await accounts().updateOne(
          { _id: current.account._id, version: current.account.version },
          {
            $set: {
              "mfa.enabled": true,
              "mfa.secretCipher": current.account.pendingMfaSecretCipher,
              "mfa.backupCodes": backups.map((code) => ({
                digest: digest(code),
                usedAt: null,
              })),
              "mfa.lastAcceptedStep": result.timeStep,
            },
            $unset: { pendingMfaSecretCipher: "" },
          },
          { session },
        );
        await cases().updateOne(
          { _id: current.request.caseId },
          {
            $set: {
              state: "backups",
              backupsCipher: vault.encrypt(JSON.stringify(backups)),
            },
          },
          { session },
        );
        await records().updateOne(
          { _id: current.request._id },
          { $set: { state: "backups" } },
          { session },
        );
        await event(session, "factor_replaced", current.account._id);
        return {
          ...view({ ...current.request, state: "backups" }, current.at),
          backupCodes: backups,
        };
      });
    },
    async backups(input) {
      fields(input, ["challenge"]);
      return transaction(async (session) => {
        await guard(session);
        const current = await live(session, input.challenge, ["backups"]);
        if (current.failure) return current;
        const item = await cases().findOne(
          { _id: current.request.caseId },
          { session },
        );
        return {
          ...view(current.request, current.at),
          backupCodes: JSON.parse(vault.decrypt(item.backupsCipher)),
        };
      });
    },
    async acknowledge(input) {
      fields(input, ["challenge", "confirmed"]);
      if (input.confirmed !== true)
        throw fault(
          "acknowledgement",
          "Confirm you stored your private backup codes.",
        );
      const result = await transaction(async (session) => {
        await guard(session);
        const current = await live(session, input.challenge, ["backups"]);
        if (current.failure) return current;
        await accounts().updateOne(
          { _id: current.account._id, version: current.account.version },
          {
            $set: { "mfa.backupAcknowledged": true },
            $unset: { recoveryCaseId: "" },
          },
          { session },
        );
        await cases().updateOne(
          { _id: current.request.caseId },
          {
            $set: { closedAt: current.at, state: "complete" },
            $unset: { backupsCipher: "" },
          },
          { session },
        );
        await revokeCredentialAuthorities(
          db,
          session,
          current.account._id,
          current.at,
          "recovery_complete",
        );
        await event(session, "complete", current.account._id);
        await db.collection("staff_emergency_state").updateOne(
          {
            _id: "installation",
            "emergencyCase.recoveryCaseId": current.request.caseId,
          },
          {
            $set: { "emergencyCase.closedAt": current.at },
            $unset: { "emergencyCase.resumeVerifier": "" },
          },
          { session },
        );
        await notificationIntent(
          session,
          await accounts().findOne({ _id: current.account._id }, { session }),
        );
        return {
          completed: true,
          message:
            "Recovery complete. Sign in using your password and new authenticator.",
        };
      });
      dispatch();
      return result;
    },
    async status(input) {
      fields(input, ["challenge"]);
      return transaction(async (session) => {
        await guard(session);
        const found = opaque(input.challenge)
          ? await records().findOne(
              { _id: digest(input.challenge) },
              { session },
            )
          : null;
        if (!found || found.state === "email")
          return { kind: "recovery_email", message: RECOVERY_MESSAGE };
        const current = await live(session, input.challenge);
        return current.failure ? current : view(current.request, current.at);
      });
    },
    async cancel(input) {
      fields(input, ["challenge"]);
      return transaction(async (session) => {
        await guard(session);
        const found = opaque(input.challenge)
          ? await records().findOne(
              { _id: digest(input.challenge) },
              { session },
            )
          : null;
        if (!found || found.state === "email") {
          if (found)
            await records().updateOne(
              { _id: found._id },
              { $set: { revokedAt: now() }, $unset: { codeCipher: "" } },
              { session },
            );
          return { cancelled: true };
        }
        const current = await live(session, input.challenge);
        if (current.failure) return current;
        await records().updateOne(
          { _id: current.request._id },
          { $set: { revokedAt: current.at }, $unset: { codeCipher: "" } },
          { session },
        );
        await event(session, "cancelled", current.account._id);
        return { cancelled: true };
      });
    },
    // Kept internal: private server tooling receives no general remote endpoint.
    operator: {
      grant,
      manager,
      activated,
      startReplacement,
      event,
      counted,
      profileBinding: async (session, account) =>
        bindProfile(await profile(session, account)),
    },
  };
  return api;
}
