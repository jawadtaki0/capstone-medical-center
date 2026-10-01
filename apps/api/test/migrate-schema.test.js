import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { BSON, Long } from "mongodb";
import { MIGRATION_LOCK } from "../src/public-data-gate.js";
import { BACKUP_COLLECTIONS, DEVELOPMENT_DATABASE, LEGACY_ARCHIVE_COLLECTION,
  READ_INDEXES, buildSchemaCleanupPlan, cloneBson, sameBson } from "../src/schema-cleanup-plan.js";
import { COLLECTIONS } from "../src/schedule-model.js";
import { buildScheduleSeed, SEED_ID, WEEKLY_SCHEDULE_ID } from "../src/schedule-seed-data.js";

// This test worker targets a fake database only, independently of local .env.
// The production module captures this explicit name, not any Mongo credentials.
const originalDatabaseName = process.env.MONGODB_DB_NAME;
process.env.MONGODB_DB_NAME = DEVELOPMENT_DATABASE;
const { runSchemaCleanup, captureSnapshot, unpackBson } = await import("../src/migrate-schema.js");
if (originalDatabaseName === undefined) delete process.env.MONGODB_DB_NAME;
else process.env.MONGODB_DB_NAME = originalDatabaseName;

function oldCollections() {
  const seed = buildScheduleSeed("2026-09-30T10:00:00.000Z");
  const oldProfiles = (profiles) => profiles.map(({ gender: _gender, ...profile }) => ({
    ...profile, _id: `cedar:${profile._id}`, centerId: "cedar", publicationStatus: "published",
  }));
  const weekly = cloneBson(seed.weeklySchedule);
  weekly._id = `cedar:${WEEKLY_SCHEDULE_ID}`;
  weekly.centerId = "cedar";
  weekly.source = "synthetic-owner-schedule";
  for (const day of Object.values(weekly.days)) {
    for (const session of day.doctorSessions) session.doctorId = `cedar:${session.doctorId}`;
    for (const session of day.specialistSessions) session.specialistId = `cedar:${session.specialistId}`;
  }
  return {
    [COLLECTIONS.doctors]: oldProfiles(seed.doctors),
    [COLLECTIONS.specialists]: oldProfiles(seed.specialists),
    [COLLECTIONS.weekly]: [weekly],
    [COLLECTIONS.changes]: [],
    [COLLECTIONS.seeds]: [{ _id: `cedar:${SEED_ID}`, completedAt: new Date("2026-09-30T10:01:00.000Z") }],
    [LEGACY_ARCHIVE_COLLECTION]: [{ _id: "synthetic-announcement", date: "2026-09-01", serial: Long.fromString("9007199254740993") }],
  };
}

