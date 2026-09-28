import { MongoClient } from "mongodb";
import { config } from "./config.js";

let client = null;
let database = null;
let state = config.mongoUri ? "disconnected" : "not-configured";

export async function connectDatabase() {
  if (!config.mongoUri) {
    return null;
  }

  state = "connecting";
  client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 3000 });

  try {
    await client.connect();
    database = client.db(config.mongoDbName);
    await database.command({ ping: 1 });
    state = "connected";
    return database;
  } catch (error) {
    state = "unavailable";
    await client.close().catch(() => undefined);
    client = null;
    database = null;
    throw error;
  }
}

export function getDatabaseStatus() {
  return state;
}

export function getDatabase() {
  if (!database) {
    throw new Error("MongoDB is not connected.");
  }

  return database;
}

export async function closeDatabase() {
  if (client) {
    await client.close();
  }

  client = null;
  database = null;
  state = config.mongoUri ? "disconnected" : "not-configured";
}

