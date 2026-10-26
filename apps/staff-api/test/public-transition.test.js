import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { BSON } from "mongodb";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  applyPublicBaseline,
  planPublicBaseline,
  undoPublicBaseline,
  setPublicationPause,
} from "../src/public-baseline-import.js";
import { syntheticBaselineSnapshot } from "./helpers/public-baseline.js";
import { signInSynthetic } from "./helpers/publication-authority.js";
import {
  createPublicationReceiver,
  initializePublicationStream,
} from "../../api/src/publication-receiver.js";
import {
  createPublicAuthority,
  legacyFingerprint,
  guardLegacyWrites,
} from "../../api/src/public-authority.js";
import { seedPublicSchedules } from "../../api/src/seed-schedule.js";

let f;
before(async () => {
  f = await createSecurityFixture({ publicationDeliveryConfigured: true });
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
async function imported() {
  const snapshot = syntheticBaselineSnapshot(),
    plan = planPublicBaseline(snapshot);
  const apply = (extra) =>
    applyPublicBaseline({
      db: f.db,
      client: f.client,
      snapshot,
      expectedDigest: plan.digest,
      demoMode: true,
      ...extra,
    });
  return { snapshot, plan, apply };
}
test("real Mongo import is atomic, repeat-safe, race-safe and never grants employee scopes", async () => {
  const { plan, apply } = await imported();
  await assert.rejects(
    apply({
      failBeforeCommit: () => {
        throw new Error("Synthetic rollback");
      },
    }),
  );
  assert.equal(await f.db.collection("operational_scopes").countDocuments(), 0);
  const results = await Promise.all([apply(), apply()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [
    "already_imported",
    "imported",
  ]);
  assert.equal(await f.db.collection("operational_grants").countDocuments(), 0);
  const profile = plan.collections.doctor_profile_drafts[0];
  await f.db
    .collection("doctor_profile_drafts")
    .updateOne(
      { _id: profile.id },
      { $set: { name: "Synthetic later edit", revision: 2 } },
    );
  assert.equal((await apply()).status, "already_imported");
  assert.equal(
    (
      await f.db
        .collection("doctor_profile_drafts")
        .findOne({ _id: profile.id })
    ).name,
    "Synthetic later edit",
  );
});
test("real Mongo import refuses collisions without partial records", async () => {
  const { apply } = await imported();
  await f.db
    .collection("operational_scopes")
    .insertOne({ _id: "clinic:existing", name: "Synthetic existing work" });
  await assert.rejects(apply(), /existing operational work/);
  assert.equal(
    await f.db.collection("operational_imports").countDocuments(),
    0,
  );
  assert.equal(
    await f.db.collection("doctor_profile_drafts").countDocuments(),
    0,
  );
});

test("old formula-era plans and marker-only tampering reject before writes; historical completion is retained", async () => {
  const { plan, apply } = await imported();
  const { digest, ...body } = plan;
  const old = { ...body, version: 1, capacityRule: "session-duration-v1" };
  old.collections = structuredClone(body.collections);
  for (const session of old.collections.operational_session_drafts)
    if (session.professionalId) session.capacity = 2;
  const oldDigest = createHash("sha256")
    .update(BSON.serialize(old))
    .digest("hex");
  const before = await f.db
    .collection("staff_management_state")
    .findOne({ _id: "staff-controls" });
  await assert.rejects(apply({ expectedDigest: oldDigest }), /Regenerate/);
  // Changing only a rule/version marker cannot make a formula-derived digest current.
  const tampered = { ...old, version: 2, capacityRule: "manual-nullable-v1" };
  await assert.rejects(
    apply({
      expectedDigest: createHash("sha256")
        .update(BSON.serialize(tampered))
        .digest("hex"),
    }),
    /Regenerate/,
  );
  assert.deepEqual(
    await f.db
      .collection("staff_management_state")
      .findOne({ _id: "staff-controls" }),
    before,
  );
  assert.equal(await f.db.collection("operational_scopes").countDocuments(), 0);
  const historical = {
    _id: "public-baseline-v1",
    digest: oldDigest,
    capacityRule: "session-duration-v1",
    completedAt: new Date("2026-10-01T00:00:00Z"),
  };
  await f.db.collection("operational_imports").insertOne(historical);
  await assert.rejects(apply(), /formula-era/);
  assert.deepEqual(
    await f.db
      .collection("operational_imports")
      .findOne({ _id: historical._id }),
    historical,
  );
  assert.equal(await f.db.collection("operational_scopes").countDocuments(), 0);
});
async function acceptedBaseline() {
  const { snapshot, apply } = await imported();
  await apply();
  for (const [name, entry] of Object.entries(snapshot.collections))
    if (entry.raw.length)
      await f.db
        .collection(name)
        .insertMany(entry.raw.map((raw) => BSON.deserialize(raw)));
  const admin = await signInSynthetic(f);
  const state = (await f.request("/operations", { token: admin.token })).body;
  const publish = await f.request("/operations/publish", {
    method: "POST",
    token: admin.token,
    body: {
      scopeIds: state.scopes.map((s) => s.id),
      expectedRevision: state.revision,
      expectedHead: 0,
      effectiveFrom: null,
      confirmed: true,
    },
  });
  assert.equal(publish.status, 200, JSON.stringify(publish.body));
  const job = await f.db
    .collection("public_publication_outbox")
    .findOne({ sequence: 1 });
  const receiver = await createPublicationReceiver({
    db: f.db,
    client: f.client,
    streamId: job.streamId,
    token: randomBytes(32).toString("base64url"),
    demoMode: true,
  });
  await receiver.accept(job.payload);
  const authority = createPublicAuthority({
    db: f.db,
    client: f.client,
    streamId: job.streamId,
  });
  const input = {
    mode: "cedar",
    expectedRevision: 0,
    expectedSequence: 1,
    expectedDigest: job.digest,
    expectedLegacyFingerprint: await legacyFingerprint(f.db),
    confirmed: true,
  };
  return { authority, input, receiver, job, admin };
}
test("baseline acceptance stays staged, explicit activation compares seven days and guards legacy writers", async () => {
  const { authority, input, receiver } = await acceptedBaseline();
  assert.equal(await authority.mode(), "legacy");
  const result = await authority.switch(input);
  assert.equal(result.mode, "cedar");
  assert.equal(result.comparison.datesCompared, 7);
  assert.equal(
    (await receiver.schedule("1990-01-01")).publicationStatus,
    "published",
  );
  await assert.rejects(seedPublicSchedules(f.db), /Legacy schedule writers/);
  const session = f.client.startSession();
  try {
    await assert.rejects(
      session.withTransaction(() => guardLegacyWrites(f.db, session)),
      /Legacy schedule writers/,
    );
  } finally {
    await session.endSession();
  }
  await authority.switch({ ...input, mode: "legacy", expectedRevision: 1 });
  assert.equal(await authority.mode(), "legacy");
});
test("activation refuses changed source or stale accepted expectations atomically", async () => {
  const { authority, input } = await acceptedBaseline();
  await assert.rejects(
    authority.switch({ ...input, expectedDigest: "0".repeat(64) }),
  );
  await f.db
    .collection("doctor_profiles")
    .updateOne(
      { _id: "doctor:synthetic-import" },
      { $set: { name: "Synthetic concurrent edit" } },
    );
  await assert.rejects(authority.switch(input));
  assert.equal(await authority.mode(), "legacy");
  assert.equal(
    await f.db.collection("public_data_authority").countDocuments(),
    0,
  );
});
test("unchanged import undo removes only owned drafts; rerun cannot resurrect it", async () => {
  const { snapshot, plan, apply } = await imported();
  await apply();
  const undo = () =>
    undoPublicBaseline({
      db: f.db,
      client: f.client,
      snapshot,
      expectedDigest: plan.digest,
      demoMode: true,
    });
  assert.equal((await undo()).status, "rolled_back");
  assert.equal((await undo()).status, "already_rolled_back");
  assert.equal((await apply()).status, "already_rolled_back");
  assert.equal(
    await f.db.collection("operational_session_drafts").countDocuments(),
    0,
  );
  assert.equal(await f.db.collection("accounts").countDocuments(), 0);
});
test("import undo refuses later draft edits without deleting any records", async () => {
  const { snapshot, plan, apply } = await imported();
  await apply();
  await f.db
    .collection("doctor_profile_drafts")
    .updateOne(
      { _id: "doctor:synthetic-import" },
      { $set: { name: "Synthetic later edit" } },
    );
  await assert.rejects(
    undoPublicBaseline({
      db: f.db,
      client: f.client,
      snapshot,
      expectedDigest: plan.digest,
      demoMode: true,
    }),
    /changed/,
  );
  assert.equal(await f.db.collection("operational_scopes").countDocuments(), 2);
});
test("activation and competing supported legacy writes serialize to one safe winner", async () => {
  const { authority, input } = await acceptedBaseline();
  const session = f.client.startSession();
  try {
    const writer = session.withTransaction(async () => {
      await guardLegacyWrites(f.db, session);
      await f.db
        .collection("doctor_profiles")
        .updateOne(
          { _id: "doctor:synthetic-import" },
          { $set: { name: "Synthetic racing writer" } },
          { session },
        );
    });
    const result = await Promise.allSettled([writer, authority.switch(input)]);
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    const mode = await authority.mode();
    const profile = await f.db
      .collection("doctor_profiles")
      .findOne({ _id: "doctor:synthetic-import" });
    assert.equal(
      profile.name,
      mode === "cedar" ? "Dr. Synthetic Import" : "Synthetic racing writer",
    );
  } finally {
    await session.endSession();
  }
});
test("newer/future acceptance forbids stale legacy rollback; pause rejects publication but not draft reads", async () => {
  const { authority, input, receiver, job, admin } = await acceptedBaseline();
  await authority.switch(input);
  const next = structuredClone(job.payload);
  next.sequence = 2;
  next.events.push({
    ...structuredClone(next.events[0]),
    id: "publication:2",
    sequence: 2,
    effectiveFrom: "2099-01-01",
  });
  await receiver.accept(next);
  await assert.rejects(
    authority.switch({ ...input, mode: "legacy", expectedRevision: 1 }),
  );
  assert.equal(await authority.mode(), "cedar");
  await setPublicationPause({
    db: f.db,
    client: f.client,
    expectedHead: 1,
    paused: true,
  });
  const state = (await f.request("/operations", { token: admin.token })).body;
  assert.equal(state.head, 1);
  const result = await f.request("/operations/publish", {
    method: "POST",
    token: admin.token,
    body: {
      scopeIds: state.scopes.map((s) => s.id),
      expectedRevision: state.revision,
      expectedHead: state.head,
      effectiveFrom: "2026-10-25",
      confirmed: true,
    },
  });
  assert.equal(result.body.error.code, "publication_paused");
  assert.equal(
    await f.db.collection("operational_publications").countDocuments(),
    1,
  );
});

test("baseline comparison rejects Cedar-only dated changes, not just dates present in legacy storage", async () => {
  const { authority, input, job } = await acceptedBaseline();
  const payload = structuredClone(job.payload);
  payload.events[0].hours.push({ id: "2026-10-26", closed: true });
  const { payloadDigest } =
    await import("../../../shared/publication-contract.mjs");
  const changedDigest = payloadDigest(payload);
  await f.db
    .collection("public_accepted_publications")
    .updateOne(
      { _id: `${job.streamId}:1` },
      { $set: { payload, digest: changedDigest } },
    );
  await f.db
    .collection("public_publication_state")
    .updateOne({ _id: job.streamId }, { $set: { digest: changedDigest } });
  await assert.rejects(
    authority.switch({ ...input, expectedDigest: changedDigest }),
  );
  assert.equal(await authority.mode(), "legacy");
});
test("strict receiver initialization preserves one stream and rejects conflicting concurrent streams", async () => {
  const start = (streamId) =>
    initializePublicationStream({
      db: f.db,
      client: f.client,
      streamId,
      strict: true,
    });
  const results = await Promise.allSettled([
    start("stream:synthetic-one"),
    start("stream:synthetic-two"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const state = await f.db.collection("public_publication_state").findOne({});
  assert.equal(
    await f.db.collection("public_publication_state").countDocuments(),
    1,
  );
  await start(state._id);
  assert.equal(
    (await f.db.collection("public_publication_state").findOne({})).sequence,
    0,
  );
  await assert.rejects(
    start("stream:synthetic-third"),
    /authority|conflicting/,
  );
});
