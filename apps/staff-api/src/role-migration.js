import { createHash } from "node:crypto";
import { BSON } from "mongodb";
import { validRoles, requiresMfa, permissionsFor } from "./permissions.js";
import { operationalAccess } from "./operational-model.js";
import { eligibleAdmin } from "./management.js";
import { revokeCredentialAuthorities } from "./password-history.js";
import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import { STAFF_ROLE_POLICY } from "../../../shared/staff-roles.mjs";
import {
  assertNormalRoleTarget,
  assertRoleBackupCurrent,
  roleBackupDigest,
} from "./role-cutover-backup.js";

export const ROLE_POLICY = STAFF_ROLE_POLICY;
const LEGACY_ROLES = [
  "Admin",
  "System Admin",
  "Clinic Admin",
  "Lab Admin",
  "Clinic Receptionist",
  "Lab Receptionist",
];
const hash = (value) =>
  createHash("sha256").update(BSON.serialize(value)).digest("hex");
const sorted = (values) => [...values].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const refuse = (message) => {
  throw new Error(message);
};

function legacyAccess(roles, grants, scope) {
  const admin = roles.includes("Admin"),
    assigned = scope.active && grants.includes(scope.id);
  const edit =
    admin ||
    Boolean(
      assigned &&
      roles.includes(scope.kind === "clinic" ? "Clinic Admin" : "Lab Admin"),
    );
  return {
    view:
      edit ||
      Boolean(
        assigned &&
        roles.includes(
          scope.kind === "clinic" ? "Clinic Receptionist" : "Lab Receptionist",
        ),
      ),
    edit,
    publish: edit,
  };
}
function effective(roles, grants, scopes, legacy) {
  const permissions = legacy
    ? [
        "workspace:view",
        "profile:own:view",
        "profile:own:contact",
        ...(roles.some((r) => ["Admin", "System Admin"].includes(r))
          ? ["staff:directory", "staff:profiles", "staff:manage"]
          : []),
        ...(roles.includes("Admin") ? ["staff:protected:manage"] : []),
      ]
    : permissionsFor(roles).filter((p) => p !== "operations:view");
  // Field-level authority matters too; role names and descriptive departments do not suffice.
  if (roles.includes("Admin"))
    permissions.push("identity:others", "work:protected", "recovery:others");
  if (roles.includes("Admin") || (legacy && roles.includes("System Admin")))
    permissions.push("work:ordinary");
  for (const scope of scopes) {
    const access = (legacy ? legacyAccess : operationalAccess)(
      roles,
      grants,
      scope,
    );
    for (const mode of ["view", "edit", "publish"])
      if (access[mode]) permissions.push(`${scope.id}:${mode}`);
    if (scope.kind === "clinic" && access.edit)
      permissions.push(`${scope.id}:limit`);
  }
  return sorted(permissions);
}

