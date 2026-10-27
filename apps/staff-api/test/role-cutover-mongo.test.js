import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { BSON } from "mongodb";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  roleSnapshot,
  inspectRoleMigration,
  applyRoleMigration,
} from "../src/role-migration.js";
import {
  captureRoleState,
  roleCollectionMetadata,
  roleBackupDigest,
  encodeRoleBackup,
  decodeRoleBackup,
  restoreRoleBackupForTest,
  ROLE_BACKUP_COLLECTIONS,
} from "../src/role-cutover-backup.js";
let f;
before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});
const context = { runtimeFingerprint: "d".repeat(64) };
async function prepare() {
  const person = await f.account({ roles: ["Admin"], mfa: true });
  await f.db.collection("staff_profiles").updateOne(
    { accountId: person.id },
    {
      $set: {
        syntheticBsonLong: BSON.Long.fromNumber(17),
        syntheticBsonDouble: new BSON.Double(23),
      },
    },
  );
  await f.db.collection("staff_sessions").insertOne({
    _id: "synthetic-old-session",
    accountId: person.id,
    revokedAt: null,
  });
  const plan = await inspectRoleMigration({ ...f, demoMode: true });
  const metadata = await roleCollectionMetadata(f.db);
  const session = f.client.startSession();
  let collections;
  try {
    collections = await session.withTransaction(
      () => captureRoleState(f.db, session, metadata),
      { readConcern: { level: "snapshot" } },
    );
  } finally {
    await session.endSession();
  }
  const backup = {
    version: 1,
    database: "capstone_staff_test",
    runtimeFingerprint: context.runtimeFingerprint,
    snapshotDigest: plan.snapshotDigest,
    collections,
  };
  return {
    person,
    plan,
    backup,
    expectedBackupDigest: roleBackupDigest(backup),
  };
}
const apply = (args) =>
  applyRoleMigration({
    ...f,
    demoMode: true,
    maintenanceAcknowledged: true,
    context,
    ...args,
  });
test("real Mongo backup-bound apply rolls back, has one winner, and exact rerun preserves later edits", async () => {
  const p = await prepare();
  const accountBefore = await f.db
    .collection("accounts")
    .findOne({ _id: p.person.id });
  await assert.rejects(
    apply({
      ...p,
      failBeforeCommit: async () => {
        throw Error("synthetic rollback");
      },
    }),
    /synthetic rollback/,
  );
  assert.deepEqual(
    await f.db.collection("accounts").findOne({ _id: p.person.id }),
    accountBefore,
  );
  const outcomes = await Promise.all([apply(p), apply(p)]);
  assert.equal(outcomes.filter((r) => r.status === "applied").length, 1);
  assert.equal(
    outcomes.filter((r) => r.status === "already_applied").length,
    1,
  );
  const changed = await f.db
    .collection("accounts")
    .findOne({ _id: p.person.id });
  assert.equal(changed.passwordHash, accountBefore.passwordHash);
  assert.deepEqual(changed.mfa, accountBefore.mfa);
  assert.ok(
    (
      await f.db
        .collection("staff_sessions")
        .findOne({ _id: "synthetic-old-session" })
    ).revokedAt,
  );
  await f.db
    .collection("accounts")
    .updateOne({ _id: p.person.id }, { $set: { syntheticLaterEdit: true } });
  assert.equal((await apply(p)).status, "already_applied");
  assert.equal(
    (await f.db.collection("accounts").findOne({ _id: p.person.id }))
      .syntheticLaterEdit,
    true,
  );
});
test("unchanged role plan cannot use a backup after authorization state changed", async () => {
  const p = await prepare();
  await f.db
    .collection("staff_sessions")
    .insertOne({ _id: "synthetic-new-session", accountId: p.person.id });
  await assert.rejects(apply(p), /backup\/target validation/);
  assert.equal(
    await f.db.collection("staff_role_migrations").countDocuments(),
    0,
  );
  assert.equal(
    (await f.db.collection("accounts").findOne({ _id: p.person.id })).version,
    p.person.version ?? 1,
  );
});
test("read-only snapshot never returns password/factor values; TEST recovery restores protected material but never live old authority", async () => {
  const p = await prepare();
  const snapshot = await roleSnapshot(f.db);
  assert.equal(JSON.stringify(snapshot).includes("passwordHash"), false);
  assert.equal(JSON.stringify(snapshot).includes("secretCipher"), false);
  // Actual Windows DPAPI protects DUMMY TEST material only; no normal backup.
  const encoded = await encodeRoleBackup(p.backup);
  const restored = await decodeRoleBackup(encoded);
  assert.deepEqual(
    restored.collections.accounts.raw,
    p.backup.collections.accounts.raw,
  );
  await assert.rejects(
    restoreRoleBackupForTest({ ...f, backup: restored, demoMode: true }),
  );
  for (const name of ROLE_BACKUP_COLLECTIONS)
    await f.db.collection(name).deleteMany({});
  await restoreRoleBackupForTest({ ...f, backup: restored, demoMode: true });
  const restoredProfiles = await f.db
    .collection("staff_profiles")
    .find({}, { raw: true })
    .sort({ _id: 1 })
    .toArray();
  assert.deepEqual(restoredProfiles, p.backup.collections.staff_profiles.raw);
  const account = await f.db
    .collection("accounts")
    .findOne({ _id: p.person.id });
  assert.ok(account.passwordHash);
  assert.equal(account.mfa.enabled, true);
  assert.equal(account.version, 2);
  assert.ok(
    (
      await f.db
        .collection("staff_sessions")
        .findOne({ _id: "synthetic-old-session" })
    ).revokedAt,
  );
});
