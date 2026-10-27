import { createHash } from "node:crypto";
import { BSON } from "mongodb";
import { dpapi } from "./local-security.js";
import { assertPublicationReviewStorage } from "../../../shared/publication-review-guard.mjs";
import { revokeCredentialAuthorities } from "./password-history.js";

// Only state touched by migration, plus account/profile/scope link dependencies.
// Password history, factors' encryption keys, delivery settings and throttle
// collections are deliberately not rewritten or restored by role migration.
export const ROLE_BACKUP_COLLECTIONS = Object.freeze([
  "accounts",
  "staff_profiles",
  "staff_management_state",
  "operational_grants",
  "operational_scopes",
  "operational_state",
  "staff_role_migrations",
  "staff_sessions",
  "auth_challenges",
  "contact_requests",
  "staff_recovery_requests",
  "security_events",
]);
export const digestRoleBytes = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const refuse = () => {
  throw Error(
    "Role backup/target validation failed. Preserve the backup and reconcile; no automatic restore is allowed.",
  );
};
export function assertNormalRoleTarget(db, client, context) {
  const hosts = client?.options?.hosts ?? [];
  if (
    context?.mode !== "normal-local" ||
    context.demoMode !== true ||
    context.database !== "capstone_staff_dev" ||
    db?.databaseName !== context.database ||
    !/^[a-f0-9]{64}$/.test(context.runtimeFingerprint ?? "") ||
    hosts.length !== 1 ||
    hosts[0].host !== "127.0.0.1" ||
    hosts[0].port !== 27018 ||
    client.options.replicaSet !== "capstoneStaffDev" ||
    client.options.srvHost
  )
    refuse();
}
export async function roleCollectionMetadata(db) {
  const available = await db.listCollections({}, { nameOnly: false }).toArray();
  const metadata = {};
  for (const name of ROLE_BACKUP_COLLECTIONS) {
    const info = available.find((c) => c.name === name);
    if (info && info.type !== "collection") refuse();
    metadata[name] = {
      existed: Boolean(info),
      options: info?.options ?? {},
      indexes: info ? await db.collection(name).listIndexes().toArray() : [],
    };
  }
  return metadata;
}
export async function captureRoleState(db, session, metadata) {
  const collections = {};
  for (const name of ROLE_BACKUP_COLLECTIONS)
    collections[name] = {
      ...metadata[name],
      raw: await db
        .collection(name)
        .find({}, { session, raw: true })
        .sort({ _id: 1 })
        .toArray(),
    };
  return collections;
}
function validateBackup(value) {
  if (
    value?.version !== 1 ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "database",
          "runtimeFingerprint",
          "snapshotDigest",
          "collections",
        ].includes(key),
    ) ||
    !["capstone_staff_dev", "capstone_staff_test"].includes(value.database) ||
    !/^[a-f0-9]{64}$/.test(value.runtimeFingerprint ?? "") ||
    !/^[a-f0-9]{64}$/.test(value.snapshotDigest ?? "") ||
    !value.collections ||
    Object.keys(value.collections).length !== ROLE_BACKUP_COLLECTIONS.length
  )
    refuse();
  for (const name of ROLE_BACKUP_COLLECTIONS) {
    const c = value.collections[name];
    if (
      !c ||
      typeof c.existed !== "boolean" ||
      !c.options ||
      !Array.isArray(c.indexes) ||
      !Array.isArray(c.raw) ||
      (!c.existed && c.raw.length)
    )
      refuse();
    for (const raw of c.raw) {
      if (
        !Buffer.isBuffer(raw) ||
        raw.length < 5 ||
        raw.readInt32LE(0) !== raw.length
      )
        refuse();
      BSON.deserialize(raw, { promoteLongs: false });
    }
  }
  return value;
}
export const roleBackupDigest = (value) =>
  digestRoleBytes(BSON.serialize(validateBackup(value)));
export async function encodeRoleBackup(value, wrap = dpapi) {
  const payload = BSON.serialize(validateBackup(value));
  const envelope = BSON.serialize({
    payload,
    digest: digestRoleBytes(payload),
  });
  try {
    return await wrap(envelope, "Protect");
  } finally {
    payload.fill(0);
    envelope.fill(0);
  }
}
export async function decodeRoleBackup(bytes, unwrap = dpapi) {
  const plain = await unwrap(bytes, "Unprotect");
  try {
    const { payload, digest } = BSON.deserialize(plain, {
      promoteBuffers: true,
    });
    if (!Buffer.isBuffer(payload) || digestRoleBytes(payload) !== digest)
      refuse();
    // BSON binary fields can share the input buffer. Keep the returned backup
    // independent of the temporary envelope cleared below.
    return validateBackup(
      BSON.deserialize(Buffer.from(payload), {
        promoteBuffers: true,
        promoteLongs: false,
      }),
    );
  } finally {
    plain.fill(0);
  }
}
// Called INSIDE the same transaction that updates accounts. All affected data
// must still match the protected backup; an old backup cannot authorize writes.
export async function assertRoleBackupCurrent(
  db,
  session,
  backup,
  context,
  snapshotDigest,
) {
  validateBackup(backup);
  if (
    backup.database !== db.databaseName ||
    backup.runtimeFingerprint !== context.runtimeFingerprint ||
    backup.snapshotDigest !== snapshotDigest
  )
    refuse();
  for (const name of ROLE_BACKUP_COLLECTIONS) {
    const current = await db
      .collection(name)
      .find({}, { session, raw: true })
      .sort({ _id: 1 })
      .toArray();
    if (
      current.length !== backup.collections[name].raw.length ||
      current.some((raw, i) => !raw.equals(backup.collections[name].raw[i]))
    )
      refuse();
  }
}

// Recovery rehearsal ONLY: no normal restore endpoint/CLI exists. Requires an
// empty affected TEST target and invalidates restored authorities before commit.
export async function restoreRoleBackupForTest({
  db,
  client,
  backup,
  demoMode,
}) {
  assertPublicationReviewStorage(db, client, demoMode);
  validateBackup(backup);
  if (backup.database !== "capstone_staff_test") refuse();
  const metadata = await roleCollectionMetadata(db);
  for (const name of ROLE_BACKUP_COLLECTIONS) {
    const { raw, ...expected } = backup.collections[name];
    if (JSON.stringify(metadata[name]) !== JSON.stringify(expected)) refuse();
  }
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const name of ROLE_BACKUP_COLLECTIONS) {
        if (await db.collection(name).countDocuments({}, { session })) refuse();
        const docs = backup.collections[name].raw.map((raw) =>
          BSON.deserialize(raw, { promoteValues: false, promoteLongs: false }),
        );
        if (docs.length)
          await db.collection(name).insertMany(docs, { session });
      }
      const accounts = await db
        .collection("accounts")
        .find({}, { session, projection: { _id: 1, version: 1 } })
        .toArray();
      for (const a of accounts) {
        if (
          !Number.isSafeInteger(a.version) ||
          a.version < 1 ||
          a.version === Number.MAX_SAFE_INTEGER
        )
          refuse();
        await db
          .collection("accounts")
          .updateOne({ _id: a._id }, { $inc: { version: 1 } }, { session });
        await revokeCredentialAuthorities(
          db,
          session,
          a._id,
          new Date(),
          "test_restore_requires_fresh_authorization",
        );
      }
    });
  } finally {
    await session.endSession();
  }
}