function fakeMongo({ failTransaction = false, failDdl = false } = {}) {
  const events = [];
  let states = new Map(Object.entries(oldCollections()).map(([name, documents]) => [name, {
    documents: new Map(documents.map((document) => [document._id, cloneBson(document)])),
    indexes: [
      { name: "_id_", key: { _id: 1 } },
      ...(name === LEGACY_ARCHIVE_COLLECTION || name === COLLECTIONS.seeds ? [] : [
        { name: "old_scope", key: { centerId: 1, publicationStatus: 1 } },
      ]),
    ],
    options: {},
  }]));
  let transactionFailure = failTransaction;
  let ddlFailure = failDdl;
  const stateCopy = () => new Map([...states].map(([name, state]) => [name, {
    documents: new Map([...state.documents].map(([id, document]) => [id, cloneBson(document)])),
    indexes: state.indexes.map(cloneBson), options: cloneBson(state.options),
  }]));
  const database = {
    databaseName: DEVELOPMENT_DATABASE,
    admin: () => ({ async command(command) { assert.deepEqual(command, { hello: 1 }); return { setName: "synthetic-replica-set" }; } }),
    listCollections({ name }) {
      return { async toArray() { return states.has(name) ? [{ name, options: states.get(name).options }] : []; } };
    },
    collection(name) {
      const state = () => {
        const value = states.get(name);
        assert.ok(value, `Unexpected collection creation: ${name}`);
        return value;
      };
      const requireTransaction = (session) => assert.equal(session?.inTransaction(), true);
      return {
        find(query, { raw, session } = {}) {
          assert.deepEqual(query, {});
          assert.equal(raw, true);
          if (session) requireTransaction(session);
          return { async toArray() { return [...state().documents.values()].map((document) => BSON.serialize(document)); } };
        },
        listIndexes: () => ({ async toArray() { return state().indexes.map(cloneBson); } }),
        async insertOne(document, { session }) {
          requireTransaction(session);
          assert.equal(state().documents.has(document._id), false);
          state().documents.set(document._id, cloneBson(document));
          events.push({ operation: "insert", name, id: document._id });
          if (transactionFailure) { transactionFailure = false; throw new Error("Synthetic transaction failure"); }
        },
        async deleteOne({ _id }, { session }) {
          requireTransaction(session);
          const deleted = state().documents.delete(_id);
          events.push({ operation: "delete", name, id: _id });
          return { deletedCount: Number(deleted) };
        },
        async replaceOne({ _id }, document, { session }) {
          requireTransaction(session);
          assert.equal(document._id, _id);
          const matched = state().documents.has(_id);
          if (matched) state().documents.set(_id, cloneBson(document));
          events.push({ operation: "replace", name, id: _id });
          return { matchedCount: Number(matched) };
        },
        async dropIndex(indexName) {
          events.push({ operation: "dropIndex", name, indexName });
          if (ddlFailure) { ddlFailure = false; throw new Error("Synthetic DDL failure"); }
          state().indexes = state().indexes.filter((index) => index.name !== indexName);
        },
        async createIndex(key) {
          events.push({ operation: "createIndex", name });
          state().indexes.push({ name: Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join("_"), key: cloneBson(key) });
        },
        async drop(options) {
          assert.deepEqual(options, { writeConcern: { w: "majority" } });
          events.push({ operation: "drop", name });
          assert.equal(states.delete(name), true);
        },
      };
    },
  };
  const client = {
    db(name) { assert.equal(name, DEVELOPMENT_DATABASE); return database; },
    startSession() {
      let active = false;
      events.push({ operation: "startSession" });
      return {
        inTransaction: () => active,
        async withTransaction(callback, options) {
          assert.deepEqual(options, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
          const before = stateCopy();
          active = true;
          events.push({ operation: "transactionBegin" });
          try { await callback(); events.push({ operation: "transactionCommit" }); }
          catch (error) { states = before; events.push({ operation: "transactionRollback" }); throw error; }
          finally { active = false; }
        },
        async endSession() { events.push({ operation: "endSession" }); },
      };
    },
  };
  return { client, database, events, hasCollection: (name) => states.has(name) };
}

function testOptions(context, mongo) {
  const lockPath = join(dirname(MIGRATION_LOCK), `synthetic-${randomUUID()}.lock`);
  const options = { client: mongo.client, databaseName: DEVELOPMENT_DATABASE, apiOrigin: "http://127.0.0.1:4000", lockPath };
  context.mock.method(console, "log", () => undefined);
  context.mock.method(console, "error", () => undefined);
  context.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(new URL(url).pathname, "/api/health");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(lock.database, DEVELOPMENT_DATABASE);
    options.latestBackup = lock.backup;
    mongo.events.push({ operation: "readGateVerified" });
    return { async json() { return { service: "medical-center-api", database: "connected", publicData: { paused: true, activeReaders: 0 } }; } };
  });
  return options;
}

