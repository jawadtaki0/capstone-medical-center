import { MongoClient } from "mongodb";
import { config } from "./config.js";

export function createDatabaseConnection({
  uri,
  dbName,
  createClient = (connectionUri) =>
    new MongoClient(connectionUri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 5000,
    }),
}) {
  let client = null;
  let database = null;
  let state = uri ? "disconnected" : "not-configured";
  let inFlight = null;
  let generation = 0;

  function connect() {
    if (!uri) return Promise.resolve(null);
    if (inFlight) return inFlight;
    const attemptGeneration = generation;

    inFlight = Promise.resolve()
      .then(async () => {
        if (attemptGeneration !== generation) return null;
        let candidate;
        try {
          candidate = client ?? createClient(uri);
          client = candidate;
          if (!database) state = "connecting";
          await candidate.connect();
          if (attemptGeneration !== generation) return null;
          const nextDatabase = candidate.db(dbName);
          await nextDatabase.command({ ping: 1 }, { maxTimeMS: 3000 });
          if (attemptGeneration !== generation) return null;
          database = nextDatabase;
          state = "connected";
          return database;
        } catch (error) {
          if (attemptGeneration === generation) {
            state = "unavailable";
            database = null;
            client = null;
            await candidate?.close().catch(() => undefined);
          }
          throw error;
        }
      })
      .finally(() => {
        if (attemptGeneration === generation) inFlight = null;
      });
    return inFlight;
  }

  async function health() {
    // Report current reachability
    await connect().catch(() => undefined);
    return state;
  }

  async function close() {
    generation += 1;
    const closingClient = client;
    client = null;
    database = null;
    inFlight = null;
    state = uri ? "disconnected" : "not-configured";
    await closingClient?.close();
  }

  return {
    connect,
    health,
    close,
    status: () => state,
    get() {
      if (!database) throw new Error("MongoDB is not connected.");
      return database;
    },
  };
}

const connection = createDatabaseConnection({
  uri: config.mongoUri,
  dbName: config.mongoDbName,
});
export const connectDatabase = connection.connect;
export const checkDatabaseHealth = connection.health;
export const getDatabaseStatus = connection.status;
export const getDatabase = connection.get;
export const closeDatabase = connection.close;
