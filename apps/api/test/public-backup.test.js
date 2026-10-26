import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BSON } from "mongodb";
import {
  writeBsonBackup,
  readBsonBackup,
  backupDigest,
} from "../src/public-data-backup.js";

test("private backup retains BSON types, existence, metadata and detects tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "cedar-backup-test-"));
  try {
    const record = BSON.serialize({
      _id: "doctor:synthetic",
      name: "Synthetic",
      timestamp: new Date(0),
      counter: BSON.Long.fromString("9007199254740993"),
    });
    const snapshot = {
      database: "capstone_staff_test",
      collections: {
        doctor_profiles: {
          exists: true,
          raw: [record],
          metadata: { indexes: [{ key: { _id: 1 } }], options: {} },
        },
        schedule_date_changes: {
          exists: false,
          raw: [],
          metadata: { indexes: [], options: {} },
        },
      },
    };
    const directory = join(root, "backup");
    await writeBsonBackup(directory, snapshot);
    const read = await readBsonBackup(directory);
    assert.equal(backupDigest(read), backupDigest(snapshot));
    const document = BSON.deserialize(read.collections.doctor_profiles.raw[0], {
      promoteLongs: false,
    });
    assert.equal(document.timestamp.getTime(), 0);
    assert.equal(document.counter.toString(), "9007199254740993");
    assert.equal(read.collections.schedule_date_changes.exists, false);
    await assert.rejects(writeBsonBackup(directory, snapshot));
    const path = join(directory, "doctor_profiles.bson");
    const bytes = await readFile(path);
    bytes[8] ^= 1;
    await writeFile(path, bytes);
    await assert.rejects(readBsonBackup(directory), /integrity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup refuses staff authentication collections and traversal", async () => {
  assert.throws(
    () =>
      backupDigest({
        database: "capstone_staff_test",
        collections: { accounts: { exists: true, raw: [], metadata: {} } },
      }),
    /collection/,
  );
  assert.throws(
    () =>
      backupDigest({
        database: "capstone_staff_test",
        collections: { "../secret": { exists: true, raw: [], metadata: {} } },
      }),
    /collection/,
  );
});
