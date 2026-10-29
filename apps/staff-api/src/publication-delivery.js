import { randomUUID } from "node:crypto";
import {
  buildDelivery,
  payloadDigest,
  canonicalJSON,
} from "../../../shared/publication-contract.mjs";
import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import { validateHostedReviewConfig } from "../../../shared/hosted-review-config.mjs";

export const PUBLICATION_OUTBOX = "public_publication_outbox";
export function makePublicationIntent(streamId, events, at) {
  const payload = structuredClone(buildDelivery(streamId, events));
  const event = events.at(-1);
  return {
    _id: event.id,
    streamId,
    sequence: payload.sequence,
    scopeIds: [...event.scopeIds],
    effectiveFrom: event.effectiveFrom,
    payload,
    digest: payloadDigest(payload),
    state: "pending",
    attempts: 0,
    nextAttemptAt: at,
    createdAt: at,
  };
}
export const retryDelay = (attempts) =>
  Math.min(60000, 5000 * 2 ** Math.min(4, Math.max(0, attempts - 1)));
export function validateReceiverTarget(
  value,
  demoMode,
  environment = { mode: "test" },
) {
  const url = new URL(value);
  if (environment.mode === "hosted-review") {
    validateHostedReviewConfig(environment);
    if (
      demoMode !== true ||
      value !== `${environment.apiOrigin}/api/publications`
    )
      throw new Error(
        "Publication destination must match the explicit review origin and fixed path.",
      );
    return url.href;
  }
  if (
    demoMode !== true ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    (environment.mode === "normal-local"
      ? url.port !== "4000"
      : ["4000", "4100", "4101", "27018"].includes(url.port)) ||
    url.pathname !== "/api/publications" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Only an explicitly configured owned loopback publication receiver is supported in this increment.",
    );
  return url.href;
}
export function acknowledgementMatches(intent, ack) {
  return Boolean(
    ack &&
    typeof ack === "object" &&
    !Array.isArray(ack) &&
    Object.keys(ack).length === 5 &&
    ack.accepted === true &&
    ack.schemaVersion === intent.payload.schemaVersion &&
    ack.streamId === intent.streamId &&
    ack.sequence === intent.sequence &&
    ack.digest === intent.digest,
  );
}
async function boundedAcknowledgement(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > 4096) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("invalid_acknowledgement");
    }
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function createPublicationWorker({
  db,
  client,
  target,
  token,
  demoMode,
  request = fetch,
  clock = () => new Date(),
  automatic = true,
  environment = { mode: "test" },
  streamId,
}) {
  assertPublicationStorage(db, client, demoMode, "staff", environment);
  const url = validateReceiverTarget(target, demoMode, environment);
  if (environment.mode === "hosted-review" && streamId !== environment.streamId)
    throw new Error(
      "Review delivery requires its configured immutable stream identity.",
    );
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("Missing private publication delivery credential.");
  const outbox = db.collection(PUBLICATION_OUTBOX);
  if (
    environment.mode === "normal-local" &&
    (typeof streamId !== "string" || !/^stream:[a-f0-9-]{36}$/.test(streamId))
  )
    throw new Error(
      "Normal delivery requires the configured immutable stream identity.",
    );
  let stopped = false,
    running = null,
    timer;
  async function attempt() {
    const at = clock(),
      leaseId = randomUUID();
    const job = await outbox.findOneAndUpdate(
      {
        ...(streamId ? { streamId } : {}),
        $or: [
          {
            state: { $in: ["pending", "failed"] },
            nextAttemptAt: { $lte: at },
          },
          { state: "sending", leaseUntil: { $lte: at } },
        ],
      },
      {
        $set: {
          state: "sending",
          leaseId,
          leaseUntil: new Date(
            +at + (environment.mode === "hosted-review" ? 90000 : 15000),
          ),
          lastAttemptAt: at,
        },
        $inc: { attempts: 1 },
      },
      { sort: { sequence: -1 }, returnDocument: "after" },
    );
    if (!job) return { idle: true };
    let reason = "receiver_unavailable";
    try {
      const response = await request(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(
          environment.mode === "hosted-review" ? 75000 : 5000,
        ),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: canonicalJSON(job.payload),
      });
      if (!response.ok) {
        reason =
          response.status === 401
            ? "receiver_authentication_failed"
            : response.status === 409
              ? "receiver_conflict"
              : "receiver_rejected";
        await response.body?.cancel?.().catch(() => {});
        throw new Error(reason);
      }
      reason = "invalid_acknowledgement";
      const ack = await boundedAcknowledgement(response);
      if (!acknowledgementMatches(job, ack)) throw new Error(reason);
      // Acknowledgement covers the complete, prefix-validated immutable timeline.
      // Never write status based on an unrelated or stale lease response.
      const session = client.startSession();
      try {
        await session.withTransaction(
          async () => {
            const changed = await outbox.updateOne(
              { _id: job._id, state: "sending", leaseId },
              {
                $set: {
                  state: "accepted",
                  acceptedAt: clock(),
                  acceptedSequence: job.sequence,
                },
                $unset: { leaseId: "", leaseUntil: "", lastError: "" },
              },
              { session },
            );
            if (changed.modifiedCount)
              await outbox.updateMany(
                {
                  streamId: job.streamId,
                  sequence: { $lt: job.sequence },
                  state: { $ne: "accepted" },
                },
                {
                  $set: {
                    state: "accepted",
                    acceptedAt: clock(),
                    acceptedSequence: job.sequence,
                  },
                  $unset: { leaseId: "", leaseUntil: "", lastError: "" },
                },
                { session },
              );
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
      return { accepted: true, sequence: job.sequence };
    } catch {
      await outbox.updateOne(
        { _id: job._id, state: "sending", leaseId },
        {
          $set: {
            state: "failed",
            lastError: reason,
            nextAttemptAt: new Date(+clock() + retryDelay(job.attempts)),
          },
          $unset: { leaseId: "", leaseUntil: "" },
        },
      );
      return { accepted: false, reason };
    }
  }
  async function tick() {
    if (stopped || running) return { busy: true };
    running = attempt();
    try {
      return await running;
    } finally {
      running = null;
    }
  }
  async function schedule() {
    try {
      await tick();
    } catch {
      /* Database unavailable: retained leases/work survive restart. */
    }
    if (!stopped) {
      timer = setTimeout(schedule, 3000);
      timer.unref();
    }
  }
  if (automatic) void schedule();
  return {
    tick,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running?.catch(() => {});
    },
  };
}
