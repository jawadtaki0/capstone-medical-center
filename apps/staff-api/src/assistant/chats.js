import { randomUUID } from "node:crypto";
import { StaffError } from "../errors.js";
import { allowFields } from "../management-validation.js";

const KEEP_MS = 30 * 86400000;
const MAX_TURNS = 100;
const missing = () =>
  new StaffError("assistant_chat", "This chat is not available.", 404);
const invalid = () =>
  new StaffError("assistant_input", "Reload the assistant chat.", 400);
export const chatId = (value) => {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
  )
    throw invalid();
  return value;
};

export async function ensureAssistantIndexes(db) {
  const chats = db.collection("assistant_chats");
  await chats.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await chats.createIndex({ accountId: 1, updatedAt: -1 });
}

// Saved chats belong to one account. Every read and write filters by it, so
// another person, Admin included, gets the same "not available" answer.
export function createAssistantChats({ db, transaction, authenticated, now }) {
  const chats = () => db.collection("assistant_chats");
  async function owner(token) {
    const at = now();
    const context = await transaction((session) =>
      authenticated(session, token, at),
    );
    return { accountId: context.account._id, at };
  }
  const mine = (id, accountId, at) => ({
    _id: chatId(id),
    accountId,
    expiresAt: { $gt: at },
  });

  return {
    // Checked before answering, so a foreign chat ID is refused outright.
    async assertWritable(token, id) {
      const { accountId, at } = await owner(token);
      const found = await chats().findOne({ _id: chatId(id) });
      if (
        found &&
        (found.accountId !== accountId ||
          found.expiresAt <= at ||
          found.turns.length >= MAX_TURNS)
      )
        throw missing();
    },
    async append(token, id, question, reply) {
      const { accountId, at } = await owner(token);
      const turn = { id: randomUUID(), at, question, reply };
      await chats().updateOne(
        { _id: chatId(id), accountId },
        {
          $setOnInsert: {
            title: question.slice(0, 80),
            createdAt: at,
            expiresAt: new Date(at.getTime() + KEEP_MS),
          },
          $set: { updatedAt: at },
          $push: { turns: turn },
        },
        { upsert: true },
      );
      return turn.id;
    },
    async list(token, input) {
      allowFields(input ?? {}, []);
      const { accountId, at } = await owner(token);
      const found = await chats()
        .find(
          { accountId, expiresAt: { $gt: at } },
          { projection: { title: 1, updatedAt: 1 } },
        )
        .sort({ updatedAt: -1 })
        .limit(20)
        .toArray();
      return {
        chats: found.map((c) => ({
          id: c._id,
          title: c.title,
          updatedAt: c.updatedAt,
        })),
      };
    },
    async read(token, input) {
      allowFields(input, ["id"]);
      const { accountId, at } = await owner(token);
      const found = await chats().findOne(mine(input.id, accountId, at));
      if (!found) throw missing();
      return {
        id: found._id,
        turns: found.turns.map(({ id, question, reply, outcome }) => ({
          id,
          question,
          reply,
          ...(outcome ? { outcome } : {}),
        })),
      };
    },
    async remove(token, input) {
      allowFields(input, ["id"]);
      const { accountId, at } = await owner(token);
      const result = await chats().deleteOne(mine(input.id, accountId, at));
      if (!result.deletedCount) throw missing();
      return { deleted: true };
    },
    async outcome(token, input) {
      allowFields(input, ["id", "turnId", "outcome"]);
      if (
        typeof input.outcome !== "string" ||
        !input.outcome.trim() ||
        input.outcome.length > 500
      )
        throw invalid();
      const { accountId, at } = await owner(token);
      const result = await chats().updateOne(
        {
          ...mine(input.id, accountId, at),
          "turns.id": chatId(input.turnId),
        },
        { $set: { "turns.$.outcome": input.outcome.trim() } },
      );
      if (!result.matchedCount) throw missing();
      return { saved: true };
    },
  };
}
