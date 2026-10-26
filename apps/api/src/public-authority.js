import { createHash } from "node:crypto";
import { BSON } from "mongodb";
import { PUBLIC_BASELINE_COLLECTIONS } from "./public-data-backup.js";
import {
  composePublications,
  publicSnapshotDatabase,
} from "../../../shared/published-timeline.mjs";
import { canonicalJSON } from "../../../shared/publication-contract.mjs";
import { getPublicProfessionals } from "./professionals.js";
import { getScheduleForDate } from "./schedule.js";

export const PUBLIC_AUTHORITY = "public_data_authority";
const conflict = () => {
  throw new Error(
    "Public authority conflict. Reconcile the source, accepted baseline and expected revision; no source switch was made.",
  );
};
export async function legacyFingerprint(db, session) {
  const hash = createHash("sha256");
  for (const name of PUBLIC_BASELINE_COLLECTIONS) {
    hash.update(name + "\0");
    const docs = await db
      .collection(name)
      .find({}, { session, raw: true })
      .sort({ _id: 1 })
      .toArray();
    for (const doc of docs) hash.update(doc);
  }
  return hash.digest("hex");
}
export function snapshotLegacyFingerprint(snapshot) {
  const hash = createHash("sha256");
  for (const name of PUBLIC_BASELINE_COLLECTIONS) {
    hash.update(name + "\0");
    const docs = [...snapshot.collections[name].raw].sort((a, b) => {
      const x = String(BSON.deserialize(a)._id),
        y = String(BSON.deserialize(b)._id);
      return x === y ? 0 : x < y ? -1 : 1;
    });
    for (const raw of docs) hash.update(raw);
  }
  return hash.digest("hex");
}
// Supported legacy writers and source switches share a persistent transaction anchor.
export async function guardLegacyWrites(db, session) {
  const target = db.collection(PUBLIC_AUTHORITY);
  await target.updateOne(
    { _id: "source" },
    { $inc: { revision: 1 }, $setOnInsert: { mode: "legacy" } },
    { session, upsert: true },
  );
  const current = await target.findOne({ _id: "source" }, { session });
  if (current.mode !== "legacy" || current.writesFrozen)
    throw new Error(
      "Cedar is the operational authority or transition is frozen. Legacy schedule writers are disabled.",
    );
}
export async function compareBaseline(db, payload, session) {
  if (
    payload.schemaVersion !== 2 ||
    payload.sequence !== 1 ||
    payload.events[0].effectiveFrom !== null
  )
    conflict();
  const snapshot = composePublications(payload.events, null);
  const sorted = (value) =>
    canonicalJSON(
      Array.isArray(value)
        ? [...value].sort((a, b) => a.id.localeCompare(b.id))
        : value,
    );
  const dates = new Set(
    Array.from(
      { length: 7 },
      (_, i) => `2026-01-${String(4 + i).padStart(2, "0")}`,
    ),
  );
  for (const change of await db
    .collection("schedule_date_changes")
    .find({}, { session })
    .toArray())
    dates.add(change.date);
  for (const change of snapshot.exceptions) dates.add(change.date);
  for (const hours of snapshot.hours)
    if (!/^[0-6]$/.test(hours.id)) dates.add(hours.id);
  // Readers receive a transaction-bound facade so comparison cannot mix revisions.
  const scopedDb = {
    collection(name) {
      const c = db.collection(name);
      return {
        findOne(q, opts) {
          return c.findOne(q, { ...opts, session });
        },
        find(q, opts) {
          return c.find(q, { ...opts, session });
        },
      };
    },
  };
  if (
    sorted(await getPublicProfessionals(scopedDb)) !==
    sorted(await getPublicProfessionals(publicSnapshotDatabase(snapshot)))
  )
    conflict();
  for (const date of dates)
    if (
      canonicalJSON(await getScheduleForDate(date, scopedDb)) !==
      canonicalJSON(
        await getScheduleForDate(
          date,
          publicSnapshotDatabase(snapshot, "schedule"),
        ),
      )
    )
      conflict();
  return { directoriesMatch: true, datesCompared: dates.size };
}
export function createPublicAuthority({ db, client, streamId }) {
  const authority = db.collection(PUBLIC_AUTHORITY),
    state = db.collection("public_publication_state");
  return {
    async mode() {
      const value = await authority.findOne({ _id: "source" });
      if (!value) return "legacy";
      if (
        !["legacy", "cedar"].includes(value.mode) ||
        (value.streamId && value.streamId !== streamId)
      )
        conflict();
      return value.mode;
    },
    async freeze({ expectedFingerprint, confirmed }) {
      if (!confirmed) conflict();
      const session = client.startSession();
      try {
        return await session.withTransaction(
          async () => {
            await authority.updateOne(
              { _id: "source" },
              { $inc: { revision: 1 }, $setOnInsert: { mode: "legacy" } },
              { session, upsert: true },
            );
            const source = await authority.findOne(
              { _id: "source" },
              { session },
            );
            if (
              source.mode !== "legacy" ||
              (source.streamId && source.streamId !== streamId) ||
              (await legacyFingerprint(db, session)) !== expectedFingerprint
            )
              conflict();
            await authority.updateOne(
              { _id: "source" },
              {
                $set: {
                  writesFrozen: true,
                  legacyFingerprint: expectedFingerprint,
                  ...(streamId ? { streamId } : {}),
                },
              },
              { session },
            );
            return { frozen: true, revision: source.revision };
          },
          {
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" },
          },
        );
      } finally {
        await session.endSession();
      }
    },
    async switch({
      mode,
      expectedRevision,
      expectedSequence,
      expectedDigest,
      expectedLegacyFingerprint,
      confirmed,
    }) {
      if (
        !confirmed ||
        !["cedar", "legacy"].includes(mode) ||
        expectedSequence !== 1
      )
        conflict();
      const session = client.startSession();
      try {
        return await session.withTransaction(
          async () => {
            await authority.updateOne(
              { _id: "source" },
              { $inc: { revision: 1 }, $setOnInsert: { mode: "legacy" } },
              { session, upsert: true },
            );
            const source = await authority.findOne(
              { _id: "source" },
              { session },
            );
            if (
              source.revision !== expectedRevision + 1 ||
              (source.streamId && source.streamId !== streamId)
            )
              conflict();
            const guarded = await state.updateOne(
              { _id: streamId },
              { $inc: { revision: 1 } },
              { session },
            );
            if (guarded.matchedCount !== 1) conflict();
            const accepted = await state.findOne(
              { _id: streamId },
              { session },
            );
            if (
              accepted.sequence !== expectedSequence ||
              accepted.digest !== expectedDigest ||
              (await legacyFingerprint(db, session)) !==
                expectedLegacyFingerprint
            )
              conflict();
            const record = await db
              .collection("public_accepted_publications")
              .findOne({ _id: `${streamId}:1` }, { session });
            if (!record || record.digest !== expectedDigest) conflict();
            const comparison = await compareBaseline(
              db,
              record.payload,
              session,
            );
            await authority.updateOne(
              { _id: "source" },
              {
                $set: {
                  mode,
                  writesFrozen: mode === "cedar",
                  streamId,
                  baselineDigest: expectedDigest,
                  legacyFingerprint: expectedLegacyFingerprint,
                  changedAt: new Date(),
                },
              },
              { session },
            );
            return { mode, revision: source.revision, comparison };
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
  };
}
