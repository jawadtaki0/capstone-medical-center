import { test } from "node:test";
import assert from "node:assert/strict";
import { BSON } from "mongodb";
import {
  assertNormalRoleTarget,
  encodeRoleBackup,
  decodeRoleBackup,
  ROLE_BACKUP_COLLECTIONS,
} from "../src/role-cutover-backup.js";

const context = {
  mode: "normal-local",
  runtimeFingerprint: "a".repeat(64),
  database: "capstone_staff_dev",
  demoMode: true,
};
const target = {
  options: {
    hosts: [{ host: "127.0.0.1", port: 27018 }],
    replicaSet: "capstoneStaffDev",
  },
};
test("normal role target is explicit and cannot substitute TEST, Atlas or another runtime", () => {
  assert.doesNotThrow(() =>
    assertNormalRoleTarget(
      { databaseName: "capstone_staff_dev" },
      target,
      context,
    ),
  );
  for (const databaseName of ["capstone_staff_test", "medical-center-dev"])
    assert.throws(() =>
      assertNormalRoleTarget({ databaseName }, target, context),
    );
  for (const extra of [
    { mode: "test" },
    { demoMode: false },
    { runtimeFingerprint: "" },
    { database: "capstone_staff_test" },
  ])
    assert.throws(() =>
      assertNormalRoleTarget({ databaseName: "capstone_staff_dev" }, target, {
        ...context,
        ...extra,
      }),
    );
  assert.throws(() =>
    assertNormalRoleTarget(
      { databaseName: "capstone_staff_dev" },
      {
        options: {
          ...target.options,
          hosts: [{ host: "localhost", port: 27018 }],
        },
      },
      context,
    ),
  );
});

const dummy = () => ({
  version: 1,
  database: "capstone_staff_test",
  runtimeFingerprint: context.runtimeFingerprint,
  snapshotDigest: "b".repeat(64),
  collections: Object.fromEntries(
    ROLE_BACKUP_COLLECTIONS.map((name) => [
      name,
      {
        existed: name === "accounts",
        options: {},
        indexes: [],
        raw:
          name === "accounts"
            ? [
                BSON.serialize({
                  _id: "synthetic",
                  secret: "DUMMY_ONLY",
                  time: new Date(0),
                  integer: BSON.Long.fromNumber(17),
                }),
              ]
            : [],
      },
    ]),
  ),
});
// Dummy crypto boundary: no real runtime/key reads or network/provider calls.
const wrap = async (bytes) => Buffer.from(bytes.map((b) => b ^ 173));
test("protected BSON envelope preserves types, requires complete state and detects corruption", async () => {
  const source = dummy();
  const bytes = await encodeRoleBackup(source, wrap);
  assert.equal(bytes.includes(Buffer.from("DUMMY_ONLY")), false);
  const restored = await decodeRoleBackup(bytes, wrap);
  assert.deepEqual(
    restored.collections.accounts.raw[0],
    source.collections.accounts.raw[0],
  );
  const document = BSON.deserialize(restored.collections.accounts.raw[0], {
    promoteLongs: false,
  });
  assert.ok(document.time instanceof Date);
  assert.ok(document.integer instanceof BSON.Long);
  bytes[bytes.length - 2] ^= 1;
  await assert.rejects(decodeRoleBackup(bytes, wrap));
  delete source.collections.staff_sessions;
  await assert.rejects(encodeRoleBackup(source, wrap));
});
