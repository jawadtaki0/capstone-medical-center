import { before, after, beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import { seedPublicationAuthority } from "./helpers/publication-authority.js";
import { startPublicationProcess } from "./helpers/publication-process.js";
import { PUBLICATION_OUTBOX } from "../src/publication-delivery.js";

let f, setup, children;
const token = randomBytes(32).toString("base64url");
before(async () => {
  f = await createSecurityFixture({ publicationDeliveryConfigured: true });
});
beforeEach(async () => {
  await f.reset();
  setup = await seedPublicationAuthority(f);
  setup.ok(await setup.publish());
  children = [];
});
afterEach(async () => {
  for (const child of children) await child.stop();
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});
async function start(options) {
  const child = await startPublicationProcess(options);
  children.push(child);
  return child;
}
test("separate receiver/sender processes persist accepted data; staff authority can stop without affecting fresh public reads", async () => {
  const streamId = (
    await f.db.collection("operational_state").findOne({ _id: "working" })
  ).streamId;
  let receiver = await start({ mode: "receiver", streamId, token });
  const port = receiver.port;
  const sender = await start({
    mode: "sender",
    token,
    target: `${receiver.origin}/api/publications`,
  });
  assert.equal((await sender.control("tick")).accepted, true);
  await sender.stop();
  await receiver.stop();
  receiver = await start({ mode: "receiver", streamId, token, port });
  assert.equal(
    (await (await fetch(`${receiver.origin}/api/professionals`)).json())
      .professionals[0].name,
    setup.profile.name,
  );
  assert.equal(
    (
      await (
        await fetch(`${receiver.origin}/api/schedule?date=2026-10-19`)
      ).json()
    ).doctorSessions.length,
    1,
  );
  assert.equal(
    (await f.db.collection(PUBLICATION_OUTBOX).findOne({})).state,
    "accepted",
  );
});
test("owned sender crash after claiming leaves a reclaimable lease, not lost work or invented success", async () => {
  const streamId = (
    await f.db.collection("operational_state").findOne({ _id: "working" })
  ).streamId;
  const receiver = await start({ mode: "receiver", streamId, token });
  const target = `${receiver.origin}/api/publications`;
  const crashed = await start({
    mode: "sender",
    token,
    target,
    pauseAtSend: true,
  });
  const inFlight = crashed.control("tick").catch(() => null);
  await crashed.waitForClaim();
  await crashed.crash();
  await inFlight;
  const row = await f.db.collection(PUBLICATION_OUTBOX).findOne({});
  assert.equal(row.state, "sending");
  // Controlled TEST time, not sleep or modification of production security state.
  const resumed = await start({
    mode: "sender",
    token,
    target,
    clockAt: +row.leaseUntil + 1,
  });
  assert.equal((await resumed.control("tick")).accepted, true);
  assert.equal(
    (await f.db.collection(PUBLICATION_OUTBOX).findOne({})).attempts,
    2,
  );
});