// Never emits hashes, encrypted factors, contact values, or personal profiles.
export async function roleSnapshot(db, session) {
  const options = { session };
  const accounts = await db
    .collection("accounts")
    .aggregate(
      [
        {
          $project: {
            _id: 1,
            roles: 1,
            version: 1,
            status: 1,
            hasPassword: {
              $and: [
                { $eq: [{ $type: "$passwordHash" }, "string"] },
                { $ne: ["$passwordHash", ""] },
              ],
            },
            mfaEnabled: { $eq: ["$mfa.enabled", true] },
            mfaVersion: "$mfa.version",
            backupAcknowledged: { $eq: ["$mfa.backupAcknowledged", true] },
            factorPresent: {
              $and: [
                { $ne: [{ $type: "$mfa.secretCipher" }, "missing"] },
                { $ne: ["$mfa.secretCipher", null] },
                { $ne: ["$mfa.secretCipher", ""] },
                { $ne: ["$mfa.secretCipher", false] },
              ],
            },
          },
        },
      ],
      options,
    )
    .sort({ _id: 1 })
    .toArray();
  const profiles = await db
    .collection("staff_profiles")
    .find({}, { ...options, projection: { _id: 1, accountId: 1 } })
    .sort({ _id: 1 })
    .toArray();
  const state = await db
    .collection("staff_management_state")
    .findOne({ _id: "staff-controls" }, options);
  if (!state || !Number.isSafeInteger(state.revision))
    refuse("Missing management guard.");
  if (state.rolePolicy != null && state.rolePolicy !== ROLE_POLICY)
    refuse("Unexpected role policy. Reconcile before migration.");
  const grants = await db
    .collection("operational_grants")
    .find({}, options)
    .sort({ _id: 1 })
    .toArray();
  const scopes = await db
    .collection("operational_scopes")
    .find({}, options)
    .sort({ _id: 1 })
    .toArray();
  const result = {
    revision: state.revision,
    rolePolicy: state.rolePolicy ?? null,
    accounts: accounts.map((a) => {
      // Reuse activation eligibility with presence markers, NEVER credential values.
      const eligibility = {
        ...a,
        roles: ["Admin"],
        status: "active",
        passwordHash: a.hasPassword ? "present" : null,
        mfa: {
          enabled: a.mfaEnabled,
          version: a.mfaVersion,
          secretCipher: a.factorPresent ? "present" : null,
          backupAcknowledged: a.backupAcknowledged,
        },
      };
      const complete = eligibleAdmin(eligibility);
      return {
        id: a._id,
        roles: a.roles,
        version: a.version,
        status: a.status,
        eligibleAdmin:
          a.roles?.includes("Admin") && a.status === "active" && complete,
        mfaComplete: complete,
        mfaEnabled: a.mfaEnabled === true,
        hasPassword: a.hasPassword === true,
        profileIds: profiles
          .filter((p) => p.accountId === a._id)
          .map((p) => p._id),
      };
    }),
    grants: grants.map((g) => ({
      id: g._id,
      accountId: g.id,
      scopeIds: g.scopeIds,
      revision: g.revision,
    })),
    scopes: scopes.map((s) => ({
      id: s.id,
      kind: s.kind,
      active: s.active,
      revision: s.revision,
    })),
  };
  if (profiles.some((p) => !accounts.some((a) => a._id === p.accountId)))
    refuse("Unlinked profile. Reconcile before migration.");
  return result;
}

