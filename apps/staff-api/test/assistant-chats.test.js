import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import { signInSynthetic } from "./helpers/publication-authority.js";
import { ensureIndexes } from "../src/db.js";
import { createMatcher } from "../src/assistant/matcher.js";

let f, owner, other;
const post = (path, person, body = {}) =>
  f.request(`/assistant/${path}`, {
    method: "POST",
    token: person.token,
    body,
  });
const good = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const list = async (person) => good(await post("chats", person)).chats;
const ask = async (person, chatId, extra) =>
  good(await post("message", person, { chatId, ...extra }));

before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
  owner = await signInSynthetic(f, ["Receptionist"]);
  other = await signInSynthetic(f, ["Admin"]);
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});

test("a chat is saved for its owner and can be reopened", async () => {
  const chatId = randomUUID();
  await ask(owner, chatId, { topic: "patient_help" });
  await ask(owner, chatId, { topic: "account_help" });
  const chats = await list(owner);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, chatId);
  assert.equal(chats[0].title, "Find or register a patient");
  const chat = good(await post("chat", owner, { id: chatId }));
  assert.deepEqual(
    chat.turns.map((t) => t.question),
    ["Find or register a patient", "My account"],
  );
  assert.ok(chat.turns[0].reply.steps.length > 0);
});

test("the greeting alone saves nothing", async () => {
  good(await post("message", owner, { topic: "capabilities" }));
  assert.deepEqual(await list(owner), []);
});

test("nobody else can see, change or delete a chat", async () => {
  const chatId = randomUUID();
  const first = await ask(owner, chatId, { topic: "patient_help" });
  assert.deepEqual(await list(other), []);
  for (const [path, body] of [
    ["chat", { id: chatId }],
    ["delete", { id: chatId }],
    ["outcome", { id: chatId, turnId: first.turnId, outcome: "forged" }],
    ["message", { chatId, topic: "account_help" }],
  ]) {
    const result = await post(path, other, body);
    assert.equal(result.status, 404, path);
  }
  const chat = good(await post("chat", owner, { id: chatId }));
  assert.equal(chat.turns.length, 1);
  assert.equal(chat.turns[0].outcome, undefined);
});

test("a finished action is remembered instead of reopening its form", async () => {
  const chatId = randomUUID();
  const first = await ask(owner, chatId, { topic: "patient_help" });
  good(
    await post("outcome", owner, {
      id: chatId,
      turnId: first.turnId,
      outcome: "Booking confirmed: B-00000001",
    }),
  );
  const chat = good(await post("chat", owner, { id: chatId }));
  assert.equal(chat.turns[0].outcome, "Booking confirmed: B-00000001");
});

test("chats expire after 30 days and can be deleted sooner", async () => {
  await ensureIndexes(f.db);
  const indexes = await f.db.collection("assistant_chats").indexes();
  assert.ok(
    indexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0),
  );
  const chatId = randomUUID();
  await ask(owner, chatId, { topic: "patient_help" });
  const stored = await f.db
    .collection("assistant_chats")
    .findOne({ _id: chatId });
  assert.equal(stored.expiresAt - stored.createdAt, 30 * 86400000);
  await f.db
    .collection("assistant_chats")
    .updateOne({ _id: chatId }, { $set: { expiresAt: f.clock() } });
  assert.deepEqual(await list(owner), []);
  assert.equal((await post("chat", owner, { id: chatId })).status, 404);

  const second = randomUUID();
  await ask(owner, second, { topic: "patient_help" });
  const events = await f.db.collection("security_events").countDocuments();
  good(await post("delete", owner, { id: second }));
  assert.equal(
    await f.db.collection("assistant_chats").countDocuments({ _id: second }),
    0,
  );
  // Audit history is separate and stays.
  assert.ok(
    (await f.db.collection("security_events").countDocuments()) >= events,
  );
});

test("matching a question makes no network request", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("Network is blocked in this check.");
  };
  try {
    const ranked = await createMatcher().rank("how do I book an appointment");
    assert.equal(ranked[0].id, "book_help");
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(calls, []);
});
