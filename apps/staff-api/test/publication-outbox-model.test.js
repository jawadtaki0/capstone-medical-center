import test from "node:test";
import assert from "node:assert/strict";
import {
  makePublicationIntent,
  retryDelay,
  validateReceiverTarget,
  acknowledgementMatches,
} from "../src/publication-delivery.js";
import { publicationEvent } from "../../../shared/test-fixtures/publication.mjs";

test("delivery intent is immutable public data with an identity stable across retry attempts", () => {
  const intent = makePublicationIntent(
    "stream:synthetic",
    [publicationEvent()],
    new Date("2026-01-01T00:00:00Z"),
  );
  assert.equal(intent._id, "publication:1");
  assert.equal(intent.state, "pending");
  assert.equal(intent.attempts, 0);
  assert.equal(JSON.stringify(intent.payload).includes("capacity"), false);
  const ack = {
    accepted: true,
    schemaVersion: 1,
    streamId: intent.streamId,
    sequence: intent.sequence,
    digest: intent.digest,
  };
  assert.equal(acknowledgementMatches(intent, ack), true);
  for (const change of [
    { digest: "other" },
    { sequence: 2 },
    { accepted: false },
    { streamId: "another" },
    { privateField: true },
  ])
    assert.equal(acknowledgementMatches(intent, { ...ack, ...change }), false);
});
test("loopback review transport refuses public, credential-bearing, query and unrelated-service targets", () => {
  assert.doesNotThrow(() =>
    validateReceiverTarget("http://127.0.0.1:4201/api/publications", true),
  );
  for (const url of [
    "http://example.com/api/publications",
    "http://127.0.0.1:4100/api/publications",
    "http://u:p@127.0.0.1:4201/api/publications",
    "http://127.0.0.1:4201/api/publications?token=secret",
    "http://127.0.0.1:4201/other",
  ])
    assert.throws(() => validateReceiverTarget(url, true));
  assert.throws(() =>
    validateReceiverTarget("http://127.0.0.1:4201/api/publications", false),
  );
  assert.deepEqual([1, 2, 3, 10].map(retryDelay), [5000, 10000, 20000, 60000]);
});
