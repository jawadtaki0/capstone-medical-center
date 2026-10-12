import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { StaffError, unavailable } from "./errors.js";
import { boundedSecret, validatePassword } from "./validation.js";

export const PASSWORD_CHANGE_POLICY = Object.freeze({
  authorizationMs: 5 * 60000,
  windowMs: 15 * 60000,
  cooldownMs: 15 * 60000,
  maxFailures: 5,
  maxHistoryAttempts: 5,
  jobsPerProcess: 2,
});
const digest = (value) => createHash("sha256").update(value).digest("hex");
const failure = () =>
  new StaffError(
    "password_change_failed",
    "Password verification could not be completed. Check your details and try again.",
    401,
  );
const expired = () =>
  new StaffError(
    "password_change_expired",
    "Password-change authorization expired or is no longer valid. Start again.",
    409,
  );
const busy = () =>
  new StaffError(
    "password_change_busy",
    "The server is busy checking passwords. Try again shortly. Your entries have been kept; no history-check allowance was used.",
    409,
  );
const cooldown = () =>
  new StaffError(
    "password_change_cooldown",
    "Too many incorrect password-change checks. Wait 15 minutes before trying again. Ordinary sign-in is unaffected.",
    429,
  );
const allowance = () =>
  new StaffError(
    "password_change_allowance",
    "Your five password-history checks for this 15-minute window have been used. Wait for the window to end before trying again.",
    429,
  );
const date = (value) =>
  value instanceof Date && Number.isFinite(value.getTime());
function fields(input, allowed) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw new StaffError(
      "invalid_input",
      "Send only the fields supported by this password action.",
    );
}
export function passwordChangeInput(input, username) {
  fields(input, ["challenge", "newPassword", "confirmation"]);
  const password = validatePassword(input.newPassword, { username });
  if (password !== input.confirmation)
    throw new StaffError(
      "invalid_input",
      "New password and confirmation must match exactly.",
    );
  return password;
}

// No queue: every admitted job has its own unchanged Argon2 work budget. This
// is deliberately a per-process limit, not a multi-process deployment claim.
export function createPasswordWorkGate() {
  const accounts = new Set();
  return {
    acquire(accountId) {
      if (
        accounts.has(accountId) ||
        accounts.size >= PASSWORD_CHANGE_POLICY.jobsPerProcess
      )
        throw busy();
      accounts.add(accountId);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          accounts.delete(accountId);
        }
      };
    },
  };
}
const processGate = createPasswordWorkGate();

