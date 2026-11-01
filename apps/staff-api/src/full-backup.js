import { BSON } from "mongodb";
import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { dpapi } from "./local-security.js";

const MAX_BYTES = 128 * 1024 * 1024;
const hash = (v) => createHash("sha256").update(v).digest("hex");
const fail = () => {
  throw Error("Full backup validation failed; no restore was attempted.");
};

async function metadata(db, names) {
  const definitions = await db
    .listCollections({}, { nameOnly: false })
    .toArray();
  const selected = names
    ? definitions.filter((x) => names.includes(x.name))
    : definitions;
  if (names && selected.length !== names.length) fail();
  const result = [];
  for (const d of selected.sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.type !== "collection") fail();
    result.push({
      name: d.name,
      options: d.options ?? {},
      indexes: await db.collection(d.name).listIndexes().toArray(),
    });
  }
  return result;
}

// Collection/index definitions are checked around a consistent document snapshot.
// No initializeIndexes, writes, restore, or account setup is performed here.
export async function captureFullBackup({ db, client, testNames }) {
  if (
    !["capstone_staff_dev", "capstone_staff_test"].includes(db.databaseName) ||
    (testNames &&
      (db.databaseName !== "capstone_staff_test" ||
        !testNames.length ||
        testNames.some((n) => !/^full_backup_test_[a-z0-9_]+$/.test(n))))
  )
    fail();
  const before = await metadata(db, testNames);
  if (before.length > 1000) fail();
  const session = client.startSession();
  let collections;
  try {
    await session.withTransaction(
      async () => {
        let bytes = 0;
        collections = [];
        for (const definition of before) {
          const raw = [];
          const cursor = db
            .collection(definition.name)
            .find({}, { session, raw: true })
            .sort({ _id: 1 });
          for await (const doc of cursor) {
            bytes += doc.length;
            if (bytes > MAX_BYTES) fail();
            raw.push(Buffer.from(doc));
          }
          collections.push({ ...definition, raw });
        }
      },
      { readConcern: { level: "snapshot" }, maxCommitTimeMS: 10000 },
    );
  } finally {
    await session.endSession();
  }
  if (
    !BSON.serialize({ value: before }).equals(
      BSON.serialize({ value: await metadata(db, testNames) }),
    )
  )
    fail();
  return {
    version: 1,
    database: db.databaseName,
    createdAt: new Date(),
    collections,
  };
}

function validate(snapshot) {
  if (
    snapshot?.version !== 1 ||
    !["capstone_staff_dev", "capstone_staff_test"].includes(
      snapshot.database,
    ) ||
    !(snapshot.createdAt instanceof Date) ||
    !Array.isArray(snapshot.collections) ||
    snapshot.collections.length > 1000
  )
    fail();
  const names = new Set();
  let bytes = 0;
  for (const c of snapshot.collections) {
    if (
      typeof c.name !== "string" ||
      names.has(c.name) ||
      !Array.isArray(c.raw) ||
      !Array.isArray(c.indexes) ||
      !c.options
    )
      fail();
    names.add(c.name);
    for (const raw of c.raw) {
      if (
        !Buffer.isBuffer(raw) ||
        raw.length < 5 ||
        raw.readInt32LE(0) !== raw.length
      )
        fail();
      bytes += raw.length;
      if (bytes > MAX_BYTES) fail();
      BSON.deserialize(raw, { promoteLongs: false });
    }
  }
  return snapshot;
}

export function fullBackupSummary(snapshot) {
  validate(snapshot);
  return {
    database: snapshot.database,
    collectionCount: snapshot.collections.length,
    documentCount: snapshot.collections.reduce((n, c) => n + c.raw.length, 0),
    digest: hash(BSON.serialize(snapshot)),
  };
}

export async function encodeFullBackup(snapshot, wrap = dpapi) {
  const plain = BSON.serialize(validate(snapshot));
  const key = randomBytes(32),
    iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return BSON.serialize({
      version: 1,
      key: await wrap(key, "Protect"),
      iv,
      tag: cipher.getAuthTag(),
      encrypted,
      digest: hash(plain),
    });
  } finally {
    plain.fill(0);
    key.fill(0);
  }
}

export async function decodeFullBackup(bytes, unwrap = dpapi) {
  let key, plain;
  try {
    const e = BSON.deserialize(bytes, { promoteBuffers: true });
    if (
      e.version !== 1 ||
      !Buffer.isBuffer(e.encrypted) ||
      e.encrypted.length > MAX_BYTES + 16 * 1024 * 1024
    )
      fail();
    key = await unwrap(e.key, "Unprotect");
    const cipher = createDecipheriv("aes-256-gcm", key, e.iv);
    cipher.setAuthTag(e.tag);
    plain = Buffer.concat([cipher.update(e.encrypted), cipher.final()]);
    if (hash(plain) !== e.digest) fail();
    return validate(
      BSON.deserialize(plain, { promoteBuffers: true, promoteLongs: false }),
    );
  } catch {
    fail();
  } finally {
    key?.fill(
      0,
    ); /* BSON buffers can reference plain; retained by the returned snapshot. */
  }
}
