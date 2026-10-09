import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BSON } from "mongodb";
import { COLLECTIONS } from "../src/schedule-model.js";
import { buildScheduleSeed } from "../src/schedule-seed-data.js";
import {
  BACKUP_COLLECTIONS,
  CONFIRMED_GENDERS,
  LEGACY_ARCHIVE_COLLECTION,
  READ_INDEXES,
  buildSchemaCleanupPlan,
  cloneBson,
  neutralId,
  sameBson,
} from "../src/schema-cleanup-plan.js";
import {
  applyDocumentPlan,
  assertDevelopmentTarget,
  assertSnapshotUnchanged,
  unpackBson,
  writeBackup,
} from "../src/migrate-schema.js";
import { getScheduleForDate } from "../src/schedule.js";

function entry(
  documents,
  indexes = [{ name: "_id_", key: { _id: 1 } }],
  exists = true,
) {
  return {
    exists,
    documents,
    raw: documents.map((document) => BSON.serialize(document)),
    indexes,
    options: {},
  };
}

function fixture() {
  const seed = buildScheduleSeed("2026-09-30T17:03:50.751Z");
  const legacyProfile = (person, index) => {
    const record = {
      ...person,
      _id: `cedar:${person._id}`,
      name: `Synthetic Professional ${index}`,
      centerId: "cedar",
      publicationStatus: "published",
    };
    delete record.gender;
    return record;
  };
  const weekly = cloneBson(seed.weeklySchedule);
  weekly._id = `cedar:${weekly._id}`;
  weekly.centerId = "cedar";
  weekly.source = "synthetic-public-source";
  for (const day of Object.values(weekly.days)) {
    for (const session of day.doctorSessions)
      session.doctorId = `cedar:${session.doctorId}`;
    for (const session of day.specialistSessions)
      session.specialistId = `cedar:${session.specialistId}`;
  }
  return {
    [COLLECTIONS.doctors]: entry(seed.doctors.map(legacyProfile)),
    [COLLECTIONS.specialists]: entry(
      seed.specialists.map((person, index) =>
        legacyProfile(person, index + 16),
      ),
    ),
    [COLLECTIONS.weekly]: entry(
      [weekly],
      [
        { name: "_id_", key: { _id: 1 } },
        {
          name: "old_weekly",
          key: { centerId: 1, ...READ_INDEXES[COLLECTIONS.weekly] },
        },
      ],
    ),
    [COLLECTIONS.changes]: entry(
      [],
      [
        { name: "_id_", key: { _id: 1 } },
        {
          name: "old_changes",
          key: { centerId: 1, ...READ_INDEXES[COLLECTIONS.changes] },
        },
      ],
    ),
    [COLLECTIONS.seeds]: entry([
      {
        _id: "cedar:approved-weekly-v1",
        completedAt: new Date("2026-09-30T17:04:00Z"),
      },
    ]),
    [LEGACY_ARCHIVE_COLLECTION]: entry(
      Array.from({ length: 12 }, (_, index) => ({
        _id: `synthetic:announcement:${index}`,
        text: "Synthetic announcement",
      })),
    ),
  };
}

function cleaned(plan) {
  const snapshot = Object.fromEntries(
    Object.entries(plan.collections).map(([name, documents]) => [
      name,
      entry(documents, [
        { name: "_id_", key: { _id: 1 } },
        ...(READ_INDEXES[name]
          ? [{ name: "new_read_index", key: READ_INDEXES[name] }]
          : []),
      ]),
    ]),
  );
  snapshot[LEGACY_ARCHIVE_COLLECTION] = entry([], [], false);
  return snapshot;
}

test("ID remapping preserves all seven days, session IDs, statuses, flags, timestamps and current wording", () => {
  const snapshot = fixture();
  snapshot[COLLECTIONS.specialists].documents[1].specialty = "Therapist";
  snapshot[COLLECTIONS.specialists].documents[2].name =
    "Synthetic Mkahhel spelling";
  const before = BSON.EJSON.stringify(snapshot);
  const plan = buildSchemaCleanupPlan(snapshot);
  assert.equal(plan.operations.length, 21);
  assert.equal(plan.collections[COLLECTIONS.doctors].length, 16);
  assert.equal(plan.collections[COLLECTIONS.specialists].length, 3);
  assert.deepEqual(plan.summary.profileGenders, {
    male: 11,
    female: 8,
    neutral: 0,
  });
  assert.equal(
    plan.collections[COLLECTIONS.specialists][1].specialty,
    "Therapist",
  );
  assert.equal(
    plan.collections[COLLECTIONS.specialists][2].name,
    "Synthetic Mkahhel spelling",
  );
  const weekly = plan.collections[COLLECTIONS.weekly][0];
  assert.equal(weekly.effectiveFrom, null);
  assert.equal(
    weekly.publishedAt,
    snapshot[COLLECTIONS.weekly].documents[0].publishedAt,
  );
  assert.deepEqual(Object.keys(weekly.days), [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
  ]);
  assert.equal(weekly.days[1].doctorSessions[2].id, "1:hasan-rahal");
  assert.equal(weekly.days[1].doctorSessions[2].doctorId, "doctor:hasan-rahal");
  assert.equal(Object.hasOwn(weekly, "centerId"), false);
  assert.equal(Object.hasOwn(weekly, "source"), false);
  assert.ok(plan.collections[COLLECTIONS.seeds][0].completedAt instanceof Date);
  assert.equal(BSON.EJSON.stringify(snapshot), before);
});

