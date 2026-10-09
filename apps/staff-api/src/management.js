import { randomBytes, randomUUID } from "node:crypto";
import { contactStatus } from "./contact-status.js";
import {
  phoneNumber,
  PHONE_COUNTRIES,
} from "../../staff/shared/contact-input.js";
import { StaffError, unavailable } from "./errors.js";
import { ROLES, validRoles } from "./permissions.js";
import {
  CONTACT_FIELDS,
  DEPARTMENTS,
  PROFILE_FIELDS,
  allowFields,
  expectedVersion,
  validateContact,
  validateCreate,
  validateManagementProfile,
  validateProfilePatch,
  validateRoles,
} from "./management-validation.js";

export const MANAGEMENT_COLLECTIONS = Object.freeze({
  setupCodes: "account_setup_codes",
  state: "staff_management_state",
});
export const MANAGEMENT_POLICY = Object.freeze({
  setupMs: 30 * 60000,
  setupMaxAttempts: 5,
  recentMs: 5 * 60000,
});
const manager = (account) =>
  account.roles.includes("Admin") || account.roles.includes("System Admin");
const protectedRoles = (roles) =>
  roles.includes("Admin") || roles.includes("System Admin");
const denied = (
  message = "You do not have permission to perform this staff action.",
) => new StaffError("permission_denied", message, 403);
const stale = () =>
  new StaffError(
    "stale_record",
    "This record changed. Reload it before saving again.",
    409,
  );
const accountStatus = new Set([
  "setup_pending",
  "mfa_pending",
  "active",
  "disabled",
]);
const contactOnly = (patch) =>
  Object.keys(patch).every((field) => CONTACT_FIELDS.includes(field));
const protectedWorkFields = ["departments", "employmentStartDate"];
const identityFields = [
  "firstName",
  "lastName",
  "fatherName",
  "motherName",
  "dateOfBirth",
  "qualification",
];

export function profileRevision(profile) {
  const revision = profile.revision === undefined ? 0 : profile.revision;
  if (!Number.isInteger(revision) || revision < 0) throw unavailable();
  return revision;
}

export function eligibleAdmin(account) {
  return Boolean(
    account?.status === "active" &&
    validRoles(account.roles) &&
    account.roles.includes("Admin") &&
    typeof account.passwordHash === "string" &&
    account.passwordHash.length > 0 &&
    Number.isInteger(account.version) &&
    account.version > 0 &&
    account.mfa?.enabled === true &&
    Number.isInteger(account.mfa.version) &&
    account.mfa.version > 0 &&
    account.mfa.secretCipher &&
    account.mfa.backupAcknowledged === true,
  );
}

export function activationState(account) {
  if (account.status === "disabled") return "disabled";
  if (account.status === "setup_pending") return "awaiting_password";
  if (
    account.status === "mfa_pending" ||
    (validRoles(account.roles) &&
      account.roles.some((role) =>
        ["Admin", "System Admin", "Clinic Admin", "Lab Admin"].includes(role),
      ) &&
      account.mfa?.enabled !== true)
  )
    return "mfa_enrollment";
  if (account.mfa?.enabled === true && account.mfa.backupAcknowledged !== true)
    return "backup_acknowledgement";
  return "activated";
}

