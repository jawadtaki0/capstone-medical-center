import { TOPICS, REFUSALS } from "./topics.js";
import { intentModelDirectory } from "./model.js";
import { dirname, basename } from "node:path";

// Runs the pinned multilingual-e5-small from disk only. Remote loading is off,
// so typed text never leaves this computer.
export function createMatcher({ directory = intentModelDirectory } = {}) {
  let loading;
  async function load() {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = dirname(directory) + "/";
    const extract = await pipeline("feature-extraction", basename(directory), {
      dtype: "q8",
    });
    const embed = async (texts) =>
      (
        await extract(
          texts.map((t) => "query: " + t),
          { pooling: "mean", normalize: true },
        )
      ).tolist();
    const entries = [
      ...TOPICS.flatMap((t) => t.examples.map((e) => [t.id, e])),
      ...Object.entries(REFUSALS).flatMap(([id, examples]) =>
        examples.map((e) => [id, e]),
      ),
    ];
    const vectors = await embed(entries.map(([, example]) => example));
    return { embed, entries, vectors };
  }
  return {
    // Every intent with its closest example's cosine similarity, best first.
    async rank(message) {
      loading ??= load().catch((error) => {
        loading = undefined;
        throw error;
      });
      const { embed, entries, vectors } = await loading;
      const [query] = await embed([message]);
      const best = new Map();
      entries.forEach(([id], i) => {
        let score = 0;
        for (let j = 0; j < query.length; j++)
          score += query[j] * vectors[i][j];
        if (score > (best.get(id) ?? -1)) best.set(id, score);
      });
      return [...best]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score);
    },
  };
}
