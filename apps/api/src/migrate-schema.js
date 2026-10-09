import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BSON, MongoClient } from "mongodb";
import { config } from "./config.js";
import { MIGRATION_LOCK } from "./public-data-gate.js";
import {
  BACKUP_COLLECTIONS,
  DEVELOPMENT_DATABASE,
  LEGACY_ARCHIVE_COLLECTION,
  SCHEMA_COLLECTIONS,
  buildSchemaCleanupPlan,
  sameBson,
} from "./schema-cleanup-plan.js";

const backupRoot = resolve(dirname(MIGRATION_LOCK), "backups");
const bsonOptions = { promoteValues: false, promoteLongs: false };

// Raw BSON is the backup source; JSON is only the inspectable manifest/metadata.
export function unpackBson(bytes) {
  const documents = [];
  for (let offset = 0; offset < bytes.length; ) {
    if (bytes.length - offset < 5) throw new Error("Truncated BSON backup.");
    const length = bytes.readInt32LE(offset);
    if (length < 5 || offset + length > bytes.length)
      throw new Error("Invalid BSON backup length.");
    documents.push(
      BSON.deserialize(bytes.subarray(offset, offset + length), bsonOptions),
    );
    offset += length;
  }
  return documents;
}

function digest(buffers) {
  // Mongo's natural document order may change after record replacements.
  const sorted = buffers
    .map((bytes) => ({ bytes, id: String(BSON.deserialize(bytes)._id) }))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  const hash = createHash("sha256");
  for (const { bytes } of sorted) hash.update(bytes);
  return hash.digest("hex");
}

export async function captureSnapshot(
  database,
  { session, knownCollections } = {},
) {
  const snapshot = {};
  for (const name of BACKUP_COLLECTIONS) {
    // listCollections/listIndexes are deliberately outside transactions.
    const metadata = knownCollections
      ? knownCollections[name]
      : (
          await database
            .listCollections({ name }, { nameOnly: false })
            .toArray()
        )[0];
    const exists = knownCollections ? metadata.exists : Boolean(metadata);
    const raw = exists
      ? await database
          .collection(name)
          .find({}, { raw: true, session })
          .toArray()
      : [];
    if (raw.some((bytes) => !Buffer.isBuffer(bytes)))
      throw new Error("Raw BSON capture is required; refusing a lossy backup.");
    snapshot[name] = {
      exists,
      documents: raw.map((bytes) => BSON.deserialize(bytes, bsonOptions)),
      raw,
      indexes:
        exists && !knownCollections
          ? await database.collection(name).listIndexes().toArray()
          : (metadata?.indexes ?? []),
      options: knownCollections ? metadata.options : (metadata?.options ?? {}),
    };
  }
  return snapshot;
}

export async function writeBackup(databaseName, snapshot) {
  if (!/^[a-z][a-z0-9_-]*$/i.test(databaseName))
    throw new Error("Invalid backup database name.");
  const directory = join(
    backupRoot,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: true });
  const databaseDirectory = join(directory, databaseName);
  await mkdir(databaseDirectory);
  const manifest = {
    format: "raw-concatenated-bson-v1",
    database: databaseName,
    capturedAt: new Date().toISOString(),
    collections: {},
  };
  for (const name of BACKUP_COLLECTIONS) {
    const collection = snapshot[name];
    const bytes = Buffer.concat(collection.raw);
    const bsonPath = join(databaseDirectory, `${name}.bson`);
    await writeFile(bsonPath, bytes, { flag: "wx" });
    await writeFile(
      join(databaseDirectory, `${name}.metadata.json`),
      BSON.EJSON.stringify(
        {
          exists: collection.exists,
          options: collection.options,
          indexes: collection.indexes,
        },
        { relaxed: false },
      ),
      { flag: "wx" },
    );
    const verified = await readFile(bsonPath);
    if (
      !verified.equals(bytes) ||
      unpackBson(verified).length !== collection.documents.length
    )
      throw new Error(
        "Backup verification failed; no migration writes permitted.",
      );
    manifest.collections[name] = {
      existed: collection.exists,
      count: collection.documents.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      documentDigest: digest(collection.raw),
    };
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx" },
  );
  return { directory, manifest };
}

