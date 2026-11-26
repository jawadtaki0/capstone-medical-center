import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchIntentModel, intentModel } from "../scripts/intent-model.mjs";
import { publicIntentBank } from "../server/public-assistant-intent-bank.js";
import { bankFingerprint } from "../server/public-assistant-local-match.js";
import vectors from "../server/public-assistant-intent-vectors.json" with { type: "json" };

test("the committed example vectors match the bank and model", () => {
  assert.equal(vectors.fingerprint, bankFingerprint());
  const count = Object.values(publicIntentBank).flat().length;
  assert.equal(vectors.vectors.length, count);
  for (const vector of vectors.vectors) {
    assert.equal(vector.length, 384);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.001);
  }
});

test("the model download is pinned to a revision and file hashes", () => {
  assert.match(intentModel.revision, /^[0-9a-f]{40}$/u);
  for (const { sha256 } of intentModel.files)
    assert.match(sha256, /^[0-9a-f]{64}$/u);
});

test("downloads are verified, kept once, and rejected when altered", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "intent-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = Buffer.from("published model bytes");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const model = { ...intentModel, files: [{ path: "onnx/a.bin", sha256 }] };
  let requests = 0;
  const serve = (bytes) => async () => {
    requests++;
    return new Response(bytes);
  };
  await assert.rejects(
    fetchIntentModel({ directory, model, fetch: serve("altered") }),
    /checksum/iu,
  );
  await fetchIntentModel({ directory, model, fetch: serve(body) });
  await fetchIntentModel({ directory, model, fetch: serve("unused") });
  assert.equal(requests, 2);
  assert.deepEqual(await readFile(join(directory, "onnx", "a.bin")), body);
});
