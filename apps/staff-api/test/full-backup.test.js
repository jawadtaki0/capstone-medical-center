import test from "node:test";
import assert from "node:assert/strict";
import { BSON, Long } from "mongodb";
import {
  encodeFullBackup,
  decodeFullBackup,
  fullBackupSummary,
} from "../src/full-backup.js";

const wrap = async (v) => Buffer.from(v);
function fixture() {
  return {
    version: 1,
    database: "capstone_staff_test",
    createdAt: new Date("2026-10-31T00:00:00Z"),
    collections: [
      {
        name: "full_backup_test_records",
        options: {},
        indexes: [{ key: { _id: 1 }, name: "_id_", unique: true }],
        raw: [
          BSON.serialize({
            _id: "synthetic",
            counter: Long.fromString("9223372036854775800"),
            bytes: Buffer.from([0, 255]),
            at: new Date(0),
          }),
        ],
      },
    ],
  };
}
test("full backup preserves exact BSON and index metadata after protected readback", async () => {
  const f = fixture(),
    result = await decodeFullBackup(await encodeFullBackup(f, wrap), wrap);
  assert.deepEqual(result.collections[0].raw[0], f.collections[0].raw[0]);
  assert.deepEqual(result.collections[0].indexes, f.collections[0].indexes);
  assert.deepEqual(fullBackupSummary(result), fullBackupSummary(f));
});
test("encrypted backup refuses changed ciphertext and invalid target", async () => {
  const encrypted = await encodeFullBackup(fixture(), wrap);
  const envelope = BSON.deserialize(encrypted, { promoteBuffers: true });
  envelope.encrypted[0] ^= 1;
  await assert.rejects(
    decodeFullBackup(BSON.serialize(envelope), wrap),
    /validation failed/,
  );
  const invalid = fixture();
  invalid.database = "medical-center-dev";
  await assert.rejects(encodeFullBackup(invalid, wrap), /validation failed/);
});
test("malformed or duplicate collection records cannot pass verification", () => {
  const f = fixture();
  f.collections.push(f.collections[0]);
  assert.throws(() => fullBackupSummary(f), /validation failed/);
  const broken = fixture();
  broken.collections[0].raw[0] = Buffer.from([1]);
  assert.throws(() => fullBackupSummary(broken), /validation failed/);
});
