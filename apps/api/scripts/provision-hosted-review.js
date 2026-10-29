import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import { hostedReviewIdentity } from "../../../shared/hosted-review-config.mjs";
import { ensureIntakeIndexes } from "../src/website-requests.js";

const MARKER = "hosted_review_configuration";
const AUTHORITY = "public_data_authority";
const STATE = "public_publication_state";
const allowed = new Set([
  MARKER,
  AUTHORITY,
  STATE,
  "public_accepted_publications",
  "website_requests",
  "website_request_counters",
  "website_request_state",
]);
const refused = () =>
  new Error(
    "Review initialization requires reconciliation; existing data was not replaced.",
  );

// Explicit operator only: runtime requests never create indexes or authority.
// This installs an EMPTY review stream, not a publication or normal-data cutover.
export async function provisionHostedReview({
  db,
  client,
  config,
  confirmed = false,
}) {
  if (confirmed !== true)
    throw new Error(
      "Explicit hosted-review initialization confirmation is required.",
    );
  assertPublicationStorage(db, client, true, "public", config);
  const configDigest = hostedReviewIdentity(config);
  const collections = await db
    .listCollections({}, { nameOnly: true })
    .toArray();
  if (
    collections.length > allowed.size ||
    collections.some(({ name }) => !allowed.has(name))
  )
    throw refused();

  async function existing(session) {
    const options = session ? { session } : {};
    const marker = await db
      .collection(MARKER)
      .findOne({ _id: "review" }, options);
    if (!marker) return false;
    const authority = await db
      .collection(AUTHORITY)
      .findOne({ _id: "source" }, options);
    const state = await db
      .collection(STATE)
      .findOne({ _id: config.streamId }, options);
    if (
      marker.version !== 1 ||
      marker.status !== "ready" ||
      marker.configDigest !== configDigest ||
      authority?.mode !== "cedar" ||
      authority.streamId !== config.streamId ||
      !state ||
      !Number.isSafeInteger(state.sequence) ||
      state.sequence < 0 ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0 ||
      (await db
        .collection(STATE)
        .findOne({ _id: { $ne: config.streamId } }, options)) ||
      (await db
        .collection("public_accepted_publications")
        .findOne({ "payload.streamId": { $ne: config.streamId } }, options))
    )
      throw refused();
    return true;
  }
  if (await existing()) return { status: "existing", configDigest };
  for (const { name } of collections) {
    if (await db.collection(name).findOne({}, { projection: { _id: 1 } }))
      throw refused();
  }
  // Index creation is idempotent and intentionally outside the transaction.
  // Interrupted creation leaves empty known collections, safe to retry.
  await ensureIntakeIndexes(db);
  for (const name of [
    MARKER,
    AUTHORITY,
    STATE,
    "public_accepted_publications",
    "website_request_state",
  ]) {
    await db.collection(name).createIndex({ _id: 1 });
  }
  const session = client.startSession();
  try {
    return await session.withTransaction(
      async () => {
        assertPublicationStorage(db, client, true, "public", config);
        if (await existing(session))
          return { status: "existing", configDigest };
        for (const name of allowed) {
          if (
            await db
              .collection(name)
              .findOne({}, { session, projection: { _id: 1 } })
          )
            throw refused();
        }
        await db.collection(MARKER).insertOne(
          {
            _id: "review",
            version: 1,
            status: "ready",
            configDigest,
          },
          { session },
        );
        await db.collection(AUTHORITY).insertOne(
          {
            _id: "source",
            mode: "cedar",
            streamId: config.streamId,
            revision: 0,
          },
          { session },
        );
        await db.collection(STATE).insertOne(
          {
            _id: config.streamId,
            sequence: 0,
            revision: 0,
          },
          { session },
        );
        return { status: "created", configDigest };
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
