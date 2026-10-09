import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { StaffError, unavailable } from "./errors.js";
import {
  allowFields,
  expectedVersion,
  expectedRevision,
} from "./management-validation.js";
import { profileRevision } from "./management.js";
import { contactStatus, reservesEmail } from "./contact-status.js";
import {
  normalizeEmail,
  createGmailDelivery,
  safeDeliveryError,
} from "./contact-delivery.js";

export const CONTACT_COLLECTIONS = Object.freeze([
  "contact_requests",
  "contact_counters",
  "contact_delivery_budgets",
]);
export const CONTACT_POLICY = Object.freeze({
  identityMs: 5 * 60000,
  codeMs: 10 * 60000,
  maxFailures: 5,
  windowMs: 15 * 60000,
  cooldownMs: 15 * 60000,
  resendMs: 60000,
  maxResends: 2,
  hourly: 3,
  daily: 10,
  monthly: 20,
});
const problem = (code, message, status = 409) =>
  new StaffError(`contact_${code}`, message, status);
const failure = () =>
  problem(
    "verification_failed",
    "Contact verification failed. Check the details or start again.",
    401,
  );
const limited = () =>
  problem(
    "try_later",
    "Contact changes are temporarily limited. Wait before trying again; ordinary sign-in remains available.",
    429,
  );
const instant = (value) =>
  value instanceof Date && Number.isFinite(value.getTime());
// A newly assigned receptionist may never have enrolled a factor. BSON stores
// undefined object fields as null; use an explicit no-factor sentinel in request
// bindings, without backfilling/changing the account or relaxing MFA policy.
const factorVersion = (account) =>
  account.mfa?.version === undefined ? null : account.mfa.version;
const requestType = (input) => {
  if (!["email", "phone"].includes(input.type))
    throw new StaffError("invalid_input", "Choose email or phone.");
  return input.type;
};
const destinationFor = (type, value) => {
  if (type === "email") return normalizeEmail(value);
  if (typeof value !== "string" || !/^\+[1-9]\d{7,14}$/.test(value.trim()))
    throw new StaffError("invalid_input", "Use an international phone number.");
  return value.trim();
};
const secret = (value) =>
  typeof value === "string" && value.length <= 512 ? value : "";
const sameDigest = (left, right) =>
  typeof right === "string" &&
  /^[a-f0-9]{64}$/.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
