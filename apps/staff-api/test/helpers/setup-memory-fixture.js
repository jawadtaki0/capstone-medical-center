import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createVault } from "../../src/local-security.js";
import {
  digest,
  syntheticPassword,
  syntheticProfile,
  TEST_DATABASE,
} from "./security-fixture.js";

// Offline service-contract fixture only. This cannot demonstrate real MongoDB
// write conflicts/indexes; the same cases default to the guarded Mongo fixture.
export function createSetupMemoryFixture() {
  let records = new Map();
  let tail = Promise.resolve();
  let milliseconds = Math.floor(Date.now() / 30000) * 30000;
  const vault = createVault(randomBytes(32).toString("base64"));
  const clock = () => new Date(milliseconds);
  const rows = (name) => {
    if (!records.has(name)) records.set(name, []);
    return records.get(name);
  };
  const valueAt = (record, path) =>
    path.split(".").reduce((value, key) => value?.[key], record);
  function matches(record, filter) {
    return Object.entries(filter).every(([key, expected]) => {
      const actual = valueAt(record, key);
      if (expected === null) return actual == null;
      if (expected instanceof Date)
        return actual instanceof Date && +actual === +expected;
      return isDeepStrictEqual(actual, expected);
    });
  }
  function changePath(record, path, value, remove = false) {
    const keys = path.split(".");
    let parent = record;
    for (const key of keys.slice(0, -1)) parent = parent[key] ??= {};
    if (remove) delete parent[keys.at(-1)];
    else parent[keys.at(-1)] = structuredClone(value);
  }
  const db = {
    databaseName: TEST_DATABASE,
    collection(name) {
      return {
        async findOne(filter) {
          return structuredClone(
            rows(name).find((record) => matches(record, filter)) ?? null,
          );
        },
        async countDocuments(filter) {
          return rows(name).filter((record) => matches(record, filter)).length;
        },
        async insertOne(record) {
          if (rows(name).some((item) => item._id === record._id))
            throw Object.assign(new Error("Synthetic duplicate"), {
              code: 11000,
            });
          rows(name).push(structuredClone(record));
          return { insertedId: record._id };
        },
        async updateOne(filter, change) {
          const record = rows(name).find((item) => matches(item, filter));
          if (!record) return { matchedCount: 0, modifiedCount: 0 };
          const before = structuredClone(record);
          for (const [path, value] of Object.entries(change.$set ?? {}))
            changePath(record, path, value);
          for (const [path, value] of Object.entries(change.$inc ?? {}))
            changePath(record, path, (valueAt(record, path) ?? 0) + value);
          for (const path of Object.keys(change.$unset ?? {}))
            changePath(record, path, null, true);
          return {
            matchedCount: 1,
            modifiedCount: isDeepStrictEqual(before, record) ? 0 : 1,
          };
        },
        async replaceOne(filter, replacement, options) {
          const index = rows(name).findIndex((record) =>
            matches(record, filter),
          );
          if (index >= 0) rows(name)[index] = structuredClone(replacement);
          else if (options.upsert)
            rows(name).push(structuredClone(replacement));
          return { modifiedCount: index >= 0 ? 1 : 0 };
        },
        async deleteOne(filter) {
          const index = rows(name).findIndex((record) =>
            matches(record, filter),
          );
          if (index >= 0) rows(name).splice(index, 1);
          return { deletedCount: index >= 0 ? 1 : 0 };
        },
      };
    },
  };
  const client = {
    options: {
      hosts: [{ host: "127.0.0.1", port: 27018 }],
      replicaSet: "capstoneStaffDev",
    },
    startSession() {
      return {
        async withTransaction(callback) {
          const previous = tail;
          let release;
          tail = new Promise((resolve) => {
            release = resolve;
          });
          await previous;
          const snapshot = structuredClone(records);
          try {
            return await callback();
          } catch (error) {
            records = snapshot;
            throw error;
          } finally {
            release();
          }
        },
        async endSession() {},
      };
    },
    async close() {},
  };
  return {
    db,
    client,
    vault,
    clock,
    advance(amount) {
      milliseconds += amount;
    },
    async reset() {
      records = new Map();
      milliseconds = Math.floor(Date.now() / 30000) * 30000;
      await db
        .collection("staff_management_state")
        .insertOne({ _id: "staff-controls", revision: 0 });
    },
    async issueSetup({ expiresIn = 30 * 60000 } = {}) {
      const code = randomBytes(32).toString("base64url");
      await db.collection("installation_state").insertOne({
        _id: "first-admin",
        status: "issued",
        codeHash: digest(code),
        issuedAt: clock(),
        expiresAt: new Date(milliseconds + expiresIn),
        attempts: 0,
      });
      return code;
    },
    async account({ roles = ["Clinic Receptionist"], status = "active" } = {}) {
      const id = `synthetic:${randomUUID()}`;
      const username = `synthetic.${randomBytes(6).toString("hex")}`;
      const password = syntheticPassword();
      await db.collection("accounts").insertOne({
        _id: id,
        username,
        roles,
        status,
        version: 1,
        passwordHash: "synthetic-not-for-login",
        mfa: null,
      });
      await db.collection("staff_profiles").insertOne({
        _id: `synthetic-profile:${randomUUID()}`,
        accountId: id,
        ...syntheticProfile(),
      });
      return { id, username, password };
    },
    async close() {
      vault.destroy();
    },
  };
}