export function planRoleMigration(snapshot, mappings = {}) {
  const problems = [],
    changes = [];
  const accountIds = snapshot.accounts.map((a) => a.id),
    scopeIds = snapshot.scopes.map((s) => s.id);
  if (
    new Set(accountIds).size !== accountIds.length ||
    new Set(scopeIds).size !== scopeIds.length ||
    Object.keys(mappings).some((id) => !accountIds.includes(id))
  )
    refuse("Unknown or duplicate mapping identity.");
  if (
    snapshot.scopes.some(
      (s) =>
        !["clinic", "service"].includes(s.kind) ||
        typeof s.active !== "boolean" ||
        !Number.isSafeInteger(s.revision) ||
        s.revision < 1,
    )
  )
    refuse("Unknown or unversioned scope.");
  if (
    snapshot.grants.some(
      (g) =>
        !accountIds.includes(g.accountId) ||
        g.id !== g.accountId ||
        !Number.isSafeInteger(g.revision) ||
        g.revision < 1 ||
        !Array.isArray(g.scopeIds) ||
        new Set(g.scopeIds).size !== g.scopeIds.length ||
        g.scopeIds.some((id) => !scopeIds.includes(id)),
    )
  )
    refuse("Unexpected or broken scope grants.");
  for (const account of snapshot.accounts) {
    if (
      !Array.isArray(account.roles) ||
      !account.roles.length ||
      new Set(account.roles).size !== account.roles.length ||
      account.roles.some(
        (r) => !LEGACY_ROLES.includes(r) && r !== "Receptionist",
      ) ||
      !Number.isSafeInteger(account.version) ||
      account.version < 1 ||
      account.version === Number.MAX_SAFE_INTEGER ||
      !["setup_pending", "mfa_pending", "active", "disabled"].includes(
        account.status,
      ) ||
      account.profileIds.length !== 1
    )
      refuse(
        "Unknown/empty roles or inconsistent account/profile version/link.",
      );
    const grant = snapshot.grants.find((g) => g.accountId === account.id);
    const previousGrants = grant?.scopeIds ?? [];
    const mapping = mappings[account.id];
    if (account.roles.includes("System Admin") && !mapping) {
      problems.push({
        accountId: account.id,
        reason:
          "System Admin requires an explicitly approved per-account mapping; never promoted automatically.",
      });
      continue;
    }
    const roles = mapping?.roles ?? [
      ...new Set(
        account.roles.map((r) =>
          /^(Clinic|Lab) Receptionist$/.test(r) ? "Receptionist" : r,
        ),
      ),
    ];
    const grants = mapping?.scopeIds ?? previousGrants;
    if (
      !validRoles(roles) ||
      !Array.isArray(grants) ||
      new Set(grants).size !== grants.length ||
      grants.some((id) => !scopeIds.includes(id))
    )
      refuse("Invalid target roles or scope mapping.");
    const before = effective(
        account.roles,
        previousGrants,
        snapshot.scopes,
        true,
      ),
      after = effective(roles, grants, snapshot.scopes, false);
    const phase = !account.hasPassword
      ? "setup_pending"
      : requiresMfa(roles) && !account.mfaEnabled
        ? "mfa_pending"
        : "active";
    const status = account.status === "disabled" ? "disabled" : phase;
    const oldReady =
      account.status === "active" &&
      account.hasPassword &&
      (account.roles.some((r) =>
        ["Admin", "System Admin", "Clinic Admin", "Lab Admin"].includes(r),
      )
        ? account.mfaComplete
        : !account.mfaEnabled || account.mfaComplete);
    const newReady =
      status === "active" &&
      account.hasPassword &&
      (requiresMfa(roles)
        ? account.mfaComplete
        : !account.mfaEnabled || account.mfaComplete);
    const effectiveBefore = oldReady ? before : [],
      effectiveAfter = newReady ? after : [];
    // Approval covers both latent role/grant changes and immediate access changes
    // caused by activation/MFA gating. Disabled accounts cannot hide a future gain.
    const gains = sorted(
      new Set([
        ...after.filter((p) => !before.includes(p)),
        ...effectiveAfter.filter((p) => !effectiveBefore.includes(p)),
      ]),
    );
    const losses = sorted(
      new Set([
        ...before.filter((p) => !after.includes(p)),
        ...effectiveBefore.filter((p) => !effectiveAfter.includes(p)),
      ]),
    );
    const approved = mapping?.approvedChanges ?? { gains: [], losses: [] };
    if (!same(gains, approved.gains) || !same(losses, approved.losses))
      problems.push({
        accountId: account.id,
        reason: "Effective access changes need exact approval.",
        gains,
        losses,
      });
    changes.push({
      accountId: account.id,
      accountVersion: account.version,
      roles,
      status,
      ...(status === "disabled" ? { disabledFromStatus: phase } : {}),
      scopeIds: grants,
      grantRevision: grant?.revision ?? null,
      gains,
      losses,
      // Also report immediate effective authority. Latent grant/role differences
      // above still require approval even for a disabled/pending account.
      effectiveBefore,
      effectiveAfter,
      previouslyMfaRequired: account.roles.some((r) =>
        ["Admin", "System Admin", "Clinic Admin", "Lab Admin"].includes(r),
      ),
      mfaRequired: requiresMfa(roles),
    });
  }
  const remaining = changes.filter(
    (c) =>
      c.roles.includes("Admin") &&
      c.status === "active" &&
      snapshot.accounts.find((a) => a.id === c.accountId)?.mfaComplete,
  ).length;
  if (!remaining)
    problems.push({
      reason: "No active fully activated MFA-complete Admin would remain.",
    });
  const plan = {
    version: 1,
    policy: ROLE_POLICY,
    snapshotDigest: hash(snapshot),
    changes,
    problems,
  };
  return { ...plan, digest: hash(plan) };
}

export async function inspectRoleMigration({
  db,
  client,
  mappings = {},
  demoMode,
  context,
}) {
  if (context?.mode === "normal-local") {
    if (demoMode !== true) refuse("Explicit loopback mode required.");
    assertNormalRoleTarget(db, client, context);
  } else
    assertPublicationStorage(db, client, demoMode, "staff", { mode: "test" });
  const session = client.startSession();
  try {
    return await session.withTransaction(
      async () => planRoleMigration(await roleSnapshot(db, session), mappings),
      { readConcern: { level: "snapshot" } },
    );
  } finally {
    await session.endSession();
  }
}