test("migration reruns are no-ops and preserve later edits, removed profiles and gender changes", () => {
  const snapshot = cleaned(buildSchemaCleanupPlan(fixture()));
  const profile = snapshot[COLLECTIONS.doctors].documents[2];
  profile.name = "Synthetic later name";
  profile.specialty = "Synthetic later specialty";
  profile.gender = "female";
  snapshot[COLLECTIONS.weekly].documents[0].days[0].closed = true;
  const plan = buildSchemaCleanupPlan(snapshot);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.indexes, []);
  assert.equal(plan.archiveLegacy, false);
  assert.equal(plan.collections[COLLECTIONS.doctors][2].gender, "female");
  // A genuinely absent unreferenced profile is not restored from initialization.
  snapshot[COLLECTIONS.specialists].documents.pop();
  for (const day of Object.values(
    snapshot[COLLECTIONS.weekly].documents[0].days,
  ))
    day.specialistSessions = day.specialistSessions.filter(
      ({ specialistId }) => specialistId !== "specialist:zeinab-makahhel",
    );
  assert.equal(
    buildSchemaCleanupPlan(snapshot).collections[COLLECTIONS.specialists]
      .length,
    2,
  );
});

test("destination collisions, unconfirmed identities, foreign scope and broken references stop planning", () => {
  const collision = fixture();
  collision[COLLECTIONS.doctors].documents.push({
    ...collision[COLLECTIONS.doctors].documents[0],
    _id: "doctor:hasan-ezzeddine",
  });
  assert.throws(() => buildSchemaCleanupPlan(collision), /collision/);
  const unknown = fixture();
  unknown[COLLECTIONS.doctors].documents.push({
    _id: "cedar:doctor:unknown",
    name: "Synthetic Unknown",
    specialty: "Synthetic",
    active: true,
  });
  assert.throws(() => buildSchemaCleanupPlan(unknown), /Unconfirmed/);
  const foreign = fixture();
  foreign[COLLECTIONS.doctors].documents[0].centerId = "synthetic-other-center";
  assert.throws(() => buildSchemaCleanupPlan(foreign), /Unexpected center/);
  const broken = fixture();
  broken[COLLECTIONS.doctors].documents.pop();
  assert.throws(() => buildSchemaCleanupPlan(broken), /Broken/);
  assert.throws(() => neutralId(new BSON.ObjectId()), /non-string/);
});

test("date exceptions preserve replacement contents and resolve against the renamed weekly ID", async () => {
  const snapshot = fixture();
  const day = cloneBson(snapshot[COLLECTIONS.weekly].documents[0].days[3]);
  day.doctorSessions[0].status = "cancelled";
  day.doctorSessions[1].startTime = "10:30";
  snapshot[COLLECTIONS.changes].documents.push({
    _id: "cedar:change:synthetic-date",
    centerId: "cedar",
    weeklyScheduleId: "cedar:weekly:approved-v1",
    date: "2026-09-30",
    publicationStatus: "published",
    publishedAt: new Date("2026-09-29T12:00:00Z"),
    day,
  });
  const plan = buildSchemaCleanupPlan(snapshot);
  const change = plan.collections[COLLECTIONS.changes][0];
  assert.equal(change._id, "change:synthetic-date");
  assert.equal(change.weeklyScheduleId, "weekly:approved-v1");
  assert.equal(change.day.doctorSessions[0].status, "cancelled");
  assert.equal(change.day.doctorSessions[1].startTime, "10:30");
  assert.ok(change.publishedAt instanceof Date);
  const database = {
    collection(name) {
      return {
        async findOne(query) {
          return (
            plan.collections[name].find((document) =>
              name === COLLECTIONS.weekly
                ? document.publicationStatus === query.publicationStatus
                : document.weeklyScheduleId === query.weeklyScheduleId &&
                  document.date === query.date,
            ) ?? null
          );
        },
        find(query) {
          return {
            async toArray() {
              return plan.collections[name].filter(
                (document) =>
                  query._id.$in.includes(document._id) && document.active,
              );
            },
          };
        },
      };
    },
  };
  const schedule = await getScheduleForDate("2026-09-30", database);
  assert.equal(
    schedule.doctorSessions.filter(({ status }) => status === "cancelled")
      .length,
    1,
  );
  assert.ok(
    schedule.doctorSessions.some(({ startTime }) => startTime === "10:30"),
  );
});

