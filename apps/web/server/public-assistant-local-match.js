import { createHash } from "node:crypto";
import { dirname, basename, resolve } from "node:path";
import { intentModel, intentModelDirectory } from "../scripts/intent-model.mjs";
import precomputed from "./public-assistant-intent-vectors.json" with { type: "json" };
import { publicIntentBank } from "./public-assistant-intent-bank.js";

export const intentThresholds = { high: 0.87, middle: 0.855, margin: 0.01 };

export function intentBand(ranking, thresholds = intentThresholds) {
  const [best, second] = ranking;
  if (!best || best.score < thresholds.middle)
    return { band: "low", intents: [] };
  if (
    best.score >= thresholds.high &&
    (!second || best.score - second.score >= thresholds.margin)
  )
    return { band: "high", intents: [best.intent] };
  return {
    band: "middle",
    intents: ranking
      .filter(({ score }) => score >= thresholds.middle)
      .slice(0, 3)
      .map(({ intent }) => intent),
  };
}

const examples = Object.entries(publicIntentBank).flatMap(
  ([intent, questions]) => questions.map((question) => ({ intent, question })),
);
const cosine = (v, w) => v.reduce((score, x, i) => score + x * w[i], 0);

// Changes whenever the model or any example does, so stale vectors cannot load.
export const bankFingerprint = () =>
  createHash("sha256")
    .update(JSON.stringify([intentModel.revision, publicIntentBank]))
    .digest("hex");

export async function createEncoder(
  modelDirectory = process.env.CEDAR_INTENT_MODEL_DIR ?? intentModelDirectory,
) {
  const { env, pipeline } = await import("@huggingface/transformers");
  const path = resolve(modelDirectory);
  env.allowRemoteModels = false;
  env.useFSCache = false;
  env.localModelPath = dirname(path);
  const encode = await pipeline("feature-extraction", basename(path), {
    local_files_only: true,
    device: "cpu",
    dtype: "q8",
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  });
  return (messages) => embed(encode, messages);
}

export function createLocalIntentRanker(modelDirectory) {
  let ready;
  return async (question) => {
    if (precomputed.fingerprint !== bankFingerprint())
      throw Error("Intent vectors are out of date");
    ready ??= createEncoder(modelDirectory);
    const [vector] = await (await ready)([question]);
    const scored = new Map(
      Object.keys(publicIntentBank).map((intent) => [intent, []]),
    );
    for (const [i, { intent }] of examples.entries()) {
      scored.get(intent).push(cosine(vector, precomputed.vectors[i]));
    }
    return [...scored]
      .map(([intent, scores]) => ({
        intent,
        score:
          scores
            .sort((a, b) => b - a)
            .slice(0, 3)
            .reduce((sum, score) => sum + score, 0) / 3,
      }))
      .sort((a, b) => b.score - a.score);
  };
}

async function embed(encode, messages) {
  const result = await encode(
    messages.map((text) => "query: " + text),
    {
      pooling: "mean",
      normalize: true,
      truncation: true,
      max_length: 128,
    },
  );
  return result.tolist();
}

export function createLocalIntentMatcher(directory) {
  const rank = createLocalIntentRanker(directory);
  return async (question) => intentBand(await rank(question));
}
