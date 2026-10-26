import { before, after, beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  seedPublicationAuthority,
  signInSynthetic,
} from "./helpers/publication-authority.js";
import {
  createPublicationWorker,
  PUBLICATION_OUTBOX,
} from "../src/publication-delivery.js";
import {
  createPublicationReceiver,
  PUBLIC_COLLECTIONS,
} from "../../api/src/publication-receiver.js";
import { createApp } from "../../api/src/app.js";

let f, setup, server, receiver;
const token = randomBytes(32).toString("base64url");
before(async () => {
  f = await createSecurityFixture({ publicationDeliveryConfigured: true });
});
beforeEach(async () => {
  await f.reset();
  setup = await seedPublicationAuthority(f);
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});
async function startReceiver() {
  const streamId = (
    await f.db.collection("operational_state").findOne({ _id: "working" })
  ).streamId;
  receiver = await createPublicationReceiver({
    db: f.db,
    client: f.client,
    token,
    streamId,
    demoMode: true,
  });
  server = createApp({ publicationReceiver: receiver }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}/api/publications`;
}
const worker = (target, request) =>
  createPublicationWorker({
    db: f.db,
    client: f.client,
    token,
    target,
    request,
    demoMode: true,
    automatic: false,
    clock: f.clock,
  });
const jobs = () => f.db.collection(PUBLICATION_OUTBOX);
test("publication and delivery intent commit together; drafts never deliver; audit failure rolls back both", async () => {
  assert.equal(await jobs().countDocuments({}), 0);
  await f.restart({ failAudit: true });
  assert.equal((await setup.publish()).status, 503);
  assert.equal(await jobs().countDocuments({}), 0);
  assert.equal(
    await f.db.collection("operational_publications").countDocuments({}),
    0,
  );
  await f.restart({ failAudit: false });
  assert.equal((await setup.publish()).status, 200);
  const row = await jobs().findOne({});
  assert.equal(row.state, "pending");
  assert.equal(row.sequence, 1);
  assert.equal(JSON.stringify(row.payload).includes("capacity"), false);
});
test("receiver-down failure retains work; exact retry acknowledgement updates the public readers", async () => {
  setup.ok(await setup.publish());
  const target = await startReceiver();
  const offline = worker(target, async () => {
    throw new Error("Synthetic offline");
  });
  assert.equal((await offline.tick()).accepted, false);
  assert.equal((await jobs().findOne({})).state, "failed");
  const denied = await signInSynthetic(f, ["Clinic Admin"]);
  assert.equal(
    (await setup.post("retry", { deliveryId: "publication:1" }, denied.token))
      .status,
    403,
  );
  setup.ok(await setup.post("retry", { deliveryId: "publication:1" }));
  const online = worker(target);
  assert.equal((await online.tick()).accepted, true);
  assert.equal((await jobs().findOne({})).attempts, 2);
  assert.equal(
    (await receiver.professionals()).professionals[0].name,
    setup.profile.name,
  );
  assert.equal((await setup.state()).deliveries[0].state, "accepted");
});
test("receiver accepted but response lost: recreated sender retries one persisted identity without duplicates", async () => {
  setup.ok(await setup.publish());
  const target = await startReceiver();
  const lost = worker(target, async (...args) => {
    const result = await fetch(...args);
    await result.arrayBuffer();
    throw new Error("Synthetic lost acknowledgement");
  });
  assert.equal((await lost.tick()).accepted, false);
  assert.equal(
    await f.db.collection(PUBLIC_COLLECTIONS.versions).countDocuments({}),
    1,
  );
  f.advance(5000);
  const restarted = worker(target);
  assert.equal((await restarted.tick()).accepted, true);
  assert.equal(
    await f.db.collection(PUBLIC_COLLECTIONS.versions).countDocuments({}),
    1,
  );
  assert.equal((await jobs().findOne({})).attempts, 2);
});
test("invalid acknowledgements never claim success; concurrent workers deliver the latest complete timeline", async () => {
  setup.ok(await setup.publish());
  const target = await startReceiver();
  assert.equal(
    (await worker(target, async () => Response.json({ accepted: true })).tick())
      .reason,
    "invalid_acknowledgement",
  );
  await setup.save(
    "professionals",
    { ...setup.profile, name: "Dr. Synthetic Updated" },
    1,
  );
  setup.ok(await setup.publish());
  const workers = [worker(target), worker(target)];
  await Promise.all(workers.map((w) => w.tick()));
  assert.equal(
    (await receiver.professionals()).professionals[0].name,
    "Dr. Synthetic Updated",
  );
  assert.equal(
    (await jobs().findOne({ _id: "publication:2" })).state,
    "accepted",
  );
  assert.equal(
    (await jobs().findOne({ _id: "publication:1" })).acceptedSequence,
    2,
  );
});

test("retry enforces every current role/scope and mixed role without granting receptionists publication authority", async () => {
  setup.ok(await setup.publish());
  for (const [roles, allowed] of [
    [["Admin"], true],
    [["Clinic Admin"], true],
    [["Lab Admin"], false],
    [["Receptionist"], false],
    [["Clinic Admin", "Receptionist"], true],
    [["Lab Admin", "Receptionist"], false],
    [["Clinic Admin", "Lab Admin"], true],
  ]) {
    const actor = await signInSynthetic(f, roles);
    setup.ok(
      await setup.post("grants", {
        accountId: actor.id,
        scopeIds: ["clinic:synthetic"],
        expectedRevision: 0,
        confirmed: true,
      }),
    );
    const before = await jobs().findOne({});
    const response = await setup.post(
      "retry",
      { deliveryId: before._id },
      actor.token,
    );
    assert.equal(response.status, allowed ? 200 : 403, roles.join(","));
    const after = await jobs().findOne({});
    assert.equal(after.attempts, 0);
    assert.equal(after.digest, before.digest);
    if (!allowed) assert.deepEqual(after, before);
  }
});
test("retry rejects forged fields and expired verification; saved immutable work is independent of later drafts", async () => {
  setup.ok(await setup.publish());
  const before = await jobs().findOne({});
  assert.equal(
    (await setup.post("retry", { deliveryId: before._id, roles: ["Admin"] }))
      .status,
    400,
  );
  await setup.save(
    "professionals",
    { ...setup.profile, name: "Unpublished synthetic draft" },
    1,
  );
  assert.deepEqual((await jobs().findOne({})).payload, before.payload);
  f.advance(5 * 60000 + 1);
  assert.equal(
    (await setup.post("retry", { deliveryId: before._id })).body.error.code,
    "verification_required",
  );
  assert.deepEqual(await jobs().findOne({}), before);
});
test("acknowledged-current and covered-older status updates roll back together on an interrupted local write", async () => {
  setup.ok(await setup.publish());
  await setup.save(
    "professionals",
    { ...setup.profile, name: "Dr. Synthetic Next" },
    1,
  );
  setup.ok(await setup.publish());
  const target = await startReceiver();
  const faultDb = {
    databaseName: f.db.databaseName,
    collection(name) {
      const collection = f.db.collection(name);
      return name !== PUBLICATION_OUTBOX
        ? collection
        : new Proxy(collection, {
            get(object, key) {
              if (key === "updateMany")
                return async () => {
                  throw new Error(
                    "Synthetic interrupted acknowledgement transaction",
                  );
                };
              const value = Reflect.get(object, key);
              return typeof value === "function" ? value.bind(object) : value;
            },
          });
    },
  };
  const interrupted = createPublicationWorker({
    db: faultDb,
    client: f.client,
    token,
    target,
    demoMode: true,
    automatic: false,
    clock: f.clock,
  });
  assert.equal((await interrupted.tick()).accepted, false);
  assert.equal(
    (await jobs().findOne({ _id: "publication:1" })).state,
    "pending",
  );
  assert.equal(
    (await jobs().findOne({ _id: "publication:2" })).state,
    "failed",
  );
  assert.equal(
    (await receiver.professionals()).professionals[0].name,
    "Dr. Synthetic Next",
  );
  f.advance(5000);
  assert.equal((await worker(target).tick()).accepted, true);
  assert.equal(await jobs().countDocuments({ state: "accepted" }), 2);
});
