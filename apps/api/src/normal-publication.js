import {
  loadPublicationConfig,
  publicationEnvironment,
} from "../../staff-api/src/publication-config.js";
import { createPublicationReceiver } from "./publication-receiver.js";
import { createPublicAuthority } from "./public-authority.js";

export async function assertLegacyReaderMode(db) {
  const authority = await db
    .collection("public_data_authority")
    .findOne({ _id: "source" });
  if (authority && authority.mode !== "legacy")
    throw new Error(
      "Cedar source requires its explicit publication configuration. Legacy fallback is refused.",
    );
}

// Explicit startup selection enables a staged receiver, NOT a reader cutover.
// The persistent authority record decides reader mode on each request.
export async function normalPublicationReaders(
  db,
  { enabled = false, load = loadPublicationConfig } = {},
) {
  if (!enabled) return null;
  const config = await load();
  if (!config)
    throw new Error(
      "Configure private publication delivery before enabling the normal receiver.",
    );
  const receiver = await createPublicationReceiver({
    db,
    client: db.client,
    token: config.token,
    streamId: config.streamId,
    demoMode: true,
    environment: publicationEnvironment(config),
  });
  return {
    receiver,
    authority: createPublicAuthority({
      db,
      client: db.client,
      streamId: config.streamId,
    }),
  };
}

// Only the background connection lifecycle initializes receiver state. Requests
// may use a binding for the current handle, but never wait for initialization.
export function createPublicationLifecycle({
  getDatabase,
  initialize = (db) => normalPublicationReaders(db, { enabled: true }),
}) {
  let binding;
  let pending;
  let generation = 0;
  const unavailable = () => new Error("Publication connection is not ready.");

  function invalidate() {
    generation += 1;
    binding = undefined;
    pending = undefined;
  }

  function currentDatabase() {
    let db;
    try {
      db = getDatabase();
      if (!db) throw unavailable();
    } catch {
      invalidate();
      throw unavailable();
    }
    if ((binding && binding.db !== db) || (pending && pending.db !== db))
      invalidate();
    return db;
  }

  function ready() {
    const db = currentDatabase();
    if (!binding || binding.db !== db) throw unavailable();
    return binding.value;
  }

  function refresh() {
    let db;
    try {
      db = currentDatabase();
    } catch (error) {
      return Promise.reject(error);
    }
    if (binding?.db === db) return Promise.resolve(binding.value);
    if (pending?.db === db) return pending.promise;
    const attempt = { db, generation: ++generation };
    pending = attempt;
    attempt.promise = Promise.resolve()
      .then(() => {
        if (
          pending !== attempt ||
          generation !== attempt.generation ||
          currentDatabase() !== db
        )
          throw unavailable();
        return initialize(db);
      })
      .then((value) => {
        if (
          pending !== attempt ||
          generation !== attempt.generation ||
          currentDatabase() !== db
        )
          throw unavailable();
        binding = { db, value };
        return value;
      })
      .finally(() => {
        if (pending === attempt) pending = undefined;
      });
    return attempt.promise;
  }

  async function withReady(action) {
    const value = ready();
    const capturedGeneration = generation;
    const result = await action(value);
    if (generation !== capturedGeneration || ready() !== value)
      throw unavailable();
    return result;
  }

  return { refresh, ready, withReady, invalidate };
}
