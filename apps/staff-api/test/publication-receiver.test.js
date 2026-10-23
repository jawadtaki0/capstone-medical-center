import { before, after, beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import { createApp } from "../../api/src/app.js";
import {
  createPublicationReceiver,
  PUBLIC_COLLECTIONS,
} from "../../api/src/publication-receiver.js";
import { buildDelivery } from "../../../shared/publication-contract.mjs";
import { publicationEvent } from "../../../shared/test-fixtures/publication.mjs";

let f, receiver, server, origin;
const token = randomBytes(32).toString("base64url"),
  streamId = "stream:synthetic";
before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
  for (const name of Object.values(PUBLIC_COLLECTIONS))
    await f.db.collection(name).deleteMany({});
  receiver = await createPublicationReceiver({
    db: f.db,
    client: f.client,
    token,
    streamId,
    demoMode: true,
  });
  server = createApp({ publicationReceiver: receiver }).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});
after(async () => {
  if (f) {
    for (const name of Object.values(PUBLIC_COLLECTIONS))
      await f.db.collection(name).deleteMany({});
    await f.reset();
    await f.close();
  }
});
const send = (payload, secret = token) =>
  fetch(`${origin}/api/publications`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  });

test("receiver persists a whole authenticated timeline and existing public readers use it without staff service", async () => {
  assert.equal((await fetch(`${origin}/api/professionals`)).status, 503);
  const body = buildDelivery(streamId, [publicationEvent()]);
  assert.equal((await send(body, "incorrect")).status, 401);
  assert.equal((await send({ ...body, staffContacts: [] })).status, 400);
  assert.equal((await send(body)).status, 200);
  assert.equal(
    (await (await fetch(`${origin}/api/professionals`)).json()).professionals[0]
      .name,
    "Dr. Synthetic Review",
  );
  assert.equal(
    (await (await fetch(`${origin}/api/schedule?date=2026-10-19`)).json())
      .doctorSessions[0].id,
    "session:synthetic",
  );
  const restarted = await createPublicationReceiver({
    db: f.db,
    client: f.client,
    token,
    streamId,
    demoMode: true,
  });
  assert.equal((await restarted.professionals()).professionals.length, 1);
  assert.equal(
    (await restarted.schedule("2026-10-19")).doctorSessions.length,
    1,
  );
});
test("duplicates, stale arrivals, conflicts and concurrent versions cannot regress the accepted pointer", async () => {
  const first = publicationEvent(),
    old = buildDelivery(streamId, [first]);
  const next = publicationEvent(2);
  next.professionals[0].name = "Dr. Synthetic New";
  const newer = buildDelivery(streamId, [first, next]);
  assert.equal((await send(newer)).status, 200);
  assert.equal((await send(old)).status, 409);
  const duplicates = await Promise.all([send(newer), send(newer)]);
  assert.deepEqual(
    duplicates.map((r) => r.status),
    [200, 200],
  );
  const conflict = structuredClone(newer);
  conflict.events[1].professionals[0].name = "Conflict";
  assert.equal((await send(conflict)).status, 409);
  assert.equal(
    (await receiver.professionals()).professionals[0].name,
    "Dr. Synthetic New",
  );
  const changedPrefix = structuredClone(newer);
  changedPrefix.events[0].professionals[0].name = "Rewritten history";
  changedPrefix.events.push(
    buildDelivery(streamId, [
      publicationEvent(),
      publicationEvent(2),
      publicationEvent(3),
    ]).events[2],
  );
  changedPrefix.sequence = 3;
  assert.equal((await send(changedPrefix)).status, 409);
});
test("future acceptance preserves current data; oversized, partial and invalid requests leave the last version intact", async () => {
  const first = publicationEvent(),
    future = publicationEvent(2, "2099-01-01");
  future.professionals[0].name = "Future Synthetic";
  const payload = buildDelivery(streamId, [first, future]);
  assert.equal((await send(payload)).status, 200);
  assert.equal(
    (await receiver.professionals()).professionals[0].name,
    "Dr. Synthetic Review",
  );
  assert.equal(
    (await receiver.schedule("2099-01-05")).doctorSessions[0].doctorName,
    "Future Synthetic",
  );
  assert.equal(
    (await send({ ...payload, padding: "x".repeat(1024 * 1024) })).status,
    413,
  );
  assert.equal(
    (await receiver.professionals()).professionals[0].name,
    "Dr. Synthetic Review",
  );
});

test("accepted complete timeline preserves an independent future service when another clinic is corrected now", async () => {
  const first = publicationEvent(),
    future = publicationEvent(2, "2099-01-01"),
    correction = publicationEvent(3, "2026-02-01");
  future.scopeIds = ["service:audio"];
  future.scopes.push({
    id: "service:audio",
    name: "Synthetic Audiometry",
    kind: "service",
    active: true,
  });
  future.sessions.push({
    ...first.sessions[0],
    id: "audio:synthetic",
    scopeId: "service:audio",
    professionalId: null,
  });
  correction.professionals[0].name = "Dr. Synthetic Current Correction";
  assert.equal(
    (await send(buildDelivery(streamId, [first, future, correction]))).status,
    200,
  );
  assert.equal(
    (await receiver.professionals()).professionals[0].name,
    "Dr. Synthetic Current Correction",
  );
  assert.equal((await receiver.schedule("2026-10-19")).otherServices.length, 0);
  const later = await receiver.schedule("2099-01-05");
  assert.equal(later.otherServices[0].name, "Synthetic Audiometry");
  assert.equal(
    later.doctorSessions[0].doctorName,
    "Dr. Synthetic Current Correction",
  );
});
