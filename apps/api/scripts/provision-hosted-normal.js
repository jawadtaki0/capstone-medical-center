import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import { hostedNormalIdentity } from "../../../shared/hosted-normal-config.mjs";
import {
  payloadDigest,
  validateDelivery,
} from "../../../shared/publication-contract.mjs";
import { assertSinglePublicationStream } from "../src/publication-receiver.js";
import { ensureIntakeIndexes } from "../src/website-requests.js";

export async function provisionHostedNormal(options) {
  assertPublicationStorage(
    options.db,
    options.client,
    true,
    "public",
    options.config,
  );
  return provisionExistingNormalReceiver(options);
}

// Internal state operation is independently rehearsable against guarded TEST.
// The normal entry above verifies the real Atlas target before calling it.
export async function provisionExistingNormalReceiver({
  db,
  client,
  config,
  expected,
  confirmed = false,
}) {
  if (
    !confirmed ||
    !expected ||
    !Number.isSafeInteger(expected.sequence) ||
    expected.sequence < 1 ||
    !Number.isSafeInteger(expected.revision) ||
    expected.revision < 0 ||
    !Number.isSafeInteger(expected.authorityRevision) ||
    expected.authorityRevision < 0 ||
    !/^[a-f0-9]{64}$/.test(expected.digest ?? "")
  )
    throw Error("Explicit current normal reconciliation required.");
  const configDigest = hostedNormalIdentity(config),
    markers = db.collection("hosted_normal_configuration"),
    states = db.collection("public_publication_state");
  async function check(session) {
    const opts = session ? { session } : {};
    const authority = await db
      .collection("public_data_authority")
      .findOne({ _id: "source" }, opts);
    const state = await states.findOne({ _id: config.streamId }, opts);
    const existing = await markers.findOne({ _id: "normal" }, opts);
    if (
      authority?.mode !== "cedar" ||
      authority.streamId !== config.streamId ||
      !state ||
      !Number.isSafeInteger(state.sequence) ||
      state.sequence < 1
    )
      throw Error("Normal authority/accepted stream requires reconciliation.");
    await assertSinglePublicationStream(db, config.streamId, session);
    const record = await db
      .collection("public_accepted_publications")
      .findOne({ _id: `${config.streamId}:${state.sequence}` }, opts);
    if (
      record?.payload?.streamId !== config.streamId ||
      record?.payload?.sequence !== state.sequence ||
      payloadDigest(record.payload) !== record.digest
    )
      throw Error("Accepted publication integrity requires reconciliation.");
    validateDelivery(record.payload);
    if (existing) {
      if (
        existing.version !== 1 ||
        existing.status !== "ready" ||
        existing.configDigest !== configDigest
      )
        throw Error(
          "Existing hosted configuration differs; no replacement allowed.",
        );
      return true;
    }
    if (
      authority.revision !== expected.authorityRevision ||
      state.revision !== expected.revision ||
      state.sequence !== expected.sequence ||
      record?.digest !== expected.digest ||
      record?.payload?.streamId !== config.streamId ||
      record?.payload?.sequence !== state.sequence ||
      payloadDigest(record.payload) !== expected.digest
    )
      throw Error(
        "Accepted baseline or revision changed; regenerate reconciliation.",
      );
    validateDelivery(record.payload);
    return false;
  }
  if (await check()) return { status: "existing", configDigest };
  await ensureIntakeIndexes(db);
  await markers.createIndex({ _id: 1 });
  const session = client.startSession();
  try {
    return await session.withTransaction(
      async () => {
        if (await check(session)) return { status: "existing", configDigest };
        const locked = await states.updateOne(
          {
            _id: config.streamId,
            revision: expected.revision,
            sequence: expected.sequence,
          },
          { $inc: { revision: 1 } },
          { session },
        );
        if (locked.matchedCount !== 1)
          throw Error("Accepted state changed; no activation.");
        const authorityLocked = await db
          .collection("public_data_authority")
          .updateOne(
            {
              _id: "source",
              mode: "cedar",
              streamId: config.streamId,
              revision: expected.authorityRevision,
            },
            { $inc: { revision: 1 } },
            { session },
          );
        if (authorityLocked.matchedCount !== 1)
          throw Error("Source authority changed; no activation.");
        await markers.insertOne(
          {
            _id: "normal",
            version: 1,
            status: "ready",
            configDigest,
            createdAt: new Date(),
            acceptedDigestAtProvision: expected.digest,
          },
          { session },
        );
        return {
          status: "created",
          configDigest,
          acceptedSequence: expected.sequence,
        };
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        maxCommitTimeMS: 5000,
      },
    );
  } finally {
    await session.endSession();
  }
}