export function createPasswordChangeService({
  db,
  client,
  vault,
  transaction,
  guard,
  authenticated,
  now,
  requiresMfa,
  consumeFactor,
  hashOptions,
  testWork,
  idleMs,
}) {
  if (testWork !== undefined) {
    const hosts = client?.options?.hosts ?? [];
    if (
      typeof testWork !== "function" ||
      db.databaseName !== "capstone_staff_test" ||
      hosts.length !== 1 ||
      hosts[0].host !== "127.0.0.1" ||
      hosts[0].port !== 27018 ||
      client.options.replicaSet !== "capstoneStaffDev"
    )
      throw unavailable();
  }
  // Health and unrelated authentication checks must not acquire collections.
  const counters = () => db.collection("password_change_counters"),
    challenges = () => db.collection("auth_challenges");
  const accounts = () => db.collection("accounts"),
    history = () => db.collection("staff_password_history");
  async function context(session, token) {
    const at = now(),
      actor = await authenticated(session, token, at);
    if (actor.failure) return actor;
    await guard(session);
    return { ...actor, at };
  }
  async function counter(session, accountId, at) {
    const stored = await counters().findOne({ _id: accountId }, { session });
    if (
      stored &&
      (!date(stored.failureWindow) ||
        !date(stored.historyWindow) ||
        !Number.isInteger(stored.failures) ||
        stored.failures < 0 ||
        !Number.isInteger(stored.historyAttempts) ||
        stored.historyAttempts < 0 ||
        (stored.blockedUntil && !date(stored.blockedUntil)) ||
        (stored.jobId && !date(stored.jobExpiresAt)))
    )
      throw unavailable();
    const value = stored ?? {
      _id: accountId,
      failureWindow: at,
      failures: 0,
      historyWindow: at,
      historyAttempts: 0,
    };
    if (value.blockedUntil > at) return { failure: cooldown() };
    if (at - value.failureWindow >= PASSWORD_CHANGE_POLICY.windowMs) {
      value.failureWindow = at;
      value.failures = 0;
      value.blockedUntil = null;
    }
    if (at - value.historyWindow >= PASSWORD_CHANGE_POLICY.windowMs) {
      value.historyWindow = at;
      value.historyAttempts = 0;
    }
    return value;
  }
  async function saveCounter(session, value, at) {
    value.expiresAt = new Date(
      Math.max(
        at.getTime() + PASSWORD_CHANGE_POLICY.windowMs,
        value.blockedUntil?.getTime() ?? 0,
        value.jobExpiresAt?.getTime() ?? 0,
      ),
    );
    await counters().replaceOne({ _id: value._id }, value, {
      session,
      upsert: true,
    });
  }
  async function wrong(session, accountId, at) {
    const value = await counter(session, accountId, at);
    if (value.failure) return value;
    value.failures += 1;
    if (value.failures >= PASSWORD_CHANGE_POLICY.maxFailures)
      value.blockedUntil = new Date(
        at.getTime() + PASSWORD_CHANGE_POLICY.cooldownMs,
      );
    await saveCounter(session, value, at);
    await event(session, accountId, "identity", "denied", at);
    return { failure: failure() };
  }
  async function event(session, accountId, action, outcome, at) {
    await db.collection("security_events").insertOne(
      {
        actorId: accountId,
        targetId: accountId,
        action: `password_change_${action}`,
        outcome,
        occurredAt: at,
      },
      { session },
    );
  }
  function deadline(actor) {
    return new Date(
      Math.min(
        actor.at.getTime() + PASSWORD_CHANGE_POLICY.authorizationMs,
        actor.record.absoluteExpiresAt.getTime(),
        actor.record.lastActivityAt.getTime() + idleMs,
      ),
    );
  }
  async function proof(session, actor, value, ready = false) {
    const secret = boundedSecret(value, 64);
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return { failure: expired() };
    const found = await challenges().findOne(
      { _id: digest(secret), purpose: "password-change" },
      { session },
    );
    if (
      !found ||
      found.accountId !== actor.account._id ||
      found.sessionId !== actor.record._id ||
      found.version !== actor.account.version ||
      found.generation !== actor.record.passwordChangeGeneration ||
      found.mfaVersion !== actor.account.mfa?.version ||
      found.consumedAt ||
      found.revokedAt ||
      !date(found.passwordVerifiedAt) ||
      found.passwordVerifiedAt > actor.at ||
      !date(found.expiresAt) ||
      found.expiresAt <= actor.at ||
      (ready &&
        (found.state !== "ready" ||
          (requiresMfa(actor.account.roles) &&
            (!date(found.mfaVerifiedAt) || found.mfaVerifiedAt > actor.at))))
    )
      return { failure: expired() };
    return found;
  }
  async function lease(session, actor, value, fullHistory) {
    const count = await counter(session, actor.account._id, actor.at);
    if (count.failure) return count;
    if (count.jobId && count.jobExpiresAt > actor.at)
      return { failure: busy() };
    if (
      fullHistory &&
      count.historyAttempts >= PASSWORD_CHANGE_POLICY.maxHistoryAttempts
    )
      return { failure: allowance() };
    const jobId = randomUUID(),
      expiresAt = value?.expiresAt ?? deadline(actor);
    if (expiresAt <= actor.at) return { failure: expired() };
    count.jobId = jobId;
    count.jobExpiresAt = expiresAt;
    if (fullHistory) count.historyAttempts += 1;
    await saveCounter(session, count, actor.at);
    return { jobId, expiresAt };
  }
  async function release(accountId, jobId) {
    // Cleanup uses the random job identity, never a client claim, and never
    // changes penalties. An expired old job cannot clear a newer job's lease.
    await transaction(async (session) => {
      await guard(session);
      await counters().updateOne(
        { _id: accountId, jobId },
        { $unset: { jobId: "", jobExpiresAt: "" } },
        { session },
      );
    });
  }
  async function liveJob(session, token, admitted, challenge) {
    const actor = await context(session, token);
    if (actor.failure) return actor;
    if (
      actor.account._id !== admitted.account._id ||
      actor.account.version !== admitted.account.version ||
      actor.account.passwordHash !== admitted.account.passwordHash ||
      actor.account.mfa?.version !== admitted.account.mfa?.version ||
      actor.record.passwordChangeGeneration !==
        admitted.record.passwordChangeGeneration ||
      admitted.expiresAt <= actor.at
    )
      return { failure: expired() };
    const count = await counter(session, actor.account._id, actor.at);
    if (count.failure) return count;
    if (count.jobId !== admitted.jobId || count.jobExpiresAt <= actor.at)
      return { failure: expired() };
    if (challenge) {
      const authorization = await proof(session, actor, challenge, true);
      if (authorization.failure) return authorization;
    }
    return actor;
  }
  async function checked(admitted, stage, operation) {
    await testWork?.({ stage, accountId: admitted.account._id });
    if (now() >= admitted.expiresAt) throw expired();
    return operation();
  }
  return {
    async start(token, input) {
      fields(input, ["password"]);
      const password = boundedSecret(input.password, 512);
      if (!password)
        throw new StaffError("invalid_input", "Enter your current password.");
      // Obtain actor ID without spending anything, then use the process gate
      // before the short persistent lease transaction or any expensive work.
      const actor = await transaction((session) => context(session, token));
      const free = processGate.acquire(actor.account._id);
      let admitted;
      try {
        admitted = await transaction(async (session) => {
          const current = await context(session, token);
          if (current.failure) return current;
          const reservation = await lease(session, current, null, false);
          if (reservation.failure) return reservation;
          const generation = (current.record.passwordChangeGeneration ?? 0) + 1;
          if (!Number.isSafeInteger(generation)) throw unavailable();
          await db
            .collection("staff_sessions")
            .updateOne(
              { _id: current.record._id },
              { $set: { passwordChangeGeneration: generation } },
              { session },
            );
          current.record.passwordChangeGeneration = generation;
          return { ...current, ...reservation };
        });
        const valid = await checked(admitted, "current", () =>
          argon2.verify(admitted.account.passwordHash, password),
        );
        return await transaction(async (session) => {
          const current = await liveJob(session, token, admitted);
          if (current.failure) return current;
          if (!valid) return wrong(session, current.account._id, current.at);
          await challenges().updateMany(
            {
              accountId: current.account._id,
              sessionId: current.record._id,
              purpose: "password-change",
              consumedAt: null,
              revokedAt: null,
            },
            { $set: { revokedAt: current.at } },
            { session },
          );
          const challenge = randomBytes(32).toString("base64url"),
            mfa = requiresMfa(current.account.roles);
          await challenges().insertOne(
            {
              _id: digest(challenge),
              accountId: current.account._id,
              sessionId: current.record._id,
              purpose: "password-change",
              version: current.account.version,
              generation: current.record.passwordChangeGeneration,
              mfaVersion: current.account.mfa?.version,
              state: mfa ? "mfa" : "ready",
              passwordVerifiedAt: current.at,
              expiresAt: admitted.expiresAt,
              consumedAt: null,
              revokedAt: null,
            },
            { session },
          );
          return {
            challenge,
            kind: mfa ? "password_mfa" : "password_ready",
            expiresAt: admitted.expiresAt.toISOString(),
            serverNow: current.at.toISOString(),
          };
        });
      } finally {
        try {
          if (admitted) await release(actor.account._id, admitted.jobId);
        } catch {
          // A failed cleanup must not mask the original result. The lease is
          // bounded by authorization expiry; a newer job cannot be cleared.
        } finally {
          free();
        }
      }
    },
    async identify(token, input) {
      fields(input, ["challenge", "method", "code"]);
      return transaction(async (session) => {
        const actor = await context(session, token);
        if (actor.failure) return actor;
        const count = await counter(session, actor.account._id, actor.at);
        if (count.failure) return count;
        const authorization = await proof(session, actor, input.challenge);
        if (authorization.failure) return authorization;
        if (authorization.state !== "mfa" || !requiresMfa(actor.account.roles))
          return { failure: expired() };
        if (
          !(await consumeFactor(
            session,
            actor.account,
            input.method,
            input.code,
            actor.at,
          ))
        )
          return wrong(session, actor.account._id, actor.at);
        await challenges().updateOne(
          { _id: authorization._id },
          { $set: { state: "ready", mfaVerifiedAt: actor.at } },
          { session },
        );
        return {
          kind: "password_ready",
          expiresAt: authorization.expiresAt.toISOString(),
          serverNow: actor.at.toISOString(),
        };
      });
    },
    async complete(token, input) {
      passwordChangeInput(input); // Basic refusals do not consume the allowance.
      const actor = await transaction((session) => context(session, token));
      const password = passwordChangeInput(input, actor.account.username),
        free = processGate.acquire(actor.account._id);
      let admitted;
      try {
        admitted = await transaction(async (session) => {
          const current = await context(session, token);
          if (current.failure) return current;
          const authorization = await proof(
            session,
            current,
            input.challenge,
            true,
          );
          if (authorization.failure) return authorization;
          const reservation = await lease(
            session,
            current,
            authorization,
            true,
          );
          return reservation.failure
            ? reservation
            : { ...current, ...reservation };
        });
        const check = () =>
          transaction((session) =>
            liveJob(session, token, admitted, input.challenge),
          );
        let reused = await checked(admitted, "history-current", () =>
          argon2.verify(admitted.account.passwordHash, password),
        );
        // Cursor and one-at-a-time verification: no age filter, result limit,
        // growing in-memory list, or weaker comparison fingerprint.
        const cursor = history()
          .find({ accountId: actor.account._id })
          .sort({ credentialVersion: 1 })
          .batchSize(16);
        try {
          for await (const entry of cursor) {
            if (reused) break;
            await check();
            if (!Number.isInteger(entry.credentialVersion) || !entry.hashCipher)
              throw unavailable();
            const hash = vault.decrypt(entry.hashCipher);
            if (!hash.startsWith("$argon2id$")) throw unavailable();
            reused = await checked(admitted, "history", () =>
              argon2.verify(hash, password),
            );
          }
        } finally {
          await cursor.close();
        }
        await check();
        if (reused)
          throw new StaffError(
            "password_reused",
            "Choose a password you have never used for this account.",
          );
        const hash = await checked(admitted, "hash", () =>
          argon2.hash(password, hashOptions),
        );
        return await transaction(async (session) => {
          const current = await liveJob(
            session,
            token,
            admitted,
            input.challenge,
          );
          if (current.failure) return current;
          await history().insertOne(
            {
              _id: randomUUID(),
              accountId: current.account._id,
              credentialVersion: current.account.version,
              hashCipher: vault.encrypt(current.account.passwordHash),
              retiredAt: current.at,
            },
            { session },
          );
          const updated = await accounts().updateOne(
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
          if (updated.modifiedCount !== 1) throw expired();
          await db.collection("staff_sessions").updateMany(
            { accountId: current.account._id, revokedAt: null },
            {
              $set: {
                revokedAt: current.at,
                revocationReason: "password_changed",
              },
            },
            { session },
          );
          await challenges().updateMany(
            { accountId: current.account._id, consumedAt: null },
            {
              $set: {
                consumedAt: current.at,
                revokedAt: current.at,
                revocationReason: "password_changed",
              },
            },
            { session },
          );
          await db.collection("contact_requests").updateMany(
            { accountId: current.account._id },
            {
              $set: {
                revokedAt: current.at,
                revocationReason: "password_changed",
                state: "cancelled",
              },
            },
            { session },
          );
          await event(
            session,
            current.account._id,
            "complete",
            "allowed",
            current.at,
          );
          return { passwordChanged: true };
        });
      } finally {
        try {
          if (admitted) await release(actor.account._id, admitted.jobId);
        } catch {
          // In particular, do not report a committed save as failed merely
          // because its bounded job-lease cleanup lost the database connection.
        } finally {
          free();
        }
      }
    },
    async cancel(token, input) {
      fields(input, []);
      return transaction(async (session) => {
        const actor = await context(session, token);
        if (actor.failure) return actor;
        const generation = (actor.record.passwordChangeGeneration ?? 0) + 1;
        if (!Number.isSafeInteger(generation)) throw unavailable();
        await db
          .collection("staff_sessions")
          .updateOne(
            { _id: actor.record._id },
            { $set: { passwordChangeGeneration: generation } },
            { session },
          );
        await challenges().updateMany(
          {
            accountId: actor.account._id,
            sessionId: actor.record._id,
            purpose: "password-change",
            consumedAt: null,
            revokedAt: null,
          },
          { $set: { revokedAt: actor.at } },
          { session },
        );
        return { cancelled: true };
      });
    },
  };
}
