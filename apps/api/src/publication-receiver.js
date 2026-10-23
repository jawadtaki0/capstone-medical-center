import { timingSafeEqual } from "node:crypto";
import {
  validateDelivery,
  payloadDigest,
  PublicationError,
} from "../../../shared/publication-contract.mjs";
import {
  composePublications,
  publicSnapshotDatabase,
} from "../../../shared/published-timeline.mjs";
import { assertPublicationReviewStorage } from "../../../shared/publication-review-guard.mjs";
import { getPublicProfessionals } from "./professionals.js";
import { getBeirutToday, getScheduleForDate } from "./schedule.js";

export const PUBLIC_COLLECTIONS = Object.freeze({
  versions: "public_accepted_publications",
  state: "public_publication_state",
});
export async function createPublicationReceiver({
  db,
  client,
  token,
  streamId,
  demoMode,
}) {
  assertPublicationReviewStorage(db, client, demoMode);
  if (
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    typeof streamId !== "string" ||
    !/^[A-Za-z0-9:_-]{1,120}$/.test(streamId)
  )
    throw new Error("Missing private publication receiver configuration.");
  const state = db.collection(PUBLIC_COLLECTIONS.state),
    versions = db.collection(PUBLIC_COLLECTIONS.versions);
  await state.updateOne(
    { _id: streamId },
    { $setOnInsert: { sequence: 0, revision: 0 } },
    { upsert: true },
  );
  const acknowledgement = (record) => ({
    accepted: true,
    schemaVersion: 1,
    streamId,
    sequence: record.payload.sequence,
    digest: record.digest,
  });
  async function snapshot(date) {
    const current = await state.findOne({ _id: streamId });
    const record = current?.sequence
      ? await versions.findOne({ _id: `${streamId}:${current.sequence}` })
      : null;
    const result = record && composePublications(record.payload.events, date);
    if (!result) throw new PublicationError("publication_unavailable", 503);
    return result;
  }
  return {
    authorized(request) {
      const presented = request
        .get("Authorization")
        ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      return (
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          request.socket.remoteAddress,
        ) &&
        ["127.0.0.1", "localhost", "[::1]"].includes(request.hostname) &&
        Boolean(
          presented &&
          timingSafeEqual(Buffer.from(presented), Buffer.from(token)),
        )
      );
    },
    async accept(payload) {
      validateDelivery(payload);
      if (payload.streamId !== streamId)
        throw new PublicationError("publication_stream_conflict", 409);
      const digest = payloadDigest(payload),
        key = `${streamId}:${payload.sequence}`,
        session = client.startSession();
      try {
        return await session.withTransaction(
          async () => {
            // All competing acceptances serialize through this persistent anchor.
            const guarded = await state.updateOne(
              { _id: streamId },
              { $inc: { revision: 1 } },
              { session },
            );
            if (guarded.modifiedCount !== 1)
              throw new PublicationError("publication_unavailable", 503);
            const current = await state.findOne({ _id: streamId }, { session });
            const existing = await versions.findOne({ _id: key }, { session });
            if (existing) {
              if (existing.digest !== digest)
                throw new PublicationError(
                  "publication_identity_conflict",
                  409,
                );
              return acknowledgement(existing);
            }
            if (payload.sequence <= current.sequence)
              throw new PublicationError("stale_publication", 409);
            if (current.sequence) {
              const prior = await versions.findOne(
                { _id: `${streamId}:${current.sequence}` },
                { session },
              );
              if (
                !prior ||
                prior.payload.events.some(
                  (event, i) =>
                    payloadDigest(event) !== payloadDigest(payload.events[i]),
                )
              )
                throw new PublicationError("publication_history_conflict", 409);
            }
            const record = {
              _id: key,
              digest,
              payload,
              acceptedAt: new Date(),
            };
            await versions.insertOne(record, { session });
            await state.updateOne(
              { _id: streamId },
              { $set: { sequence: payload.sequence, digest } },
              { session },
            );
            return acknowledgement(record);
          },
          {
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" },
            readPreference: "primary",
          },
        );
      } finally {
        await session.endSession();
      }
    },
    async professionals() {
      return getPublicProfessionals(
        publicSnapshotDatabase(await snapshot(getBeirutToday())),
      );
    },
    async schedule(date) {
      return getScheduleForDate(
        date,
        publicSnapshotDatabase(await snapshot(date), "schedule"),
      );
    },
    async health() {
      try {
        await db.command({ ping: 1 });
        return "connected";
      } catch {
        return "unavailable";
      }
    },
  };
}