async function backupFromFailure(options) {
  assert.ok(options.latestBackup);
  const result = JSON.parse(await readFile(join(options.latestBackup, "result.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(options.latestBackup, "manifest.json"), "utf8"));
  assert.equal(manifest.database, options.databaseName);
  assert.equal(result.status, "incomplete");
  return { directory: options.latestBackup, result };
}

test("schema cleanup dry-run plans changes without a transaction, gate or writes", async (context) => {
  const mongo = fakeMongo();
  const options = testOptions(context, mongo);
  const before = await captureSnapshot(mongo.database);
  const result = await runSchemaCleanup(options);
  assert.equal(result.status, "dry_run");
  assert.equal(result.plan.operations.length, 21);
  assert.equal(result.plan.summary.profileGenders.male, 11);
  assert.equal(result.plan.summary.profileGenders.female, 8);
  assert.deepEqual(mongo.events, []);
  await assert.rejects(readFile(options.lockPath), { code: "ENOENT" });
  const after = await captureSnapshot(mongo.database);
  for (const name of BACKUP_COLLECTIONS) assert.equal(sameBson({ records: before[name].documents }, { records: after[name].documents }), true);
});

test("apply backs up BSON, gates readers, remaps transactionally, removes only legacy, and reruns without writes", async (context) => {
  const mongo = fakeMongo();
  const options = testOptions(context, mongo);
  const result = await runSchemaCleanup({ ...options, apply: true });
  assert.equal(result.status, "completed");
  assert.equal(mongo.events[0].operation, "readGateVerified");
  assert.ok(mongo.events.some(({ operation }) => operation === "transactionCommit"));
  assert.deepEqual(mongo.events.filter(({ operation }) => operation === "drop").map(({ name }) => name), [LEGACY_ARCHIVE_COLLECTION]);
  assert.equal(mongo.hasCollection(LEGACY_ARCHIVE_COLLECTION), false);
  assert.deepEqual(result.after[COLLECTIONS.changes].documents, []);
  assert.equal(result.after[COLLECTIONS.doctors].documents.length, 16);
  assert.equal(result.after[COLLECTIONS.specialists].documents.length, 3);
  assert.equal(result.after[COLLECTIONS.weekly].documents[0]._id, WEEKLY_SCHEDULE_ID);
  assert.equal(result.after[COLLECTIONS.weekly].documents[0].effectiveFrom, null);
  assert.equal(result.after[COLLECTIONS.seeds].documents[0]._id, SEED_ID);
  const markerBytes = await readFile(join(result.backup.directory, DEVELOPMENT_DATABASE, `${COLLECTIONS.seeds}.bson`));
  assert.ok(unpackBson(markerBytes)[0].completedAt instanceof Date);
  const legacyBytes = await readFile(join(result.backup.directory, DEVELOPMENT_DATABASE, `${LEGACY_ARCHIVE_COLLECTION}.bson`));
  assert.equal(unpackBson(legacyBytes)[0].serial.toString(), "9007199254740993");
  await assert.rejects(readFile(options.lockPath), { code: "ENOENT" });
  const beforeEvents = mongo.events.length;
  const rerun = await runSchemaCleanup({ ...options, apply: true });
  assert.equal(rerun.status, "already_clean");
  assert.deepEqual(mongo.events.slice(beforeEvents), []);
  assert.notEqual(rerun.backup.directory, result.backup.directory);
  assert.equal(buildSchemaCleanupPlan(await captureSnapshot(mongo.database)).operations.length, 0);
  for (const [name, key] of Object.entries(READ_INDEXES)) assert.equal(rerun.plan.indexes.some((index) => index.collection === name), false, JSON.stringify(key));
});

test("transaction failure rolls back document changes, records recoverable phase and releases only its gate", async (context) => {
  const mongo = fakeMongo({ failTransaction: true });
  const options = testOptions(context, mongo);
  const before = await captureSnapshot(mongo.database);
  await assert.rejects(runSchemaCleanup({ ...options, apply: true }), /Synthetic transaction failure/);
  assert.ok(mongo.events.some(({ operation }) => operation === "transactionRollback"));
  assert.equal(mongo.events.some(({ operation }) => operation === "drop"), false);
  const after = await captureSnapshot(mongo.database);
  for (const name of BACKUP_COLLECTIONS) assert.equal(sameBson({ records: before[name].documents }, { records: after[name].documents }), true);
  await assert.rejects(readFile(options.lockPath), { code: "ENOENT" });
  const failure = await backupFromFailure(options);
  assert.equal(failure.result.phase, "transaction");
  assert.equal(failure.result.requiresReview, true);
});

test("post-commit DDL failure preserves remapped records and backup; a rerun finishes cleanup", async (context) => {
  const mongo = fakeMongo({ failDdl: true });
  const options = testOptions(context, mongo);
  await assert.rejects(runSchemaCleanup({ ...options, apply: true }), /Synthetic DDL failure/);
  assert.ok(mongo.events.some(({ operation }) => operation === "transactionCommit"));
  assert.equal(mongo.hasCollection(LEGACY_ARCHIVE_COLLECTION), true);
  const snapshot = await captureSnapshot(mongo.database);
  assert.equal(snapshot[COLLECTIONS.doctors].documents.every(({ _id }) => _id.startsWith("doctor:")), true);
  const failure = await backupFromFailure(options);
  assert.equal(failure.result.phase, "indexes");
  await assert.rejects(readFile(options.lockPath), { code: "ENOENT" });
  const result = await runSchemaCleanup({ ...options, apply: true });
  assert.equal(result.status, "completed");
  assert.equal(result.plan.operations.length, 0);
  assert.equal(mongo.hasCollection(LEGACY_ARCHIVE_COLLECTION), false);
});