export function assertSnapshotUnchanged(
  expected,
  current,
  names = BACKUP_COLLECTIONS,
) {
  for (const name of names) {
    if (
      expected[name].exists !== current[name].exists ||
      expected[name].raw.length !== current[name].raw.length ||
      digest(expected[name].raw) !== digest(current[name].raw) ||
      !sameBson(
        { options: expected[name].options, indexes: expected[name].indexes },
        { options: current[name].options, indexes: current[name].indexes },
      )
    ) {
      throw new Error(
        `Collection ${name} changed after backup; migration stopped without overwriting the new data.`,
      );
    }
  }
}

export async function applyDocumentPlan(database, plan, session) {
  if (!session?.inTransaction())
    throw new Error("Record remapping requires an active transaction.");
  for (const { collection, oldId, document } of plan.operations) {
    const target = database.collection(collection);
    if (oldId !== document._id) {
      // _id cannot be changed in place. Insert + delete share the transaction.
      await target.insertOne(document, { session });
      const result = await target.deleteOne({ _id: oldId }, { session });
      if (result.deletedCount !== 1)
        throw new Error(`Original record disappeared: ${collection}/${oldId}.`);
    } else {
      const result = await target.replaceOne({ _id: oldId }, document, {
        session,
      });
      if (result.matchedCount !== 1)
        throw new Error(`Original record disappeared: ${collection}/${oldId}.`);
    }
  }
}

function assertPlanApplied(plan, snapshot) {
  for (const name of SCHEMA_COLLECTIONS) {
    const actual = new Map(
      snapshot[name].documents.map((document) => [document._id, document]),
    );
    if (actual.size !== plan.collections[name].length)
      throw new Error(`Post-migration count mismatch in ${name}.`);
    for (const document of plan.collections[name]) {
      if (
        !actual.has(document._id) ||
        !sameBson(actual.get(document._id), document)
      )
        throw new Error(`Post-migration mismatch in ${name}/${document._id}.`);
    }
  }
}

export function assertDevelopmentTarget(requested, configured, actual) {
  if (
    requested !== DEVELOPMENT_DATABASE ||
    configured !== requested ||
    actual !== requested
  ) {
    throw new Error(
      "Target mismatch: this migration is restricted to the explicitly selected medical-center-dev database.",
    );
  }
}

async function waitForReaders(origin) {
  const url = new URL(origin);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:"
  )
    throw new Error(
      "Migration coordination requires the local development API.",
    );
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/api/health", url), {
      signal: AbortSignal.timeout(7000),
    });
    const health = await response.json();
    if (
      health.service !== "medical-center-api" ||
      health.publicData?.paused !== true
    )
      throw new Error(
        "The local API has not loaded the migration read gate. No database writes permitted.",
      );
    if (health.database !== "connected")
      throw new Error(
        "Development database is unavailable. No migration writes permitted.",
      );
    if (health.publicData.activeReaders === 0) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(
    "Existing public reads did not drain; no migration writes permitted.",
  );
}

