import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { MongoClient } from "mongodb";
import { config } from "./config.js";
import { buildScheduleSeed, SEED_ID } from "./schedule-seed-data.js";
import { COLLECTIONS, validateScheduleDay } from "./schedule-model.js";
import { LEGACY_COLLECTION, LEGACY_SCHEDULE_IDS } from "./legacy-schedule-records.js";

export async function seedPublicSchedules(database) {
  const legacy = await database.collection(LEGACY_COLLECTION)
    .find({ _id: { $in: LEGACY_SCHEDULE_IDS } }, { projection: { _id: 1 } }).toArray();
  const completed = await database.collection(COLLECTIONS.seeds).findOne({ _id: SEED_ID });
  if (completed) {
    // Do not resurrect a profile or baseline removed by an admin after initialization.
    return { inserted: 0, status: "already_completed", legacyIds: legacy.map(({ _id }) => _id) };
  }

  const seed = buildScheduleSeed();
  for (const day of Object.values(seed.weeklySchedule.days)) validateScheduleDay(day);
  await database.collection(COLLECTIONS.weekly).createIndex(
    { centerId: 1, publicationStatus: 1, effectiveFrom: -1, publishedAt: -1 },
  );
  await database.collection(COLLECTIONS.changes).createIndex(
    { centerId: 1, weeklyScheduleId: 1, date: 1, publicationStatus: 1, publishedAt: -1 },
  );

  let inserted = 0;
  async function insertMissing(collectionName, documents) {
    for (const document of documents) {
      const result = await database.collection(collectionName).updateOne(
        { _id: document._id }, { $setOnInsert: document }, { upsert: true },
      );
      inserted += result.upsertedCount;
    }
  }
  await insertMissing(COLLECTIONS.doctors, seed.doctors);
  await insertMissing(COLLECTIONS.specialists, seed.specialists);
  // Publish the complete baseline only after its referenced profiles exist.
  await insertMissing(COLLECTIONS.weekly, [seed.weeklySchedule]);
  await database.collection(COLLECTIONS.seeds).updateOne(
    { _id: SEED_ID },
    { $setOnInsert: { _id: SEED_ID, completedAt: new Date().toISOString() } },
    { upsert: true },
  );
  return { inserted, status: "completed", legacyIds: legacy.map(({ _id }) => _id) };
}

async function main() {
  if (!config.mongoUri) throw new Error("Set MONGODB_URI before seeding schedules.");
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    const result = await seedPublicSchedules(client.db(config.mongoDbName));
    console.log(`Weekly schedule seed: ${result.inserted} inserted; ${result.status}.`);
    console.log(`Superseded records identified: ${result.legacyIds.length}; preserved and excluded from the live API.`);
  } finally {
    await client.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`Weekly schedule seed failed: ${error.message}`);
    process.exitCode = 1;
  });
}
