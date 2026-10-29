import assert from "node:assert/strict";
import test from "node:test";
import { provisionHostedReview } from "../scripts/provision-hosted-review.js";

const config = {
  mode: "hosted-review",
  apiOrigin: "https://cedar-provision-test.onrender.com",
  publicBase: "https://cedar-provision-test.vercel.app",
  publicDatabase: "capstone_public_review",
  publicSrvHost: "synthetic.mongodb.net",
  streamId: "stream:00000000-0000-0000-0000-000000000001",
};
function fixture() {
  let data = new Map();
  let failInsert;
  let indexes = 0;
  const matches = (row, query) =>
    Object.entries(query).every(([key, value]) => {
      const actual = key.split(".").reduce((v, k) => v?.[k], row);
      return value && typeof value === "object" && "$ne" in value
        ? actual !== value.$ne
        : actual === value;
    });
  const db = {
    databaseName: "capstone_public_review",
    listCollections: () => ({
      toArray: async () => [...data.keys()].map((name) => ({ name })),
    }),
    collection(name) {
      return {
        async createIndex() {
          indexes++;
          if (!data.has(name)) data.set(name, []);
        },
        async findOne(query) {
          return structuredClone(
            (data.get(name) ?? []).find((row) => matches(row, query)) ?? null,
          );
        },
        async insertOne(row) {
          if (name === failInsert)
            throw new Error("synthetic transaction failure");
          if (!data.has(name)) data.set(name, []);
          if (data.get(name).some((r) => r._id === row._id))
            throw new Error("duplicate");
          data.get(name).push(structuredClone(row));
        },
      };
    },
  };
  const client = {
    options: { srvHost: config.publicSrvHost, tls: true },
    startSession: () => ({
      async withTransaction(action) {
        const before = structuredClone(data);
        try {
          return await action();
        } catch (error) {
          data = before;
          throw error;
        }
      },
      async endSession() {},
    }),
  };
  return {
    db,
    client,
    options: { db, client, config, confirmed: true },
    get data() {
      return data;
    },
    get indexes() {
      return indexes;
    },
    fail(name) {
      failInsert = name;
    },
  };
}

test("explicit initialization creates only empty review authority and repeats without writes", async () => {
  const f = fixture();
  assert.equal((await provisionHostedReview(f.options)).status, "created");
  assert.equal(f.data.get("public_publication_state")[0].sequence, 0);
  assert.equal(f.data.get("website_requests").length, 0);
  const before = structuredClone(f.data),
    indexes = f.indexes;
  assert.equal((await provisionHostedReview(f.options)).status, "existing");
  assert.deepEqual(f.data, before);
  assert.equal(f.indexes, indexes);
});

test("normal target, unsafe TLS and missing confirmation refuse before indexes", async () => {
  for (const variant of ["database", "tls", "confirmation"]) {
    const f = fixture();
    if (variant === "database") f.db.databaseName = "medical-center-dev";
    if (variant === "tls") f.client.options.tlsAllowInvalidCertificates = true;
    if (variant === "confirmation") f.options.confirmed = false;
    await assert.rejects(provisionHostedReview(f.options));
    assert.equal(f.indexes, 0);
  }
});

test("unmarked nonempty review data and unrelated collections refuse without changes", async () => {
  for (const name of ["website_requests", "staff_profiles"]) {
    const f = fixture();
    f.data.set(name, [{ _id: "synthetic-existing" }]);
    const before = structuredClone(f.data);
    await assert.rejects(provisionHostedReview(f.options), /reconciliation/);
    assert.deepEqual(f.data, before);
    assert.equal(f.indexes, 0);
  }
});

test("changed configuration cannot adopt or replace an initialized stream", async () => {
  const f = fixture();
  await provisionHostedReview(f.options);
  const before = structuredClone(f.data);
  await assert.rejects(
    provisionHostedReview({
      ...f.options,
      config: { ...config, publicBase: "https://other-review.vercel.app" },
    }),
    /reconciliation/,
  );
  assert.deepEqual(f.data, before);
});

test("transaction failure leaves no partial marker or authority; empty indexes can resume", async () => {
  const f = fixture();
  f.fail("public_publication_state");
  await assert.rejects(
    provisionHostedReview(f.options),
    /synthetic transaction failure/,
  );
  assert.equal(f.data.get("hosted_review_configuration").length, 0);
  assert.equal(f.data.get("public_data_authority").length, 0);
  f.fail(undefined);
  assert.equal((await provisionHostedReview(f.options)).status, "created");
});

test("repeat initialization preserves later intake and accepted-sequence metadata", async () => {
  const f = fixture();
  await provisionHostedReview(f.options);
  f.data.get("website_requests").push({ _id: "synthetic-later" });
  const before = structuredClone(f.data);
  assert.equal((await provisionHostedReview(f.options)).status, "existing");
  assert.deepEqual(f.data, before);
});