export function createManagementService({
  db,
  transaction,
  now,
  authenticated,
  guard,
  digestSecret,
  requiresMfa,
  recentVerificationExpiry,
  vault,
}) {
  if (
    !db?.collection ||
    !transaction ||
    !now ||
    !authenticated ||
    !guard ||
    !digestSecret ||
    !requiresMfa ||
    !recentVerificationExpiry
  )
    throw unavailable();
  const collection = (name) => db.collection(name);
  const today = (at) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Beirut",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const profileFields = (profile) =>
    Object.fromEntries(PROFILE_FIELDS.map((field) => [field, profile[field]]));
  function summary(account, profile) {
    if (
      !validRoles(account.roles) ||
      !accountStatus.has(account.status) ||
      !Number.isInteger(account.version) ||
      account.version < 1 ||
      typeof account.username !== "string" ||
      typeof profile?.firstName !== "string" ||
      !profile.firstName.trim() ||
      typeof profile.lastName !== "string" ||
      !profile.lastName.trim() ||
      !Array.isArray(profile.departments) ||
      !profile.departments.length ||
      new Set(profile.departments).size !== profile.departments.length ||
      profile.departments.some(
        (department) => !DEPARTMENTS.includes(department),
      )
    )
      throw unavailable();
    return {
      id: account._id,
      name: `${profile.firstName} ${profile.lastName}`,
      username: account.username,
      roles: [...account.roles],
      departments: [...profile.departments],
      status: account.status,
      activationState: activationState(account),
      version: account.version,
      profileRevision: profileRevision(profile),
    };
  }
  function detail(account, profile) {
    const clean = validateManagementProfile(
      profileFields(profile),
      account.roles,
      today(now()),
      { legacyQualification: profile.qualification, legacyContacts: profile },
    );
    return {
      account: summary(account, profile),
      profile: {
        ...clean,
        phoneCountry: PHONE_COUNTRIES.includes(profile.phoneCountry)
          ? profile.phoneCountry
          : "LB",
        revision: profileRevision(profile),
        contactStatus: contactStatus(profile, vault),
      },
    };
  }
  async function target(session, id) {
    if (typeof id !== "string" || !id || id.length > 160)
      throw new StaffError("invalid_input", "Choose a valid staff account.");
    const account = await collection("accounts").findOne(
      { _id: id },
      { session },
    );
    if (!account)
      throw new StaffError(
        "staff_not_found",
        "This staff account was not found.",
        404,
      );
    const profile = await collection("staff_profiles").findOne(
      { accountId: id },
      { session },
    );
    if (!profile) throw unavailable();
    summary(account, profile);
    return { account, profile };
  }
  function requireManager(actor) {
    if (!manager(actor)) throw denied();
  }
  function requireControl(actor, account, nextRoles = account.roles) {
    requireManager(actor);
    if (actor._id === account._id)
      throw denied(
        "Another authorized manager must change your own roles or account status.",
      );
    if (
      !actor.roles.includes("Admin") &&
      (protectedRoles(account.roles) || protectedRoles(nextRoles))
    )
      throw denied();
  }
  function recent(context, at) {
    const { account, record } = context;
    if (!recentVerificationExpiry(record, account, at)) {
      throw new StaffError(
        "verification_required",
        "Verify your password and authenticator or an unused backup code before this action.",
        403,
      );
    }
  }
  async function event(
    session,
    action,
    actor,
    account,
    outcome = "success",
    reason,
  ) {
    await collection("security_events").insertOne(
      {
        _id: randomUUID(),
        occurredAt: now(),
        action,
        accountId: actor._id,
        actorId: actor._id,
        targetAccountId: account?._id ?? null,
        outcome,
        ...(reason ? { reason } : {}),
      },
      { session },
    );
  }
  async function read(token, callback) {
    return transaction(async (session) => {
      const context = await authenticated(session, token, now());
      return context.failure ? context : callback(session, context);
    });
  }
  async function write(token, callback, action, targetId) {
    try {
      return await transaction(async (session) => {
        await guard(session);
        const at = now();
        const context = await authenticated(session, token, at);
        return context.failure ? context : callback(session, context, at);
      });
    } catch (error) {
      const auditable =
        error instanceof StaffError &&
        [
          "permission_denied",
          "verification_required",
          "last_admin",
          "stale_record",
          "setup_not_available",
          "contact_change_not_ready",
        ].includes(error.code);
      if (auditable && action) {
        // The mutation transaction has already aborted. Never catch a denial
        // inside that transaction and accidentally commit partial changes.
        // Record only actor/target IDs and a fixed error code in a separate
        // guarded transaction; an unavailable audit store fails closed.
        await transaction(async (session) => {
          await guard(session);
          const context = await authenticated(session, token, now());
          if (context.failure) return context;
          const candidateId =
            action === "own_contact_updated" ? context.account._id : targetId;
          const safeId =
            typeof candidateId === "string" && candidateId.length <= 160
              ? candidateId
              : null;
          const storedTarget = safeId
            ? await collection("accounts").findOne(
                { _id: safeId },
                { session, projection: { _id: 1 } },
              )
            : null;
          await event(
            session,
            action,
            context.account,
            storedTarget,
            "denied",
            error.code,
          );
          return { recorded: true };
        });
      }
      throw error;
    }
  }
  async function ensureAdminRemains(session, current, next) {
    if (!eligibleAdmin(current) || eligibleAdmin(next)) return;
    const candidates = await collection("accounts")
      .find(
        { _id: { $ne: current._id }, status: "active", roles: "Admin" },
        { session },
      )
      .toArray();
    if (!candidates.some(eligibleAdmin))
      throw new StaffError(
        "last_admin",
        "At least one fully activated Admin must remain enabled.",
        409,
      );
  }
  function phase(account, roles = account.roles) {
    if (account.passwordHash === undefined || account.passwordHash === null)
      return "setup_pending";
    if (typeof account.passwordHash !== "string" || !account.passwordHash)
      throw unavailable();
    return requiresMfa(roles) && account.mfa?.enabled !== true
      ? "mfa_pending"
      : "active";
  }
  async function revoke(session, account, at, reason) {
    await collection("staff_sessions").updateMany(
      { accountId: account._id, revokedAt: null },
      { $set: { revokedAt: at, revocationReason: reason } },
      { session },
    );
    await collection("auth_challenges").updateMany(
      { accountId: account._id, consumedAt: null },
      { $set: { consumedAt: at, revokedAt: at, revocationReason: reason } },
      { session },
    );
    await collection(MANAGEMENT_COLLECTIONS.setupCodes).updateOne(
      { _id: account._id, consumedAt: null },
      {
        $set: { revokedAt: at, revocationReason: reason },
        $unset: { codeHash: "" },
      },
      { session },
    );
  }
  async function issueCode(session, account, at) {
    const prior = await collection(MANAGEMENT_COLLECTIONS.setupCodes).findOne(
      { _id: account._id },
      { session },
    );
    const previous =
      account.setupGeneration !== undefined
        ? account.setupGeneration
        : prior?.generation !== undefined
          ? prior.generation
          : 0;
    if (!Number.isInteger(previous) || previous < 0) throw unavailable();
    const generation = previous + 1;
    const setupCode = randomBytes(32).toString("base64url");
    const expiresAt = new Date(at.getTime() + MANAGEMENT_POLICY.setupMs);
    await collection(MANAGEMENT_COLLECTIONS.setupCodes).replaceOne(
      { _id: account._id },
      {
        _id: account._id,
        accountId: account._id,
        accountVersion: account.version,
        generation,
        codeHash: digestSecret(setupCode),
        issuedAt: at,
        expiresAt,
        attempts: 0,
        consumedAt: null,
      },
      { session, upsert: true },
    );
    const changed = await collection("accounts").updateOne(
      { _id: account._id, version: account.version },
      { $set: { setupGeneration: generation } },
      { session },
    );
    if (changed.modifiedCount !== 1) throw stale();
    account.setupGeneration = generation;
    return { setupCode, expiresAt: expiresAt.toISOString() };
  }
  async function patchProfile(
    session,
    context,
    targetAccount,
    profile,
    input,
    at,
  ) {
    const { account: actor } = context;
    if (actor._id !== targetAccount._id) requireManager(actor);
    else if (!contactOnly(input.profile))
      throw denied(
        "Only your own address is directly editable. Contact replacements require the separate verified flow.",
      );
    // Recognize older clients' phone field but fail closed for every actor and
    // target. TEST delivery must never enable a real profile replacement.
    // Reject the whole patch before revision checks or any profile write.
    if (Object.hasOwn(input.profile, "phone")) {
      throw new StaffError(
        "contact_change_not_ready",
        "Phone changes are unavailable until real WhatsApp delivery is configured and successfully tested.",
        409,
      );
    }
    // Current actor/target records are read under the existing transaction guard.
    // Field presence is a denial, even for unchanged values or mixed patches.
    if (
      identityFields.some((field) => Object.hasOwn(input.profile, field)) &&
      (actor._id === targetAccount._id || !actor.roles.includes("Admin"))
    ) {
      throw denied(
        "Only another Admin may edit identity, parents' names, date of birth or qualifications.",
      );
    }
    // Both accounts were read inside the shared guarded transaction. Reject
    // the entire patch before any profile write, even for unchanged values or
    // mixed-role targets; personal-profile authority is not work-detail authority.
    if (
      protectedRoles(targetAccount.roles) &&
      !actor.roles.includes("Admin") &&
      protectedWorkFields.some((field) => Object.hasOwn(input.profile, field))
    ) {
      throw denied(
        "Only another Admin may change an Admin or System Admin's departments or employment start date.",
      );
    }
    if (profileRevision(profile) !== input.expectedRevision) throw stale();
    if (!contactOnly(input.profile)) recent(context, at);
    const clean = validateManagementProfile(
      { ...profileFields(profile), ...input.profile },
      targetAccount.roles,
      today(at),
      {
        legacyQualification: profile.qualification,
        legacyContacts: profile,
      },
    );
    // Validate the merged complete profile but write only requested fields.
    // This preserves the locked email and unrelated legacy fields exactly.
    const fields = Object.fromEntries(
      Object.keys(input.profile).map((field) => [field, clean[field]]),
    );
    const filter = {
      _id: profile._id,
      accountId: targetAccount._id,
      ...(profile.revision === undefined
        ? { revision: { $exists: false } }
        : { revision: input.expectedRevision }),
    };
    const changed = await collection("staff_profiles").updateOne(
      filter,
      {
        $set: {
          ...fields,
          revision: input.expectedRevision + 1,
          updatedAt: at,
        },
      },
      { session },
    );
    if (changed.modifiedCount !== 1) throw stale();
    const next = {
      ...profile,
      ...fields,
      revision: input.expectedRevision + 1,
    };
    await event(
      session,
      actor._id === targetAccount._id
        ? "own_contact_updated"
        : "staff_profile_updated",
      actor,
      targetAccount,
    );
    return detail(targetAccount, next);
  }

  return {
    directory(token) {
      return read(token, async (session, { account: actor }) => {
        requireManager(actor);
        const accounts = await collection("accounts")
          .find(
            {},
            {
              session,
              projection: {
                _id: 1,
                username: 1,
                roles: 1,
                status: 1,
                version: 1,
                "mfa.enabled": 1,
                "mfa.backupAcknowledged": 1,
              },
            },
          )
          .sort({ username: 1 })
          .toArray();
        const profiles = await collection("staff_profiles")
          .find(
            {},
            {
              session,
              projection: {
                accountId: 1,
                firstName: 1,
                lastName: 1,
                departments: 1,
                revision: 1,
              },
            },
          )
          .toArray();
        const byAccount = new Map(
          profiles.map((profile) => [profile.accountId, profile]),
        );
        if (
          byAccount.size !== profiles.length ||
          byAccount.size !== accounts.length
        )
          throw unavailable();
        return {
          staff: accounts.map((account) =>
            summary(account, byAccount.get(account._id)),
          ),
          roles: [...ROLES],
          departments: [...DEPARTMENTS],
        };
      });
    },
    ownProfile(token) {
      return read(token, (_session, { account, profile }) =>
        detail(account, profile),
      );
    },
    profile(token, id) {
      return read(token, async (session, context) => {
        if (context.account._id !== id) requireManager(context.account);
        const found = await target(session, id);
        return detail(found.account, found.profile);
      });
    },
    create(token, input) {
      return write(
        token,
        async (session, context, at) => {
          requireManager(context.account);
          recent(context, at);
          const clean = validateCreate(input, today(at));
          if (
            !context.account.roles.includes("Admin") &&
            protectedRoles(clean.roles)
          )
            throw denied();
          const account = {
            _id: `account:${randomUUID()}`,
            username: clean.username,
            roles: clean.roles,
            status: "setup_pending",
            version: 1,
            createdAt: at,
            mfa: null,
          };
          const profile = {
            _id: `profile:${randomUUID()}`,
            accountId: account._id,
            ...clean.profile,
            phoneCountry: phoneNumber(clean.profile.phone).country,
            emailVerified: false,
            revision: 0,
            createdAt: at,
          };
          try {
            await collection("accounts").insertOne(account, { session });
          } catch (error) {
            if (error.code === 11000 && error.keyPattern?.username)
              throw new StaffError(
                "username_unavailable",
                "That username is already assigned.",
                409,
              );
            throw error;
          }
          await collection("staff_profiles").insertOne(profile, { session });
          const code = await issueCode(session, account, at);
          await event(
            session,
            "staff_account_created",
            context.account,
            account,
          );
          return { account: summary(account, profile), ...code };
        },
        "staff_account_created",
      );
    },
    updateProfile(token, id, input) {
      return write(
        token,
        async (session, context, at) => {
          const found = await target(session, id);
          return patchProfile(
            session,
            context,
            found.account,
            found.profile,
            validateProfilePatch(input),
            at,
          );
        },
        "staff_profile_updated",
        id,
      );
    },
    updateContact(token, input) {
      return write(
        token,
        (session, context, at) =>
          patchProfile(
            session,
            context,
            context.account,
            context.profile,
            validateContact(input),
            at,
          ),
        "own_contact_updated",
      );
    },
    changeRoles(token, id, input) {
      return write(
        token,
        async (session, context, at) => {
          allowFields(input, ["expectedVersion", "roles"]);
          const version = expectedVersion(input.expectedVersion);
          const roles = validateRoles(input.roles);
          const found = await target(session, id);
          const { account, profile } = found;
          requireControl(context.account, account, roles);
          recent(context, at);
          if (account.version !== version) throw stale();
          validateManagementProfile(profileFields(profile), roles, today(at), {
            legacyContacts: profile,
            legacyQualification: profile.qualification,
          });
          const nextPhase = phase(account, roles);
          const next = {
            ...account,
            roles,
            version: version + 1,
            status: account.status === "disabled" ? "disabled" : nextPhase,
          };
          if (next.status === "disabled") next.disabledFromStatus = nextPhase;
          await ensureAdminRemains(session, account, next);
          const changed = await collection("accounts").updateOne(
            { _id: id, version },
            {
              $set: {
                roles,
                status: next.status,
                version: next.version,
                updatedAt: at,
                ...(next.status === "disabled"
                  ? { disabledFromStatus: nextPhase }
                  : {}),
              },
            },
            { session },
          );
          if (changed.modifiedCount !== 1) throw stale();
          await revoke(session, account, at, "roles_changed");
          await event(session, "staff_roles_changed", context.account, next);
          return { account: summary(next, profile) };
        },
        "staff_roles_changed",
        id,
      );
    },
    changeStatus(token, id, input) {
      return write(
        token,
        async (session, context, at) => {
          allowFields(input, ["expectedVersion", "enabled"]);
          const version = expectedVersion(input.expectedVersion);
          if (typeof input.enabled !== "boolean")
            throw new StaffError(
              "invalid_input",
              "Choose whether this account is enabled.",
            );
          const { account, profile } = await target(session, id);
          requireControl(context.account, account);
          recent(context, at);
          if (account.version !== version) throw stale();
          if (input.enabled === (account.status !== "disabled"))
            throw new StaffError(
              "no_change",
              "This account already has the requested status.",
              409,
            );
          const status = input.enabled ? phase(account) : "disabled";
          const next = { ...account, status, version: version + 1 };
          if (!input.enabled) next.disabledFromStatus = account.status;
          else delete next.disabledFromStatus;
          await ensureAdminRemains(session, account, next);
          const changed = await collection("accounts").updateOne(
            { _id: id, version },
            {
              $set: {
                status,
                version: next.version,
                updatedAt: at,
                ...(!input.enabled
                  ? { disabledFromStatus: account.status }
                  : {}),
              },
              ...(input.enabled ? { $unset: { disabledFromStatus: "" } } : {}),
            },
            { session },
          );
          if (changed.modifiedCount !== 1) throw stale();
          await revoke(
            session,
            account,
            at,
            input.enabled ? "account_enabled" : "account_disabled",
          );
          await event(
            session,
            input.enabled ? "staff_account_enabled" : "staff_account_disabled",
            context.account,
            next,
          );
          return { account: summary(next, profile) };
        },
        "staff_status_changed",
        id,
      );
    },
    replaceSetupCode(token, id, input) {
      return write(
        token,
        async (session, context, at) => {
          allowFields(input, ["expectedVersion"]);
          const version = expectedVersion(input.expectedVersion);
          const { account, profile } = await target(session, id);
          requireControl(context.account, account);
          recent(context, at);
          if (account.version !== version) throw stale();
          const previous = await collection(
            MANAGEMENT_COLLECTIONS.setupCodes,
          ).findOne({ _id: id }, { session });
          if (
            account.status !== "setup_pending" ||
            account.passwordHash ||
            previous?.consumedAt
          ) {
            throw new StaffError(
              "setup_not_available",
              "Only an unused initial setup code for an enabled no-password account can be replaced.",
              409,
            );
          }
          const next = { ...account, version: version + 1 };
          const changed = await collection("accounts").updateOne(
            { _id: id, version, status: "setup_pending" },
            {
              $set: { version: next.version, updatedAt: at },
            },
            { session },
          );
          if (changed.modifiedCount !== 1) throw stale();
          await revoke(session, account, at, "setup_code_replaced");
          const code = await issueCode(session, next, at);
          await event(
            session,
            "staff_setup_code_replaced",
            context.account,
            next,
          );
          return { account: summary(next, profile), ...code };
        },
        "staff_setup_code_replaced",
        id,
      );
    },
  };
}