export async function runSchemaCleanup({
  client,
  databaseName,
  apply = false,
  apiOrigin,
  lockPath = MIGRATION_LOCK,
}) {
  const database = client.db(databaseName);
  assertDevelopmentTarget(
    databaseName,
    config.mongoDbName,
    database.databaseName,
  );
  const topology = await database.admin().command({ hello: 1 });
  if (!topology.setName || topology.msg === "isdbgrid")
    throw new Error(
      "This development migration requires a replica-set transaction; standalone/sharded targets are not modified.",
    );
  const before = await captureSnapshot(database);
  const plan = buildSchemaCleanupPlan(before);
  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        database: databaseName,
        transaction: "replica-set",
        ...plan.summary,
      },
      null,
      2,
    ),
  );
  if (!apply) return { status: "dry_run", plan };

  // Every apply, including a no-op rerun, captures a fresh verified local backup.
  const backup = await writeBackup(databaseName, before);
  console.log(`Verified BSON backup: ${backup.directory}`);
  if (!plan.operations.length && !plan.indexes.length && !plan.archiveLegacy)
    return { status: "already_clean", backup, plan };
  await mkdir(dirname(lockPath), { recursive: true });
  const lockToken = randomUUID();
  await writeFile(
    lockPath,
    JSON.stringify({
      token: lockToken,
      pid: process.pid,
      database: databaseName,
      backup: backup.directory,
    }),
    { flag: "wx" },
  );
  let phase = "read_gate";
  try {
    await waitForReaders(apiOrigin ?? `http://127.0.0.1:${config.port}`);
    // Inspect metadata once more outside the transaction, where MongoDB allows it.
    assertSnapshotUnchanged(before, await captureSnapshot(database));
    phase = "transaction";
    const session = client.startSession();
    try {
      await session.withTransaction(
        async () => {
          const current = await captureSnapshot(database, {
            session,
            knownCollections: before,
          });
          assertSnapshotUnchanged(before, current);
          // Revalidate references/collisions inside the same snapshot transaction.
          const transactionPlan = buildSchemaCleanupPlan(current);
          await applyDocumentPlan(database, transactionPlan, session);
          assertPlanApplied(
            transactionPlan,
            await captureSnapshot(database, {
              session,
              knownCollections: before,
            }),
          );
        },
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          readPreference: "primary",
        },
      );
    } finally {
      await session.endSession();
    }
    phase = "post_commit_verification";
    assertPlanApplied(plan, await captureSnapshot(database));

    // DDL cannot share the document transaction. Public reads stay paused while
    // obsolete indexes and the unused legacy collection are removed separately.
    phase = "indexes";
    for (const index of plan.indexes) {
      const collection = database.collection(index.collection);
      for (const name of index.drop) await collection.dropIndex(name);
      if (index.create) await collection.createIndex(index.create);
    }
    phase = "legacy_archive_removal";
    if (plan.archiveLegacy) {
      const current = await captureSnapshot(database);
      assertSnapshotUnchanged(before, current, [LEGACY_ARCHIVE_COLLECTION]);
      await database
        .collection(LEGACY_ARCHIVE_COLLECTION)
        .drop({ writeConcern: { w: "majority" } });
    }
    const after = await captureSnapshot(database);
    assertPlanApplied(plan, after);
    const remaining = buildSchemaCleanupPlan(after);
    if (
      remaining.operations.length ||
      remaining.indexes.length ||
      remaining.archiveLegacy
    )
      throw new Error(
        "Cleanup is incomplete; inspect the verified backup before further action.",
      );
    await writeFile(
      join(backup.directory, "result.json"),
      JSON.stringify(
        {
          status: "completed",
          completedAt: new Date().toISOString(),
          summary: remaining.summary,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    console.log("Schema cleanup completed; public read gate released.");
    return { status: "completed", backup, plan, after };
  } catch (error) {
    // Record phase without logging a driver error that might contain a URI.
    await writeFile(
      join(backup.directory, "result.json"),
      JSON.stringify(
        { status: "incomplete", phase, requiresReview: true },
        null,
        2,
      ),
      { flag: "wx" },
    ).catch(() => undefined);
    console.error(
      `Migration stopped during ${phase}. Backup retained at ${backup.directory}. A transaction failure rolls back all related record changes; post-commit cleanup can be rerun.`,
    );
    throw error;
  } finally {
    let lock;
    try {
      lock = JSON.parse(await readFile(lockPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (lock?.token === lockToken) await unlink(lockPath);
  }
}

function argumentsFor(argv) {
  let apply = false;
  let databaseName;
  let apiOrigin;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--apply") apply = true;
    else if (argv[index] === "--dry-run") apply = false;
    else if (argv[index] === "--database") databaseName = argv[++index];
    else if (argv[index] === "--api-origin") apiOrigin = argv[++index];
    else throw new Error("Unknown migration argument.");
  }
  assertDevelopmentTarget(databaseName, config.mongoDbName, databaseName);
  return { apply, databaseName, apiOrigin };
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (!config.mongoUri)
    throw new Error("A configured development connection is required.");
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 15000,
  });
  try {
    await client.connect();
    await runSchemaCleanup({ client, ...options });
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    const safeMessage = [
      "Target mismatch",
      "Unconfirmed profile",
      "Destination-ID collision",
      "Broken",
      "Unexpected",
      "Required collection",
      "Collection ",
      "The local API",
      "Development database",
      "Existing public reads",
      "This development migration",
      "Migration coordination",
      "Unknown migration",
      "A configured",
    ].some((prefix) => error.message.startsWith(prefix));
    console.error(
      safeMessage
        ? error.message
        : "Schema cleanup failed. Database security settings were not changed; inspect connectivity and the local backup/status before retrying.",
    );
    process.exitCode = 1;
  });
}
