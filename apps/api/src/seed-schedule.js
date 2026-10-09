import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { MongoClient } from "mongodb";
import { config } from "./config.js";
import {
  buildScheduleSeed,
  SEED_ID,
  WEEKLY_SCHEDULE_ID,
} from "./schedule-seed-data.js";
import { COLLECTIONS, validateScheduleDay } from "./schedule-model.js";

export async function seedPublicSchedules(database) {
  const completed = await database
    .collection(COLLECTIONS.seeds)
    .findOne({ _id: SEED_ID });
  if (completed) {
    // Do not resurrect a profile or baseline removed by an admin after initialization.
    return { inserted: 0, status: "already_completed" };
  }

  const seed = buildScheduleSeed();
  // Initialization must not run alongside the pre-migration records. In particular,
  // the old completion marker protects later edits/removals until it is migrated.
  const oldMarker = await database.collection(COLLECTIONS.seeds).findOne({
    _id: `cedar:${SEED_ID}`,
  });
  const oldRecords = await Promise.all(
    [
      [COLLECTIONS.doctors, seed.doctors.map(({ _id }) => `cedar:${_id}`)],
      [
        COLLECTIONS.specialists,
        seed.specialists.map(({ _id }) => `cedar:${_id}`),
      ],
      [COLLECTIONS.weekly, [`cedar:${WEEKLY_SCHEDULE_ID}`]],
    ].map(([collection, ids]) =>
      database.collection(collection).findOne({ _id: { $in: ids } }),
    ),
  );
  if (oldMarker || oldRecords.some(Boolean)) {
    throw new Error(
      "Existing namespaced schedule data must be migrated before initialization.",
    );
  }
  for (const day of Object.values(seed.weeklySchedule.days))
    validateScheduleDay(day);
  await database
    .collection(COLLECTIONS.weekly)
    .createIndex({ publicationStatus: 1, effectiveFrom: -1, publishedAt: -1 });
  await database.collection(COLLECTIONS.changes).createIndex({
    weeklyScheduleId: 1,
    date: 1,
    publicationStatus: 1,
    publishedAt: -1,
  });

  let inserted = 0;
  async function insertMissing(collectionName, documents) {
    for (const document of documents) {
      const result = await database
        .collection(collectionName)
        .updateOne(
          { _id: document._id },
          { $setOnInsert: document },
          { upsert: true },
        );
      inserted += result.upsertedCount;
    }
  }
  await insertMissing(COLLECTIONS.doctors, seed.doctors);
  await insertMissing(COLLECTIONS.specialists, seed.specialists);
  // Publish the complete baseline only after its referenced profiles exist.
  await insertMissing(COLLECTIONS.weekly, [seed.weeklySchedule]);
  await database
    .collection(COLLECTIONS.seeds)
    .updateOne(
      { _id: SEED_ID },
      { $setOnInsert: { _id: SEED_ID, completedAt: new Date().toISOString() } },
      { upsert: true },
    );
  return { inserted, status: "completed" };
}

async function main() {
  if (!config.mongoUri)
    throw new Error("Set MONGODB_URI before seeding schedules.");
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 3000,
  });
  try {
    await client.connect();
    const result = await seedPublicSchedules(client.db(config.mongoDbName));
    console.log(
      `Weekly schedule seed: ${result.inserted} inserted; ${result.status}.`,
    );
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`Weekly schedule seed failed: ${error.message}`);
    process.exitCode = 1;
  });
}
