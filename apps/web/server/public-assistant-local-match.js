import { dirname, basename, resolve } from "node:path";
import { publicIntentBank } from "./public-assistant-intent-bank.js";

export const intentThresholds = { high: 0.87, middle: 0.86, margin: 0.01 };

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

export function createLocalIntentRanker(
  modelDirectory = process.env.CEDAR_INTENT_MODEL_DIR ??
    ".local/cedar-intent-models/multilingual-e5-small",
) {
  let ready;
  async function load() {
    const { env, pipeline } = await import("@huggingface/transformers");
    const path = resolve(modelDirectory);
    env.allowRemoteModels = false;
    env.localModelPath = dirname(path);
    const encode = await pipeline("feature-extraction", basename(path), {
      local_files_only: true,
      cache_dir: dirname(path),
      device: "cpu",
      dtype: "q8",
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    });
    const vectors = [];
    for (let i = 0; i < examples.length; i += 12)
      vectors.push(
        ...(await embed(
          encode,
          examples.slice(i, i + 12).map(({ question }) => question),
        )),
      );
    return { encode, vectors };
  }

  return async (question) => {
    ready ??= load();
    const { encode, vectors } = await ready;
    const [vector] = await embed(encode, [question]);
    const scored = new Map(
      Object.keys(publicIntentBank).map((intent) => [intent, []]),
    );
    for (const [i, { intent }] of examples.entries()) {
      scored.get(intent).push(cosine(vector, vectors[i]));
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
