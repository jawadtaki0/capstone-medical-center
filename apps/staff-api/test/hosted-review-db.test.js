import assert from "node:assert/strict";
import test from "node:test";
import { createHostedReviewDatabase } from "./helpers/hosted-review-db.js";

function fixture(overrides = {}) {
  const calls = [];
  const connection = {
    config: {
      database: "capstone_staff_test",
      host: "127.0.0.1",
      port: 27018,
      replicaSet: "capstoneStaffDev",
    },
    client: { options: { hosts: [{ host: "127.0.0.1", port: 27018 }] } },
    db: {
      databaseName: "capstone_staff_test",
      collection(name) {
        calls.push(["collection", name]);
        return {
          name,
          marker: true,
          findOne(filter, options) {
            calls.push(["findOne", this.name, filter, options]);
            return { name: this.name };
          },
          aggregate(pipeline, options) {
            calls.push(["aggregate", this.name, pipeline, options]);
            return { toArray: async () => [] };
          },
          rename(name) {
            calls.push(["rename", name]);
          },
        };
      },
      command(value) {
        calls.push(["command", value]);
        return { ok: 1 };
      },
    },
    ...overrides,
  };
  return { connection, calls };
}

test("fixed review namespace prefixes every collection and preserves bound methods/session options", () => {
  const f = fixture();
  const db = createHostedReviewDatabase(f.connection);
  const session = {};
  const result = db
    .collection("accounts")
    .findOne({ id: "synthetic" }, { session });
  assert.equal(db.databaseName, "capstone_staff_test");
  assert.equal(result.name, "hosted_review_accounts");
  assert.equal(f.calls[0][1], "hosted_review_accounts");
  assert.equal(f.calls[1][3].session, session);
  assert.equal(f.connection.db.collection("accounts").name, "accounts");
});

test("normal DB, remote hosts and wrong topology refuse before touching collections", () => {
  const cases = [
    { db: { databaseName: "capstone_staff_dev" } },
    {
      config: {
        database: "capstone_staff_test",
        host: "remote",
        port: 27018,
        replicaSet: "capstoneStaffDev",
      },
    },
    { client: { options: { hosts: [{ host: "127.0.0.1", port: 27017 }] } } },
  ];
  for (const value of cases) {
    const f = fixture(value);
    assert.throws(() => createHostedReviewDatabase(f.connection), /isolated/);
    assert.deepEqual(f.calls, []);
  }
});

test("collection names cannot introduce namespaces, double prefixes or traversal", () => {
  const f = fixture();
  const db = createHostedReviewDatabase(f.connection);
  for (const name of [
    "",
    "accounts.other",
    "../accounts",
    "$cmd",
    "system_users",
    "hosted_review_accounts",
    null,
    {},
    "a".repeat(97),
  ])
    assert.throws(() => db.collection(name), /collection/);
  assert.deepEqual(f.calls, []);
});

test("only exact ping is admitted; DB cleanup, arbitrary commands and client access are unavailable", () => {
  const f = fixture();
  const db = createHostedReviewDatabase(f.connection);
  assert.deepEqual(db.command({ ping: 1 }), { ok: 1 });
  for (const command of [
    { dropDatabase: 1 },
    { ping: 1, drop: "accounts" },
    { aggregate: "accounts" },
    { ping: "1" },
    null,
  ])
    assert.throws(() => db.command(command), /ping/);
  assert.equal(db.dropDatabase, undefined);
  assert.equal(db.listCollections, undefined);
  assert.equal(db.client, undefined);
  assert.deepEqual(f.calls, [["command", { ping: 1 }]]);
});

test("same-collection aggregations work but cross-collection and output stages refuse", async () => {
  const f = fixture();
  const collection = createHostedReviewDatabase(f.connection).collection(
    "bookings",
  );
  const session = {};
  await collection
    .aggregate(
      [
        { $match: { status: "confirmed" } },
        { $group: { _id: "$datedSessionId", count: { $sum: 1 } } },
      ],
      { session },
    )
    .toArray();
  assert.equal(f.calls[1][3].session, session);
  for (const stage of [
    { $lookup: { from: "accounts" } },
    { $unionWith: "accounts" },
    { $out: "accounts" },
    { $merge: "accounts" },
    { $facet: { nested: [{ $graphLookup: { from: "accounts" } }] } },
  ])
    assert.throws(() => collection.aggregate([stage]), /cross-collection/);
  assert.throws(() => collection.rename("accounts"), /unsupported/);
  assert.equal(f.calls.length, 2);
});

test("target guard is rechecked before later collection or ping operations", () => {
  const f = fixture();
  const db = createHostedReviewDatabase(f.connection);
  f.connection.config.host = "not-loopback";
  assert.throws(() => db.collection("accounts"), /isolated/);
  assert.throws(() => db.command({ ping: 1 }), /isolated/);
  assert.deepEqual(f.calls, []);
});