export function beirutMonth(at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(at);
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}`;
}

export function createContactService({
  db,
  client,
  vault,
  transaction,
  guard,
  authenticated,
  now,
  checkPassword,
  consumeFactor,
  requiresMfa,
  recentVerificationExpiry,
  delivery,
}) {
  if (delivery) {
    const hosts = client?.options?.hosts ?? [];
    if (
      db.databaseName !== "capstone_staff_test" ||
      hosts.length !== 1 ||
      hosts[0].host !== "127.0.0.1" ||
      hosts[0].port !== 27018 ||
      Object.values(delivery).some((provider) => provider?.mode !== "test")
    )
      throw new Error(
        "Mock delivery is restricted to the guarded test database.",
      );
  }
  // A TEST process must never read real sender credentials or send real mail,
  // even if the workstation is configured later. Only explicit guarded mocks
  // can enable its contact tests.
  const providers =
    delivery ??
    (db.databaseName === "capstone_staff_test"
      ? {
          email: {
            mode: "test",
            provider: "gmail",
            async configuration() {
              throw problem(
                "provider_not_ready",
                "TEST delivery requires an explicit guarded mock.",
              );
            },
          },
        }
      : { email: createGmailDelivery() });
  const requests = () => db.collection("contact_requests");
  const counters = () => db.collection("contact_counters");
  const budgets = () => db.collection("contact_delivery_budgets");
  const key = (context, type) => `${context.account._id}:${type}`;
  function providerFor(type) {
    if (type === "phone" && !delivery?.phone)
      throw problem(
        "change_not_ready",
        "Phone changes are unavailable until real WhatsApp delivery is configured and successfully tested.",
      );
    if (!providers[type])
      throw problem(
        "provider_not_ready",
        "Contact delivery is not configured.",
      );
    return providers[type];
  }
  async function event(
    session,
    context,
    action,
    outcome = "success",
    reason,
    targetId = context.account._id,
  ) {
    await db.collection("security_events").insertOne(
      {
        occurredAt: now(),
        action,
        actorId: context.account._id,
        targetAccountId: targetId,
        accountId: context.account._id,
        outcome,
        ...(reason ? { reason } : {}),
      },
      { session },
    );
  }
  async function run(token, action) {
    return transaction(async (session) => {
      await guard(session);
      const at = now(),
        context = await authenticated(session, token, at);
      return context.failure ? context : action(session, context, at);
    });
  }
  async function availableEmail(session, destination, accountId) {
    // Derive ownership from current authoritative proof, not a new copied
    // reservation field/index needing a contact migration. The shared guard
    // serializes these reads with completion, release and account reactivation.
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
      (profile) =>
        reservesEmail(
          profile,
          vault,
          db.databaseName === "capstone_staff_test",
        ) && String(profile.email).trim().toLowerCase() === destination,
    );
    if (
      owners.length > 1 ||
      owners.some(
        (profile) =>
          typeof profile.accountId !== "string" || !profile.accountId,
      )
    )
      throw problem(
        "ownership_conflict",
        "Existing email ownership needs an Admin review. No contact was changed.",
      );
    if (owners.some((profile) => profile.accountId !== accountId))
      throw problem("email_in_use", "This email is used by another account");
  }
  const counterKey = (purpose, context, type) =>
    `${purpose}:${context.account._id}${type ? `:${type}` : ""}`;
  async function blocked(session, id, at) {
    const record = await counters().findOne({ _id: id }, { session });
    if (
      record &&
      (!Number.isInteger(record.failures) ||
        record.failures < 0 ||
        !instant(record.startedAt) ||
        (record.blockedUntil !== null && !instant(record.blockedUntil)))
    )
      throw unavailable();
    return record?.blockedUntil > at;
  }
  async function reject(session, context, type, purpose, at) {
    const id = counterKey(purpose, context, type),
      prior = await counters().findOne({ _id: id }, { session });
    const fresh = !prior || at - prior.startedAt >= CONTACT_POLICY.windowMs;
    const failures = fresh ? 1 : prior.failures + 1;
    await counters().replaceOne(
      { _id: id },
      {
        _id: id,
        startedAt: fresh ? at : prior.startedAt,
        failures,
        blockedUntil:
          failures >= CONTACT_POLICY.maxFailures
            ? new Date(+at + CONTACT_POLICY.cooldownMs)
            : null,
        expiresAt: new Date(
          +at + CONTACT_POLICY.windowMs + CONTACT_POLICY.cooldownMs,
        ),
      },
      { session, upsert: true },
    );
    await event(
      session,
      context,
      "contact_verification_rejected",
      "denied",
      purpose,
    );
    return { failure: failure() }; // Commit attempts, never throw them away.
  }
  async function identityAllowed(session, context, type, at) {
    if (
      (await blocked(session, counterKey("identity", context), at)) ||
      (await blocked(session, counterKey("code", context, type), at))
    )
      throw limited();
  }
  function bound(request, context, type, at) {
    return (
      request &&
      request.type === type &&
      request.accountId === context.account._id &&
      request.sessionId === context.record._id &&
      request.version === context.account.version &&
      request.mfaVersion === factorVersion(context.account) &&
      instant(request.expiresAt) &&
      request.expiresAt > at &&
      instant(request.createdAt) &&
      request.createdAt <= at &&
      (request.state === "identity" ||
        (request.deliveryMode === providerFor(type).mode &&
          request.provider === providerFor(type).provider)) &&
      request.profileRevision === profileRevision(context.profile)
    );
  }
  async function reserveBudget(
    session,
    context,
    type,
    destination,
    provider,
    config,
    at,
    notification = false,
  ) {
    const providerId =
      provider.mode === "test"
        ? `test-${provider.provider}`
        : provider.provider;
    const ids = [
      {
        id: `month:${providerId}:${beirutMonth(at)}`,
        max: CONTACT_POLICY.monthly,
      },
      {
        id: `approval:${providerId}:${config.approvalId}`,
        max: config.allowance,
      },
    ];
    for (const { id, max } of ids) {
      const record = await budgets().findOne({ _id: id }, { session });
      if (record && (!Number.isInteger(record.attempts) || record.attempts < 0))
        throw unavailable();
      if ((record?.attempts ?? 0) >= max)
        throw safeDeliveryError({ code: "contact_sending_limit" });
    }
    if (!notification) {
      const sendIds = [
        `send:account:${key(context, type)}`,
        `send:destination:${type}:${vault.contactDigest(destination)}`,
      ];
      for (const id of sendIds) {
        const prior = await counters().findOne({ _id: id }, { session });
        if (
          prior &&
          (!Array.isArray(prior.attempts) ||
            prior.attempts.some((value) => !instant(value)))
        )
          throw unavailable();
        const attempts = (prior?.attempts ?? []).filter(
          (value) => at - value < 24 * 60 * 60000,
        );
        if (
          attempts.length >= CONTACT_POLICY.daily ||
          attempts.filter((value) => at - value < 60 * 60000).length >=
            CONTACT_POLICY.hourly
        )
          throw limited();
        await counters().replaceOne(
          { _id: id },
          {
            _id: id,
            attempts: [...attempts, at],
            expiresAt: new Date(+at + 24 * 60 * 60000),
          },
          { session, upsert: true },
        );
      }
    }
    for (const { id } of ids)
      await budgets().updateOne(
        { _id: id },
        { $inc: { attempts: 1 }, $setOnInsert: { createdAt: at } },
        { session, upsert: true },
      );
  }
  function pendingPayload(request, provider) {
    return {
      type: request.type,
      destination: request.destination,
      state: request.state,
      expiresAt: request.expiresAt.toISOString(),
      resendAt: new Date(
        +request.lastSendAt + CONTACT_POLICY.resendMs,
      ).toISOString(),
      resendsRemaining: CONTACT_POLICY.maxResends - request.resends,
      testOnly: provider.mode === "test",
    };
  }
  async function reserveCode(session, context, request, at, resend = false) {
    if (request.type === "email")
      await availableEmail(session, request.destination, context.account._id);
    const provider = providerFor(request.type),
      config = await provider.configuration(request.destination);
    await reserveBudget(
      session,
      context,
      request.type,
      request.destination,
      provider,
      config,
      at,
    );
    let code;
    do {
      code = String(randomInt(0, 100000000)).padStart(8, "0");
    } while (
      request.codeHash &&
      sameDigest(
        vault.contactDigest(
          JSON.stringify([
            request.accountId,
            request.type,
            request.destination,
            request.generation,
            code,
          ]),
        ),
        request.codeHash,
      )
    ); // A resend must not accidentally repeat its old value.
    const generation = randomBytes(16).toString("hex");
    const next = {
      ...request,
      generation,
      state: "delivering",
      deliveryMode: provider.mode,
      provider: provider.provider,
      lastSendAt: at,
      resends: resend ? request.resends + 1 : 0,
      expiresAt: resend
        ? request.expiresAt
        : new Date(
            Math.min(
              +at + CONTACT_POLICY.codeMs,
              +context.record.absoluteExpiresAt,
            ),
          ),
      codeHash: vault.contactDigest(
        JSON.stringify([
          request.accountId,
          request.type,
          request.destination,
          generation,
          code,
        ]),
      ),
    };
    delete next.challengeHash;
    await requests().replaceOne({ _id: request._id }, next, { session });
    await event(
      session,
      context,
      resend ? "contact_resend_reserved" : "contact_delivery_reserved",
    );
    return { job: { request: next, code, provider } };
  }
  async function sendReserved(token, result) {
    if (!result.job) return result;
    const { request, code, provider } = result.job;
    let accepted = false;
    let deliveryFailure;
    try {
      await provider.send({
        destination: request.destination,
        code,
        expiresAt: request.expiresAt,
      });
      accepted = true;
    } catch (error) {
      deliveryFailure = safeDeliveryError(error);
    }
    return run(token, async (session, context, at) => {
      const current = await requests().findOne(
        { _id: request._id },
        { session },
      );
      if (
        !bound(current, context, request.type, at) ||
        current.generation !== request.generation ||
        current.state !== "delivering"
      ) {
        throw problem(
          "request_expired",
          "This contact request is no longer current. Your saved contact was not changed.",
        );
      }
      await requests().updateOne(
        { _id: current._id, generation: current.generation },
        accepted
          ? { $set: { state: "pending" } }
          : { $set: { state: "delivery_failed" }, $unset: { codeHash: "" } },
        { session },
      );
      await event(
        session,
        context,
        "contact_delivery",
        accepted ? "accepted" : "failed",
      );
      if (!accepted)
        return {
          failure: deliveryFailure,
        };
      return {
        sent: true,
        ...pendingPayload({ ...current, state: "pending" }, provider),
      };
    });
  }
  return {
    async releaseEmail(token, id, input) {
      allowFields(input, ["expectedVersion", "expectedRevision", "confirmed"]);
      const version = expectedVersion(input.expectedVersion),
        revision = expectedRevision(input.expectedRevision);
      return run(token, async (session, context, at) => {
        if (
          !context.account.roles.includes("Admin") ||
          context.account._id === id
        )
          throw new StaffError(
            "permission_denied",
            "Only another Admin may release a deactivated account's verified email.",
            403,
          );
        if (input.confirmed !== true)
          throw new StaffError(
            "invalid_input",
            "Confirm that the deactivated account will lose this email reservation.",
          );
        if (!recentVerificationExpiry(context.record, context.account, at))
          throw new StaffError(
            "verification_required",
            "Verify your password and authenticator or an unused backup code before this action.",
            403,
          );
        const account = await db
          .collection("accounts")
          .findOne({ _id: id }, { session });
        const profile = await db
          .collection("staff_profiles")
          .findOne({ accountId: id }, { session });
        if (!account || !profile)
          throw problem(
            "release_unavailable",
            "This staff record could not be released.",
          );
        if (account.version !== version)
          throw new StaffError(
            "stale_record",
            "This record changed. Reload it before saving again.",
            409,
          );
        if (account.status !== "disabled")
          throw problem(
            "release_unavailable",
            "Email release is only available for another deactivated account.",
          );
        if (contactStatus(profile, vault).email === "released")
          return { released: false, alreadyReleased: true };
        if (profileRevision(profile) !== revision)
          throw new StaffError(
            "stale_record",
            "This record changed. Reload it before saving again.",
            409,
          );
        if (
          !reservesEmail(
            profile,
            vault,
            db.databaseName === "capstone_staff_test",
          )
        )
          throw problem(
            "release_unavailable",
            "This account has no current verified email reservation to release.",
          );
        await availableEmail(
          session,
          String(profile.email).trim().toLowerCase(),
          id,
        );
        await db.collection("staff_profiles").updateOne(
          { _id: profile._id },
          {
            $set: {
              "emailVerification.releasedAt": at,
              "emailVerification.releasedBy": context.account._id,
              revision: revision + 1,
              updatedAt: at,
            },
          },
          { session },
        );
        await requests().updateMany(
          {
            state: {
              $in: ["identity", "delivering", "pending", "delivery_failed"],
            },
            $or: [
              { accountId: id },
              {
                type: "email",
                destination: String(profile.email).trim().toLowerCase(),
              },
            ],
          },
          {
            $set: {
              state: "cancelled",
              cancelledAt: at,
              cancellationReason: "email_released",
              generation: randomBytes(16).toString("hex"),
            },
            $unset: { codeHash: "", challengeHash: "", destination: "" },
          },
          { session },
        );
        await event(
          session,
          context,
          "staff_email_released",
          "success",
          undefined,
          id,
        );
        return { released: true };
      });
    },
    async status(token) {
      return run(token, async (session, context, at) => {
        let emailReady = false;
        let deliveryIssue;
        try {
          await providerFor("email").configuration();
          emailReady = true;
        } catch (error) {
          deliveryIssue = safeDeliveryError(error);
        }
        const request = await requests().findOne(
          { _id: key(context, "email") },
          { session },
        );
        const pending =
          request &&
          bound(request, context, "email", at) &&
          ["pending", "delivering", "delivery_failed"].includes(request.state)
            ? pendingPayload(request, providerFor("email"))
            : null;
        return {
          emailReady,
          phoneReady: false,
          pending,
          contactStatus: contactStatus(context.profile, vault),
          message: emailReady
            ? "Verify your own proposed email in the app. The center configures its sender once; no recipient approval is required."
            : deliveryIssue.message,
          deliveryStatus: emailReady ? "ready" : deliveryIssue.code,
          phoneMessage:
            "Phone changes are unavailable. Live WhatsApp delivery has not been configured or tested.",
        };
      });
    },
    async start(token, input) {
      allowFields(input, [
        "type",
        "destination",
        "password",
        "expectedRevision",
      ]);
      const type = requestType(input),
        destination = destinationFor(type, input.destination),
        provider = providerFor(type);
      const result = await run(token, async (session, context, at) => {
        // A valid, value-bound live proof is authoritative. Reject this no-op
        // before touching challenges/counters/factors or consulting delivery.
        // Throwing aborts the guard transaction, preserving all existing state.
        if (
          type === "email" &&
          contactStatus(context.profile, vault).email === "verified" &&
          normalizeEmail(context.profile.email) === destination
        )
          throw problem(
            "email_already_verified",
            "This email is already verified. Enter a different address to change it.",
          );
        await identityAllowed(session, context, type, at);
        if (type === "email")
          await availableEmail(session, destination, context.account._id);
        await provider.configuration(destination); // No counter/send without operator-enabled delivery.
        if (
          !Number.isInteger(input.expectedRevision) ||
          input.expectedRevision !== profileRevision(context.profile)
        )
          throw problem(
            "stale_profile",
            "Your profile changed. Reload before requesting a replacement.",
          );
        if (!(await checkPassword(context.account, secret(input.password))))
          return reject(session, context, undefined, "identity", at);
        const challenge = randomBytes(32).toString("base64url");
        const request = {
          _id: key(context, type),
          accountId: context.account._id,
          type,
          destination,
          state: "identity",
          version: context.account.version,
          sessionId: context.record._id,
          mfaVersion: factorVersion(context.account),
          profileRevision: profileRevision(context.profile),
          createdAt: at,
          passwordVerifiedAt: at,
          expiresAt: new Date(
            Math.min(
              +at + CONTACT_POLICY.identityMs,
              +context.record.absoluteExpiresAt,
            ),
          ),
          challengeHash: vault.contactDigest(challenge),
        };
        await requests().replaceOne({ _id: request._id }, request, {
          session,
          upsert: true,
        });
        await event(session, context, "contact_identity_password_verified");
        if (requiresMfa(context.account.roles))
          return {
            challenge,
            kind: "contact_identity",
            type,
            expiresAt: request.expiresAt.toISOString(),
          };
        return reserveCode(session, context, request, at);
      });
      return sendReserved(token, result);
    },
    async identity(token, input) {
      allowFields(input, ["type", "challenge", "code", "method"]);
      const type = requestType(input);
      providerFor(type);
      if (!["totp", "backup"].includes(input.method))
        throw new StaffError(
          "invalid_input",
          "Choose authenticator or backup code.",
        );
      const result = await run(token, async (session, context, at) => {
        await identityAllowed(session, context, type, at);
        const request = await requests().findOne(
          { _id: key(context, type) },
          { session },
        );
        if (
          !bound(request, context, type, at) ||
          request.state !== "identity" ||
          !sameDigest(
            vault.contactDigest(secret(input.challenge)),
            request.challengeHash,
          ) ||
          !requiresMfa(context.account.roles)
        )
          return reject(session, context, undefined, "identity", at);
        if (
          !(await consumeFactor(
            session,
            context.account,
            input.method,
            secret(input.code),
            at,
          ))
        )
          return reject(session, context, undefined, "identity", at);
        // This consumes the contact identity proof only. Never refresh manager
        // verification/session activity or extend original absolute deadlines.
        return reserveCode(
          session,
          context,
          { ...request, mfaVerifiedAt: at },
          at,
        );
      });
      return sendReserved(token, result);
    },
    async resend(token, input) {
      allowFields(input, ["type"]);
      const type = requestType(input);
      providerFor(type);
      const result = await run(token, async (session, context, at) => {
        await identityAllowed(session, context, type, at);
        const request = await requests().findOne(
          { _id: key(context, type) },
          { session },
        );
        if (
          !bound(request, context, type, at) ||
          !["pending", "delivery_failed", "delivering"].includes(request.state)
        )
          throw problem("request_expired", "Start a new contact request.");
        if (
          request.resends >= CONTACT_POLICY.maxResends ||
          at - request.lastSendAt < CONTACT_POLICY.resendMs
        )
          throw problem(
            "resend_wait",
            "Wait 60 seconds between sends; only two resends are allowed and expiry does not extend.",
          );
        return reserveCode(session, context, request, at, true);
      });
      return sendReserved(token, result);
    },
    async cancel(token, input) {
      allowFields(input, ["type"]);
      const type = requestType(input);
      return run(token, async (session, context, at) => {
        await requests().updateOne(
          { _id: key(context, type) },
          {
            $set: { state: "cancelled", cancelledAt: at },
            $unset: { codeHash: "", challengeHash: "", destination: "" },
          },
          { session },
        );
        await event(session, context, "contact_request_cancelled");
        return { cancelled: true };
      });
    },
    async complete(token, input) {
      allowFields(input, ["type", "code"]);
      const type = requestType(input);
      providerFor(type);
      const result = await run(token, async (session, context, at) => {
        await identityAllowed(session, context, type, at);
        const request = await requests().findOne(
          { _id: key(context, type) },
          { session },
        );
        if (!bound(request, context, type, at) || request.state !== "pending")
          return reject(session, context, type, "code", at);
        const supplied = vault.contactDigest(
          JSON.stringify([
            request.accountId,
            type,
            request.destination,
            request.generation,
            secret(input.code),
          ]),
        );
        if (
          !/^\d{8}$/.test(secret(input.code)) ||
          !sameDigest(supplied, request.codeHash)
        )
          return reject(session, context, type, "code", at);
        const provider = providerFor(type);
        if (type === "email")
          await availableEmail(
            session,
            request.destination,
            context.account._id,
          );
        const proof = {
          verifiedAt: at,
          method: `${type}_code`,
          provider: provider.provider,
          mode: provider.mode,
          valueDigest: vault.contactDigest(request.destination),
        };
        const revision = profileRevision(context.profile);
        const updated = await db.collection("staff_profiles").updateOne(
          {
            _id: context.profile._id,
            accountId: context.account._id,
            ...(context.profile.revision === undefined
              ? { revision: { $exists: false } }
              : { revision }),
          },
          {
            $set: {
              [type]: request.destination,
              [`${type}Verification`]: proof,
              revision: revision + 1,
              updatedAt: at,
            },
          },
          { session },
        );
        if (updated.modifiedCount !== 1)
          throw problem(
            "stale_profile",
            "Your profile changed. Reload before trying again.",
          );
        await requests().updateOne(
          { _id: request._id, generation: request.generation },
          {
            $set: { state: "consumed", consumedAt: at },
            $unset: { codeHash: "", destination: "" },
          },
          { session },
        );
        await event(
          session,
          context,
          "contact_change_completed",
          provider.mode === "test" ? "test_only" : "success",
        );
        return {
          changed: true,
          verified: provider.mode === "live",
          testOnly: provider.mode === "test",
          oldDestination: context.profile[type],
          notify:
            type === "email" &&
            contactStatus(context.profile, vault).email === "verified" &&
            String(context.profile.email).trim().toLowerCase() !==
              request.destination,
        };
      });
      let notificationWarning = false;
      if (result.notify) {
        try {
          const provider = providerFor(type),
            config = await provider.configuration(result.oldDestination);
          await run(token, (session, context, at) =>
            reserveBudget(
              session,
              context,
              type,
              result.oldDestination,
              provider,
              config,
              at,
              true,
            ),
          );
          await provider.send({
            destination: result.oldDestination,
            notification: true,
          });
          await run(token, (session, context) =>
            event(session, context, "contact_old_notification", "accepted"),
          );
        } catch {
          notificationWarning = true;
          await run(token, (session, context) =>
            event(session, context, "contact_old_notification", "failed"),
          ).catch(() => {});
        }
      }
      return {
        changed: result.changed,
        verified: result.verified,
        testOnly: result.testOnly,
        notificationWarning,
      };
    },
  };
}
