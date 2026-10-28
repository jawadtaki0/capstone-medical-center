import { MongoClient } from "mongodb";
import { loadConfig, validateTarget } from "./config.js";
import { STAFF_ROLE_POLICY } from "../../../shared/staff-roles.mjs";
import { ensureBookingIndexes } from "./bookings.js";
import { ensurePatientIndexes } from "./patients.js";

export async function assertRoleStoragePolicy(db) {
  const state = await db
    .collection("staff_management_state")
    .findOne({ _id: "staff-controls" });
  if (state?.rolePolicy === STAFF_ROLE_POLICY) return;
  if (await db.collection("accounts").findOne({}, { projection: { _id: 1 } }))
    throw new Error(
      "Staff role data requires the approved coordinated migration and matching API/package. Startup refused; no accounts were changed.",
    );
  if (state)
    throw new Error(
      "Unsupported or unmarked existing staff role policy. Startup refused; reconcile through the approved maintenance process.",
    );
}

export async function connectStaffDatabase({
  database = "capstone_staff_dev",
  demoMode = false,
  initializeIndexes = true,
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
    if (initializeIndexes) {
      await assertRoleStoragePolicy(db);
      await ensureIndexes(db);
    }
    return { client, db, config };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function ensureIndexes(db) {
  await ensurePatientIndexes(db);
  await ensureBookingIndexes(db);
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
    "password_change_counters",
    "staff_recovery_requests",
    "staff_recovery_counters",
  ]) {
    await db
      .collection(name)
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }
  await db.collection("staff_sessions").createIndex({ accountId: 1 });
  await db
    .collection("staff_recovery_requests")
    .createIndex({ accountId: 1, kind: 1 });
  await db.collection("staff_recovery_requests").createIndex({ dispatch: 1 });
  await db.collection("staff_recovery_cases").createIndex({ accountId: 1 });
  await db.collection("security_events").createIndex({ occurredAt: -1 });
  await db
    .collection("staff_password_history")
    .createIndex({ accountId: 1, credentialVersion: 1 }, { unique: true }); // Permanent history: deliberately no TTL, age filter or retention limit.
  // Add only the serialized management-control anchor, never accounts or
  // guessed authentication proof. Existing staff IDs/factors stay untouched.
  await db.collection("staff_management_state").updateOne(
    { _id: "staff-controls" },
    {
      $setOnInsert: {
        revision: 0,
        createdAt: new Date(),
        rolePolicy: STAFF_ROLE_POLICY,
      },
    },
    { upsert: true },
  );
}
