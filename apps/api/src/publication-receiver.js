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
import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import { hostedReviewIdentity } from "../../../shared/hosted-review-config.mjs";
import { getPublicProfessionals } from "./professionals.js";
import { getBeirutToday, getScheduleForDate } from "./schedule.js";

export const PUBLIC_COLLECTIONS = Object.freeze({
  versions: "public_accepted_publications",
  state: "public_publication_state",
});
export async function assertSinglePublicationStream(db, streamId, session) {
  const authority = await db
    .collection("public_data_authority")
    .findOne({ _id: "source" }, { session });
  if (
    authority &&
    (!["legacy", "cedar"].includes(authority.mode) ||
      (authority.streamId && authority.streamId !== streamId))
  )
    throw new Error(
      "Existing public authority requires explicit reconciliation.",
    );
  if (
    (await db
      .collection(PUBLIC_COLLECTIONS.state)
      .findOne({ _id: { $ne: streamId } }, { session })) ||
    (await db
      .collection(PUBLIC_COLLECTIONS.versions)
      .findOne({ "payload.streamId": { $ne: streamId } }, { session }))
  )
    throw new Error(
      "A conflicting public publication stream already exists. History was not replaced.",
    );
}
export async function initializePublicationStream({
  db,
  client,
  streamId,
  strict = false,
}) {
  const initialize = async (session) => {
    if (strict) {
      await db
        .collection("public_data_authority")
        .updateOne(
          { _id: "source" },
          { $inc: { revision: 1 }, $setOnInsert: { mode: "legacy" } },
          { session, upsert: true },
        );
      await assertSinglePublicationStream(db, streamId, session);
      await db
        .collection("public_data_authority")
        .updateOne({ _id: "source" }, { $set: { streamId } }, { session });
    }
    await db
      .collection(PUBLIC_COLLECTIONS.state)
      .updateOne(
        { _id: streamId },
        { $setOnInsert: { sequence: 0, revision: 0 } },
        { session, upsert: true },
      );
  };
  if (!strict) return initialize();
  const session = client.startSession();
  try {
    return await session.withTransaction(() => initialize(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
  } finally {
    await session.endSession();
  }
}
export async function createPublicationReceiver({
  db,
  client,
  token,
  streamId,
  demoMode,
  environment = { mode: "test" },
}) {
  assertPublicationStorage(db, client, demoMode, "public", environment);
  if (
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    typeof streamId !== "string" ||
    !/^[A-Za-z0-9:_-]{1,120}$/.test(streamId)
  )
    throw new Error("Missing private publication receiver configuration.");
  const state = db.collection(PUBLIC_COLLECTIONS.state),
    versions = db.collection(PUBLIC_COLLECTIONS.versions);
  if (environment.mode === "hosted-review") {
    const marker = await db
      .collection("hosted_review_configuration")
      .findOne({ _id: "review" });
    const authority = await db
      .collection("public_data_authority")
      .findOne({ _id: "source" });
    const current = await state.findOne({ _id: streamId });
    if (
      marker?.version !== 1 ||
      marker.status !== "ready" ||
      marker.configDigest !== hostedReviewIdentity(environment) ||
      authority?.mode !== "cedar" ||
      authority.streamId !== streamId ||
      !current ||
      !Number.isSafeInteger(current.sequence) ||
      current.sequence < 0
    )
      throw new Error(
        "Hosted review must be explicitly provisioned and reconciled before runtime binding.",
      );
    await assertSinglePublicationStream(db, streamId);
  } else {
    await initializePublicationStream({
      db,
      client,
      streamId,
      strict: environment.mode === "normal-local",
    });
  }
  const acknowledgement = (record) => ({
    accepted: true,
    schemaVersion: record.payload.schemaVersion,
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
      const intendedHost =
        environment.mode === "hosted-review"
          ? !request.get("Origin") &&
            request.get("Host") === new URL(environment.apiOrigin).host
          : ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
              request.socket.remoteAddress,
            ) && ["127.0.0.1", "localhost", "[::1]"].includes(request.hostname);
      return (
        intendedHost &&
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
    async requestProfessionals(date) {
      const p = await snapshot(date),
        clinicIds = p.scopes
          .filter((s) => s.kind === "clinic" && s.active)
          .map((s) => s.id);
      return p.professionals
        .filter(
          (x) => x.active && x.scopeIds.some((id) => clinicIds.includes(id)),
        )
        .map((x) => ({
          id: x.id,
          name: x.name,
          specialty: x.specialty,
          avatarVariant: x.avatarVariant,
        }));
    },
    async requestSessions(date) {
      const p = await snapshot(date),
        day = new Date(`${date}T12:00:00Z`).getUTCDay();
      const hours =
        p.hours.find((h) => h.id === date) ??
        p.hours.find((h) => h.id === String(day));
      if (!hours || hours.closed) return [];
      const rows = p.sessions.filter(
        (s) =>
          s.weekday === day &&
          !p.exceptions.some((e) => e.scopeId === s.scopeId && e.date === date),
      );
      rows.push(
        ...p.exceptions
          .filter((e) => e.date === date && !e.closed)
          .flatMap((e) => e.sessions),
      );
      return rows.flatMap((s) => {
        const scope = p.scopes.find((x) => x.id === s.scopeId),
          professional = p.professionals.find((x) => x.id === s.professionalId);
        return scope?.kind === "clinic" &&
          scope.active &&
          professional?.active &&
          s.status === "active" &&
          s.startTime >= hours.startTime &&
          s.endTime <= hours.endTime
          ? [
              {
                date,
                scopeId: s.scopeId,
                sourceSessionId: s.id,
                professionalId: professional.id,
                professionalName: professional.name,
                specialty: professional.specialty,
                kind: professional.kind,
                avatarVariant: professional.avatarVariant,
                startTime: s.startTime,
                endTime: s.endTime,
                appointmentRequired: s.appointmentRequired,
              },
            ]
          : [];
      });
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
