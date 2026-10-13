import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { StaffError, unavailable } from "./errors.js";
import { normalizeUsername } from "./validation.js";

export const EMERGENCY_POLICY = Object.freeze({
  version: 1,
  displayMs: 60000,
  grantMs: 300000,
  failures: 5,
  windowMs: 900000,
  cooldownMs: 900000,
});
const randomSecret = () => randomBytes(32).toString("base64url");
const validSecret = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const denied = () =>
  new StaffError(
    "emergency_denied",
    "Emergency recovery could not be authorized. Check private custody instructions.",
    403,
  );
const same = (left, right) =>
  typeof right === "string" &&
  /^[a-f0-9]{64}$/.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

// This module has NO HTTP route. Only the protected local operator tool calls
// it. A server-side verifier and separately held bearer are both required.
export function createEmergencyRecovery({
  db,
  vault,
  transaction,
  guard,
  now,
  recovery,
}) {
  const state = () => db.collection("staff_emergency_state"),
    requests = () => db.collection("staff_recovery_requests");
  const seal = (...values) => vault.contactDigest(JSON.stringify(values));
  async function installation(session) {
    const marker = await db
      .collection("installation_state")
      .findOne({ _id: "first-admin" }, { session });
    if (!marker?.firstAccountId || marker.status !== "completed")
      throw unavailable();
    return seal("installation", marker.firstAccountId);
  }
  async function manager(session, bearer) {
    const actor = await recovery.operator.manager(session, bearer);
    return actor;
  }
  async function target(session, username) {
    const account = await db
      .collection("accounts")
      .findOne({ username: normalizeUsername(username) }, { session });
    if (
      !account ||
      account.status !== "active" ||
      !account.roles?.includes("Admin") ||
      (!recovery.operator.activated(account) && !account.recoveryCaseId)
    )
      return null;
    const profile = await db
      .collection("staff_profiles")
      .findOne({ accountId: account._id }, { session });
    if (!profile || (account.profileId && account.profileId !== profile._id))
      return null;
    return account;
  }
  async function attempts(session) {
    return recovery.operator.counted(session, "emergency:installation", now());
  }
  async function wrong(session) {
    const count = await recovery.operator.counted(
      session,
      "emergency:installation",
      now(),
      false,
      true,
    );
    await recovery.operator.event(
      session,
      "emergency_refused",
      null,
      null,
      "denied",
    );
    return count.failure ? count : { failure: denied() };
  }
  return {
    async prepare(bearer, { confirmedCEO = false, replace = false } = {}) {
      if (confirmedCEO !== true) throw denied();
      return transaction(async (session) => {
        await guard(session);
        const actor = await manager(session, bearer);
        if (actor.failure) return actor;
        const existing = await state().findOne(
          { _id: "installation" },
          { session },
        );
        if (existing?.current && replace !== true) return { failure: denied() };
        const binding = await installation(session),
          secret = randomSecret(),
          proof = randomSecret();
        const generation = randomUUID(),
          at = now();
        // Unacknowledged candidates never replace an acknowledged key.
        await state().updateOne(
          { _id: "installation" },
          {
            $set: {
              binding,
              candidate: {
                version: 1,
                generation,
                verifier: seal("emergency-key", binding, generation, secret),
                proofDigest: seal("custody", proof),
                actorId: actor.account._id,
                actorVersion: actor.account.version,
                sessionId: actor.record._id,
                expiresAt: new Date(+at + 60000),
              },
            },
          },
          { session, upsert: true },
        );
        await recovery.operator.event(
          session,
          "emergency_custody_prepared",
          actor.account._id,
          actor.account._id,
        );
        return {
          secret,
          proof,
          expiresAt: new Date(+at + 60000).toISOString(),
          serverNow: at.toISOString(),
        };
      });
    },
    async acknowledge(bearer, { proof, custodyConfirmed = false } = {}) {
      if (custodyConfirmed !== true || !validSecret(proof)) throw denied();
      return transaction(async (session) => {
        await guard(session);
        const actor = await manager(session, bearer);
        if (actor.failure) return actor;
        const record = await state().findOne(
            { _id: "installation" },
            { session },
          ),
          candidate = record?.candidate;
        if (
          !candidate ||
          candidate.actorId !== actor.account._id ||
          candidate.actorVersion !== actor.account.version ||
          candidate.sessionId !== actor.record._id ||
          candidate.expiresAt <= now() ||
          !same(seal("custody", proof), candidate.proofDigest) ||
          record.binding !== (await installation(session))
        )
          return { failure: denied() };
        const { proofDigest, sessionId, actorVersion, expiresAt, ...current } =
          candidate;
        await state().updateOne(
          { _id: record._id },
          {
            $set: {
              current: {
                ...current,
                acknowledgedAt: now(),
                consumedAt: null,
                revokedAt: null,
              },
              ...(record.emergencyCase && !record.emergencyCase.closedAt
                ? { "emergencyCase.revokedAt": now() }
                : {}),
            },
            $unset: { candidate: "" },
          },
          { session },
        );
        await recovery.operator.event(
          session,
          "emergency_custody_acknowledged",
          actor.account._id,
          actor.account._id,
        );
        return { ready: true };
      });
    },
    async revoke(bearer, { confirmed = false } = {}) {
      if (!confirmed) throw denied();
      return transaction(async (session) => {
        await guard(session);
        const actor = await manager(session, bearer);
        if (actor.failure) return actor;
        const existing = await state().findOne(
          { _id: "installation" },
          { session },
        );
        await state().updateOne(
          { _id: "installation" },
          {
            $set: {
              "current.revokedAt": now(),
              ...(existing?.emergencyCase
                ? { "emergencyCase.revokedAt": now() }
                : {}),
            },
            $unset: { candidate: "" },
          },
          { session },
        );
        await recovery.operator.event(
          session,
          "emergency_key_revoked",
          actor.account._id,
          actor.account._id,
        );
        return { revoked: true };
      });
    },
    async redeem({
      secret,
      username,
      scope,
      emergencyAcknowledged,
      resumeSecret,
      resumeCustodyConfirmed,
    }) {
      if (
        !validSecret(resumeSecret) ||
        resumeCustodyConfirmed !== true ||
        emergencyAcknowledged !== true ||
        !["password", "mfa", "both"].includes(scope)
      )
        throw denied();
      return transaction(async (session) => {
        await guard(session);
        const count = await attempts(session);
        if (count.failure) return count;
        const record = await state().findOne(
            { _id: "installation" },
            { session },
          ),
          current = record?.current;
        if (
          !validSecret(secret) ||
          !current ||
          current.consumedAt ||
          current.revokedAt ||
          current.version !== 1 ||
          record.binding !== (await installation(session)) ||
          !same(
            seal("emergency-key", record.binding, current.generation, secret),
            current.verifier,
          )
        )
          return wrong(session);
        const account = await target(session, username);
        if (!account) return wrong(session);
        const existingCase = account.recoveryCaseId
          ? await db
              .collection("staff_recovery_cases")
              .findOne(
                { _id: account.recoveryCaseId, accountId: account._id },
                { session },
              )
          : null;
        if (
          account.recoveryCaseId &&
          (!existingCase ||
            existingCase.closedAt ||
            existingCase.revokedAt ||
            (scope === "password" && !account.mfa?.enabled))
        )
          return wrong(session);
        const caseId = randomUUID();
        await state().updateOne(
          {
            _id: record._id,
            "current.generation": current.generation,
            "current.consumedAt": null,
          },
          {
            $set: {
              "current.consumedAt": now(),
              emergencyCase: {
                id: caseId,
                accountId: account._id,
                version: account.version,
                scope,
                profileBinding: await recovery.operator.profileBinding(
                  session,
                  account,
                ),
                generation: current.generation,
                resumeVerifier: seal(
                  "emergency-resume",
                  record.binding,
                  caseId,
                  resumeSecret,
                ),
                createdAt: now(),
                closedAt: null,
                ...(existingCase ? { recoveryCaseId: existingCase._id } : {}),
              },
            },
          },
          { session },
        );
        if (existingCase)
          await db
            .collection("staff_recovery_cases")
            .updateOne(
              { _id: existingCase._id },
              { $set: { origin: "emergency" } },
              { session },
            );
        const issued = await recovery.operator.grant(
          session,
          account,
          "emergency",
          scope,
          {
            state: "handoff",
            emergencyCase: caseId,
            expiresAt: new Date(+now() + 300000),
            ...(existingCase
              ? {
                  caseId: existingCase._id,
                  caseGeneration: existingCase.generation,
                }
              : {}),
          },
        );
        await recovery.operator.event(
          session,
          "emergency_authorized",
          account._id,
        );
        return {
          handoff: issued.challenge,
          expiresAt: issued.expiresAt,
          serverNow: issued.serverNow,
        };
      });
    },
    async resume({ resumeSecret, emergencyAcknowledged }) {
      if (emergencyAcknowledged !== true) throw denied();
      return transaction(async (session) => {
        await guard(session);
        const count = await attempts(session);
        if (count.failure) return count;
        const record = await state().findOne(
            { _id: "installation" },
            { session },
          ),
          item = record?.emergencyCase;
        if (
          !validSecret(resumeSecret) ||
          !item ||
          item.closedAt ||
          item.revokedAt ||
          record.binding !== (await installation(session)) ||
          !same(
            seal("emergency-resume", record.binding, item.id, resumeSecret),
            item.resumeVerifier,
          )
        )
          return wrong(session);
        const account = await db
          .collection("accounts")
          .findOne({ _id: item.accountId }, { session });
        if (
          !account ||
          account.status !== "active" ||
          !account.roles.includes("Admin") ||
          account.version !== item.version
        )
          return { failure: denied() };
        if (
          item.profileBinding !==
          (await recovery.operator.profileBinding(session, account))
        )
          return { failure: denied() };
        let metadata = {
          state: "handoff",
          emergencyCase: item.id,
          expiresAt: new Date(+now() + 300000),
        };
        // After intentional redemption, only resume that same restricted case.
        if (account.recoveryCaseId) {
          const recoveryCase = await db
            .collection("staff_recovery_cases")
            .findOne({ _id: account.recoveryCaseId }, { session });
          if (
            !recoveryCase ||
            recoveryCase.origin !== "emergency" ||
            recoveryCase.closedAt ||
            recoveryCase.revokedAt
          )
            return { failure: denied() };
          metadata = {
            ...metadata,
            caseId: recoveryCase._id,
            caseGeneration: recoveryCase.generation,
            resumeOnly: true,
          };
        } else if (account.version !== item.version)
          return { failure: denied() };
        await requests().updateMany(
          { accountId: account._id, emergencyCase: item.id, revokedAt: null },
          { $set: { revokedAt: now() } },
          { session },
        );
        const issued = await recovery.operator.grant(
          session,
          account,
          "emergency",
          item.scope,
          metadata,
        );
        await recovery.operator.event(
          session,
          "emergency_resumed",
          account._id,
        );
        return {
          handoff: issued.challenge,
          expiresAt: issued.expiresAt,
          serverNow: issued.serverNow,
        };
      });
    },
  };
}
