import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { BSON } from "mongodb";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import { syntheticBaselineSnapshot } from "./helpers/public-baseline.js";
import { planPublicBaseline } from "../src/public-baseline-import.js";
import { createDatabaseConnection } from "../../api/src/db.js";
import { createPublicationLifecycle } from "../../api/src/normal-publication.js";
import {
  createPublicationReceiver,
  initializePublicationStream,
} from "../../api/src/publication-receiver.js";
import {
  createPublicAuthority,
  legacyFingerprint,
} from "../../api/src/public-authority.js";
import {
  buildDelivery,
  payloadDigest,
} from "../../../shared/publication-contract.mjs";

let f;
before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});

test("real TEST Mongo: healthy lifecycle refreshes preserve revisions; recovery and stale activation remain guarded", async () => {
  const source = syntheticBaselineSnapshot(),
    plan = planPublicBaseline(source);
  for (const [name, entry] of Object.entries(source.collections))
    if (entry.raw.length)
      await f.db
        .collection(name)
        .insertMany(entry.raw.map((raw) => BSON.deserialize(raw)));
  const streamId = "stream:synthetic-lifecycle",
    token = randomBytes(32).toString("base64url");
  const event = {
    id: "publication:1",
    sequence: 1,
    effectiveFrom: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    scopeIds: plan.collections.operational_scopes.map((s) => s.id),
    publishesHours: true,
    scopes: plan.collections.operational_scopes,
    professionals: [
      ...plan.collections.doctor_profile_drafts,
      ...plan.collections.specialist_profile_drafts,
    ],
    sessions: plan.collections.operational_session_drafts,
    exceptions: plan.collections.operational_date_drafts,
    hours: plan.collections.operational_hours_drafts,
  };
  const payload = buildDelivery(streamId, [event]),
    digest = payloadDigest(payload);
  let down = false,
    loads = 0,
    configurationGeneration = 1;
  const versions = [];
  // The fixture owns this real TEST client. The wrapper simulates connection
  // loss without stopping Mongo or closing another test's database connection.
  const pool = {
    connect: async () => {
      if (down) throw Error("Synthetic owned outage");
    },
    db: (name) => f.client.db(name),
    close: async () => {},
  };
  const connection = createDatabaseConnection({
    uri: "synthetic-controlled-client",
    dbName: "capstone_staff_test",
    createClient: () => pool,
  });
  const lifecycle = createPublicationLifecycle({
    getDatabase: connection.get,
    initialize: async (db) => {
      loads++;
      versions.push(configurationGeneration);
      // Run the SAME strict initializer used by normal-local startup, but only
      // inside the guarded TEST database; never relabel TEST as normal-local.
      await initializePublicationStream({
        db,
        client: f.client,
        streamId,
        strict: true,
      });
      return {
        generation: configurationGeneration,
        receiver: await createPublicationReceiver({
          db,
          client: f.client,
          streamId,
          token,
          demoMode: true,
        }),
        authority: createPublicAuthority({ db, client: f.client, streamId }),
      };
    },
  });
  await connection.connect();
  await Promise.all([
    lifecycle.refresh(),
    lifecycle.refresh(),
    lifecycle.refresh(),
  ]);
  assert.equal(loads, 1);
  const original = connection.get(),
    initial = await f.db
      .collection("public_data_authority")
      .findOne({ _id: "source" });
  await lifecycle.ready().receiver.accept(payload);
  const acceptedBefore = await f.db
    .collection("public_accepted_publications")
    .findOne({});
  for (let i = 0; i < 3; i++) {
    await connection.health();
    await lifecycle.refresh();
    assert.equal(connection.get(), original);
  }
  assert.equal(loads, 1);
  assert.deepEqual(
    await f.db.collection("public_data_authority").findOne({ _id: "source" }),
    initial,
  );
  const fingerprint = await legacyFingerprint(f.db),
    authority = lifecycle.ready().authority;
  const frozen = await authority.freeze({
    expectedFingerprint: fingerprint,
    confirmed: true,
  });
  const input = {
    mode: "cedar",
    expectedRevision: frozen.revision,
    expectedSequence: 1,
    expectedDigest: digest,
    expectedLegacyFingerprint: fingerprint,
    confirmed: true,
  };
  const frozenBefore = await f.db
    .collection("public_data_authority")
    .findOne({ _id: "source" });
  await assert.rejects(
    authority.switch({ ...input, expectedRevision: initial.revision }),
    /conflict/,
  );
  assert.deepEqual(
    await f.db.collection("public_data_authority").findOne({ _id: "source" }),
    frozenBefore,
    "stale activation transaction must roll back its guard write",
  );
  await authority.switch(input);
  assert.equal(
    await lifecycle.withReady(({ authority }) => authority.mode()),
    "cedar",
  );
  down = true;
  assert.equal(await connection.health(), "unavailable");
  assert.throws(() => lifecycle.ready(), /not ready/);
  configurationGeneration = 2;
  down = false;
  await connection.connect();
  await lifecycle.refresh();
  assert.notEqual(connection.get(), original);
  assert.equal(loads, 2);
  assert.deepEqual(versions, [1, 2]);
  assert.equal(lifecycle.ready().generation, 2);
  assert.equal(
    await lifecycle.withReady(({ authority }) => authority.mode()),
    "cedar",
    "recovery must query current authority, never default back to legacy",
  );
  const recovered = await f.db
    .collection("public_data_authority")
    .findOne({ _id: "source" });
  await connection.health();
  await lifecycle.refresh();
  assert.deepEqual(
    await f.db.collection("public_data_authority").findOne({ _id: "source" }),
    recovered,
  );
  assert.deepEqual(
    await f.db.collection("public_accepted_publications").findOne({}),
    acceptedBefore,
  );
  assert.equal(
    await f.db.collection("public_accepted_publications").countDocuments(),
    1,
  );
  assert.equal(
    (
      await f.db
        .collection("public_publication_state")
        .findOne({ _id: streamId })
    ).digest,
    digest,
  );
  lifecycle.invalidate();
  await connection.close();
});