export async function applyRoleMigration({
  db,
  client,
  plan,
  mappings = {},
  maintenanceAcknowledged,
  demoMode,
  failBeforeCommit = async () => {},
  context,
  backup,
  expectedBackupDigest,
}) {
  const normal = context?.mode === "normal-local";
  if (normal) {
    if (demoMode !== true) refuse("Explicit loopback mode required.");
    assertNormalRoleTarget(db, client, context);
    if (!backup || roleBackupDigest(backup) !== expectedBackupDigest)
      refuse("An exact verified protected backup is required.");
  } else
    assertPublicationStorage(db, client, demoMode, "staff", { mode: "test" });
  if (maintenanceAcknowledged !== true)
    refuse(
      "Stop older APIs and select the matching new API/package before acknowledging coordinated maintenance cutover.",
    );
  const { digest, ...body } = plan;
  if (
    hash(body) !== digest ||
    plan.policy !== ROLE_POLICY ||
    plan.version !== 1 ||
    plan.problems.length
  )
    refuse("Unapproved or modified role migration plan.");
  const session = client.startSession();
  try {
    return await session.withTransaction(
      async () => {
        const ledger = db.collection("staff_role_migrations");
        const old = await ledger.findOne({ _id: ROLE_POLICY }, { session });
        if (old) {
          if (old.digest !== digest)
            refuse("A different role migration is already recorded.");
          return { status: "already_applied", digest };
        }
        const snapshot = await roleSnapshot(db, session),
          current = planRoleMigration(snapshot, mappings);
        if (current.digest !== digest || current.problems.length)
          refuse(
            "Roles, grants, scopes, versions or approvals changed. Regenerate the dry-run.",
          );
        if (backup) {
          if (roleBackupDigest(backup) !== expectedBackupDigest)
            refuse("Protected backup identity differs.");
          await assertRoleBackupCurrent(
            db,
            session,
            backup,
            context,
            current.snapshotDigest,
          );
        }
        const guard = await db
          .collection("staff_management_state")
          .updateOne(
            { _id: "staff-controls", revision: snapshot.revision },
            { $inc: { revision: 1 }, $set: { rolePolicy: ROLE_POLICY } },
            { session },
          );
        if (guard.matchedCount !== 1) refuse("Management state changed.");
        for (const change of plan.changes) {
          const updated = await db.collection("accounts").updateOne(
            { _id: change.accountId, version: change.accountVersion },
            {
              $set: {
                roles: change.roles,
                status: change.status,
                ...(change.status === "disabled"
                  ? { disabledFromStatus: change.disabledFromStatus }
                  : {}),
              },
              $inc: { version: 1 },
            },
            { session },
          );
          if (updated.matchedCount !== 1) refuse("Account changed.");
          if (change.grantRevision !== null) {
            const grant = await db
              .collection("operational_grants")
              .updateOne(
                { _id: change.accountId, revision: change.grantRevision },
                { $set: { scopeIds: change.scopeIds }, $inc: { revision: 1 } },
                { session },
              );
            if (grant.matchedCount !== 1) refuse("Grant changed.");
          } else if (change.scopeIds.length)
            await db.collection("operational_grants").insertOne(
              {
                _id: change.accountId,
                id: change.accountId,
                scopeIds: change.scopeIds,
                revision: 1,
              },
              { session },
            );
          await revokeCredentialAuthorities(
            db,
            session,
            change.accountId,
            new Date(),
            "role_policy_changed",
          );
        }
        await db
          .collection("operational_state")
          .updateOne(
            { _id: "working" },
            { $inc: { revision: 1 }, $setOnInsert: { head: 0 } },
            { session, upsert: true },
          );
        await ledger.insertOne(
          { _id: ROLE_POLICY, digest, completedAt: new Date() },
          { session },
        );
        await db.collection("security_events").insertOne(
          {
            action: "role_policy_migrated",
            occurredAt: new Date(),
            outcome: "success",
            policy: ROLE_POLICY,
          },
          { session },
        );
        await failBeforeCommit();
        return { status: "applied", digest };
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    );
  } finally {
    await session.endSession();
  }
}