test("raw concatenated BSON backup preserves Date, Long, Decimal128, Binary and ObjectId types", async () => {
  const snapshot = fixture();
  const typed = {
    _id: "synthetic:typed",
    date: new Date("2026-10-01T00:00:00Z"),
    number: BSON.Long.fromString("9223372036854775800"),
    decimal: BSON.Decimal128.fromString("12.50"),
    bytes: new BSON.Binary(Buffer.from([1, 2, 3])),
    objectId: new BSON.ObjectId(),
  };
  snapshot[LEGACY_ARCHIVE_COLLECTION] = entry([typed]);
  const backup = await writeBackup("synthetic-backup-test", snapshot);
  const bytes = await readFile(
    join(
      backup.directory,
      "synthetic-backup-test",
      `${LEGACY_ARCHIVE_COLLECTION}.bson`,
    ),
  );
  assert.deepEqual(bytes, BSON.serialize(typed));
  const [restored] = unpackBson(bytes);
  assert.ok(restored.date instanceof Date);
  assert.ok(restored.number instanceof BSON.Long);
  assert.ok(restored.decimal instanceof BSON.Decimal128);
  assert.ok(restored.bytes instanceof BSON.Binary);
  assert.ok(restored.objectId instanceof BSON.ObjectId);
  assert.ok(sameBson(typed, restored));
  assert.deepEqual(
    BACKUP_COLLECTIONS,
    Object.keys(backup.manifest.collections),
  );
  assert.throws(() => unpackBson(Buffer.from([0, 1])), /Truncated/);
});

test("target guard and post-backup concurrent-change guard prevent unsafe writes", () => {
  assert.doesNotThrow(() =>
    assertDevelopmentTarget(
      "medical-center-dev",
      "medical-center-dev",
      "medical-center-dev",
    ),
  );
  assert.throws(
    () => assertDevelopmentTarget("production", "production", "production"),
    /Target mismatch/,
  );
  assert.throws(
    () =>
      assertDevelopmentTarget(
        "medical-center-dev",
        "different",
        "medical-center-dev",
      ),
    /Target mismatch/,
  );
  const before = fixture();
  assert.doesNotThrow(() => assertSnapshotUnchanged(before, before));
  const changed = fixture();
  changed[COLLECTIONS.doctors].raw[0] = BSON.serialize({
    ...changed[COLLECTIONS.doctors].documents[0],
    specialty: "Synthetic concurrent edit",
  });
  assert.throws(
    () => assertSnapshotUnchanged(before, changed),
    /changed after backup/,
  );
  const changedIndex = fixture();
  changedIndex[COLLECTIONS.doctors].indexes.push({
    name: "concurrent_name",
    key: { name: 1 },
    unique: true,
  });
  assert.throws(
    () => assertSnapshotUnchanged(before, changedIndex),
    /changed after backup/,
  );
});

test("controlled record replacement requires a transaction and preserves counts/references", async () => {
  const snapshot = fixture();
  const plan = buildSchemaCleanupPlan(snapshot);
  const records = Object.fromEntries(
    Object.entries(snapshot).map(([name, data]) => [
      name,
      new Map(data.documents.map((record) => [record._id, cloneBson(record)])),
    ]),
  );
  const session = { inTransaction: () => true };
  const database = {
    collection(name) {
      return {
        async insertOne(document, options) {
          assert.equal(options.session, session);
          assert.equal(records[name].has(document._id), false);
          records[name].set(document._id, cloneBson(document));
        },
        async deleteOne({ _id }, options) {
          assert.equal(options.session, session);
          return { deletedCount: records[name].delete(_id) ? 1 : 0 };
        },
        async replaceOne({ _id }, document, options) {
          assert.equal(options.session, session);
          const found = records[name].has(_id);
          if (found) records[name].set(_id, cloneBson(document));
          return { matchedCount: found ? 1 : 0 };
        },
      };
    },
  };
  await assert.rejects(
    applyDocumentPlan(database, plan, null),
    /active transaction/,
  );
  await applyDocumentPlan(database, plan, session);
  for (const [name, documents] of Object.entries(plan.collections))
    assert.deepEqual([...records[name].values()], documents);
  assert.equal(records[COLLECTIONS.doctors].size, 16);
  assert.equal(records[LEGACY_ARCHIVE_COLLECTION].size, 12);
  assert.deepEqual(
    Object.values(CONFIRMED_GENDERS).filter((gender) => gender === "male")
      .length,
    11,
  );
});
