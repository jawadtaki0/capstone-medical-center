import { MongoClient } from "mongodb";
import { loadConfig, validateTarget } from "./config.js";

export async function connectStaffDatabase({
  database = "capstone_staff_dev",
  demoMode = false,
} = {}) {
  const config = await loadConfig({ database, demoMode });
  validateTarget(config);
  const client = new MongoClient(config.uri, {
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
    socketTimeoutMS: 10000,
  });
  try {
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    if (
      hello.setName !== config.replicaSet ||
      hello.hosts?.length !== 1 ||
      !hello.isWritablePrimary
    )
      throw new Error("Staff database topology is not ready.");
    const db = client.db(config.database);
    await ensureIndexes(db);
    return { client, db, config };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function ensureIndexes(db) {
  await db
    .collection("accounts")
    .createIndex({ username: 1 }, { unique: true });
  await db
    .collection("staff_profiles")
    .createIndex({ accountId: 1 }, { unique: true });
  for (const name of [
    "auth_challenges",
    "staff_sessions",
    "auth_throttles",
    "account_setup_codes",
    "contact_requests",
    "contact_counters",
  ]) {
    await db
      .collection(name)
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }
  await db.collection("staff_sessions").createIndex({ accountId: 1 });
  await db.collection("security_events").createIndex({ occurredAt: -1 });
  // Add only the serialized management-control anchor, never accounts or
  // guessed authentication proof. Existing staff IDs/factors stay untouched.
  await db.collection("staff_management_state").updateOne(
    { _id: "staff-controls" },
    {
      $setOnInsert: { revision: 0, createdAt: new Date() },
    },
    { upsert: true },
  );
}
