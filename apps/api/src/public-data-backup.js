import { BSON } from "mongodb";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PUBLIC_BASELINE_COLLECTIONS = Object.freeze([
  "doctor_profiles",
  "specialist_profiles",
  "weekly_schedules",
  "schedule_date_changes",
  "schedule_seed_runs",
]);
export const BACKUP_COLLECTIONS = Object.freeze([
  ...PUBLIC_BASELINE_COLLECTIONS,
  "public_accepted_publications",
  "public_publication_state",
  "public_data_authority",
  "operational_scopes",
  "operational_grants",
  "doctor_profile_drafts",
  "specialist_profile_drafts",
  "operational_session_drafts",
  "operational_date_drafts",
  "operational_hours_drafts",
  "operational_state",
  "operational_publications",
  "public_publication_outbox",
  "operational_imports",
]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function names(snapshot) {
  if (
    !snapshot ||
    ![
      "medical-center-dev",
      "capstone_staff_dev",
      "capstone_staff_test",
    ].includes(snapshot.database) ||
    !snapshot.collections ||
    typeof snapshot.collections !== "object"
  )
    throw new Error("Unsupported backup target.");
  const keys = Object.keys(snapshot.collections).sort();
  if (!keys.length || keys.some((name) => !BACKUP_COLLECTIONS.includes(name)))
    throw new Error("Unsupported backup collection.");
  return keys;
}
export function unpackBson(bytes) {
  const records = [];
  for (let offset = 0; offset < bytes.length; ) {
    const length = bytes.length - offset >= 4 ? bytes.readInt32LE(offset) : 0;
    if (length < 5 || offset + length > bytes.length)
      throw new Error("BSON backup integrity failure.");
    const raw = bytes.subarray(offset, offset + length);
    BSON.deserialize(raw, { promoteValues: false, promoteLongs: false });
    records.push(raw);
    offset += length;
  }
  return records;
}
function content(entry) {
  if (
    typeof entry.exists !== "boolean" ||
    !Array.isArray(entry.raw) ||
    entry.raw.some((raw) => !Buffer.isBuffer(raw)) ||
    (!entry.exists && entry.raw.length)
  )
    throw new Error("Raw BSON backup is required.");
  const raw = [...entry.raw].sort((a, b) =>
    String(BSON.deserialize(a)._id).localeCompare(
      String(BSON.deserialize(b)._id),
      "en",
    ),
  );
  return { data: Buffer.concat(raw), metadata: BSON.serialize(entry.metadata) };
}
export function backupDigest(snapshot) {
  return sha(
    JSON.stringify(
      names(snapshot).map((name) => {
        const { data, metadata } = content(snapshot.collections[name]);
        return [
          name,
          snapshot.collections[name].exists,
          sha(data),
          sha(metadata),
        ];
      }),
    ),
  );
}
export async function captureBsonSnapshot(
  db,
  collections = PUBLIC_BASELINE_COLLECTIONS,
  { session } = {},
) {
  const snapshot = {
    database: db.databaseName,
    collections: Object.fromEntries(collections.map((name) => [name, null])),
  };
  names(snapshot);
  for (const name of collections) {
    const definition = (
      await db.listCollections({ name }, { nameOnly: false }).toArray()
    )[0];
    const collection = db.collection(name);
    snapshot.collections[name] = {
      exists: Boolean(definition),
      raw: definition
        ? await collection.find({}, { raw: true, session }).toArray()
        : [],
      metadata: {
        indexes: definition ? await collection.listIndexes().toArray() : [],
        options: definition?.options ?? {},
      },
    };
  }
  backupDigest(snapshot);
  return snapshot;
}
export async function writeBsonBackup(
  directory,
  snapshot,
  { secureDirectory } = {},
) {
  const keys = names(snapshot),
    digest = backupDigest(snapshot);
  await mkdir(directory, { mode: 0o700 });
  if (secureDirectory) await secureDirectory(directory);
  const manifest = {
    version: 1,
    database: snapshot.database,
    digest,
    collections: {},
  };
  for (const name of keys) {
    const entry = snapshot.collections[name],
      { data, metadata } = content(entry);
    await writeFile(join(directory, `${name}.bson`), data, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(directory, `${name}.metadata.bson`), metadata, {
      flag: "wx",
      mode: 0o600,
    });
    manifest.collections[name] = {
      exists: entry.exists,
      count: entry.raw.length,
      dataHash: sha(data),
      metadataHash: sha(metadata),
    };
  }
  // Manifest is written last: an interrupted directory is never a complete backup.
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  const verified = await readBsonBackup(directory);
  if (backupDigest(verified) !== digest)
    throw new Error("Backup integrity failure.");
  return { directory, digest };
}
export async function readBsonBackup(directory) {
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  if (manifest.version !== 1) throw new Error("Unsupported backup version.");
  const snapshot = { database: manifest.database, collections: {} };
  names({ ...snapshot, collections: manifest.collections });
  for (const [name, entry] of Object.entries(manifest.collections)) {
    const data = await readFile(join(directory, `${name}.bson`));
    const metadata = await readFile(join(directory, `${name}.metadata.bson`));
    if (sha(data) !== entry.dataHash || sha(metadata) !== entry.metadataHash)
      throw new Error("Backup integrity failure.");
    const raw = unpackBson(data);
    if (raw.length !== entry.count)
      throw new Error("Backup count integrity failure.");
    snapshot.collections[name] = {
      exists: entry.exists,
      raw,
      metadata: BSON.deserialize(metadata, {
        promoteValues: false,
        promoteLongs: false,
      }),
    };
  }
  if (backupDigest(snapshot) !== manifest.digest)
    throw new Error("Backup integrity failure.");
  return snapshot;
}
