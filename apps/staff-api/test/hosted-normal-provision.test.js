import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectStaffDatabase } from "../src/db.js";
import { assertIsolatedTestTarget } from "./helpers/security-fixture.js";
import { provisionExistingNormalReceiver } from "../../api/scripts/provision-hosted-normal.js";
import {
  buildDelivery,
  payloadDigest,
} from "../../../shared/publication-contract.mjs";
import { publicationEvent } from "../../../shared/test-fixtures/publication.mjs";

async function fixture(run, { failMarker = false } = {}) {
  const c = await connectStaffDatabase({
    database: "capstone_staff_test",
    demoMode: true,
    initializeIndexes: false,
  });
  const prefix = `normal_host_test_${randomUUID().replaceAll("-", "")}_`;
  const names = [
    "hosted_normal_configuration",
    "public_data_authority",
    "public_publication_state",
    "public_accepted_publications",
    "website_requests",
    "website_request_state",
    "website_request_counters",
  ];
  const config = {
    mode: "normal-hosted",
    capstoneDemo: true,
    apiOrigin: "https://cedar-cmc-api.onrender.com",
    publicBase: "https://cedar-cmc.vercel.app",
    publicDatabase: "medical-center-dev",
    publicSrvHost: "synthetic.example.mongodb.net",
    streamId: `stream:${randomUUID()}`,
  };
  const db = {
    databaseName: c.db.databaseName,
    collection(name) {
      assert(names.includes(name));
      const col = c.db.collection(prefix + name);
      return new Proxy(col, {
        get(target, key) {
          if (
            failMarker &&
            name === "hosted_normal_configuration" &&
            key === "insertOne"
          )
            return async () => {
              throw Error("Synthetic marker failure");
            };
          const v = target[key];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
  try {
    assertIsolatedTestTarget(c);
    for (const name of names) await c.db.createCollection(prefix + name);
    const payload = buildDelivery(config.streamId, [publicationEvent()]),
      digest = payloadDigest(payload);
    await db.collection("public_data_authority").insertOne({
      _id: "source",
      mode: "cedar",
      streamId: config.streamId,
      revision: 0,
    });
    await db
      .collection("public_publication_state")
      .insertOne({ _id: config.streamId, sequence: 1, revision: 0 });
    await db
      .collection("public_accepted_publications")
      .insertOne({ _id: `${config.streamId}:1`, payload, digest });
    await run({
      db,
      client: c.client,
      config,
      confirmed: true,
      expected: { sequence: 1, revision: 0, authorityRevision: 0, digest },
    });
  } finally {
    assertIsolatedTestTarget(c);
    for (const name of names)
      await c.db
        .collection(prefix + name)
        .drop()
        .catch((e) => {
          if (e.code !== 26) throw e;
        });
    await c.client.close();
  }
}

test("real TEST concurrent normal provisioning has one marker and repeat preserves revisions", () =>
  fixture(async (o) => {
    const results = await Promise.all([
      provisionExistingNormalReceiver(o),
      provisionExistingNormalReceiver(o),
    ]);
    assert.deepEqual(results.map((x) => x.status).sort(), [
      "created",
      "existing",
    ]);
    assert.equal(
      await o.db.collection("hosted_normal_configuration").countDocuments(),
      1,
    );
    assert.equal(
      (
        await o.db
          .collection("public_publication_state")
          .findOne({ _id: o.config.streamId })
      ).revision,
      1,
    );
    assert.equal(
      (
        await o.db
          .collection("public_data_authority")
          .findOne({ _id: "source" })
      ).revision,
      1,
    );
    assert.equal((await provisionExistingNormalReceiver(o)).status, "existing");
    assert.equal(
      (
        await o.db
          .collection("public_data_authority")
          .findOne({ _id: "source" })
      ).revision,
      1,
    );
  }));
test("real TEST stale baseline refuses before marker or state changes", () =>
  fixture(async (o) => {
    await assert.rejects(
      provisionExistingNormalReceiver({
        ...o,
        expected: { ...o.expected, revision: 5 },
      }),
      /changed/,
    );
    assert.equal(
      await o.db.collection("hosted_normal_configuration").countDocuments(),
      0,
    );
    assert.equal(
      (
        await o.db
          .collection("public_publication_state")
          .findOne({ _id: o.config.streamId })
      ).revision,
      0,
    );
  }));
test("real TEST marker failure rolls back both serialization revisions", () =>
  fixture(
    async (o) => {
      await assert.rejects(
        provisionExistingNormalReceiver(o),
        /Synthetic marker failure/,
      );
      assert.equal(
        (
          await o.db
            .collection("public_publication_state")
            .findOne({ _id: o.config.streamId })
        ).revision,
        0,
      );
      assert.equal(
        (
          await o.db
            .collection("public_data_authority")
            .findOne({ _id: "source" })
        ).revision,
        0,
      );
      assert.equal(
        await o.db.collection("hosted_normal_configuration").countDocuments(),
        0,
      );
    },
    { failMarker: true },
  ));
