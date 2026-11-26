// Run after changing the example bank: node scripts/build-intent-vectors.mjs
import { writeFile } from "node:fs/promises";
import { publicIntentBank } from "../server/public-assistant-intent-bank.js";
import {
  bankFingerprint,
  createEncoder,
} from "../server/public-assistant-local-match.js";

const questions = Object.values(publicIntentBank).flat();
const encode = await createEncoder(process.env.CEDAR_INTENT_MODEL_DIR);
const vectors = [];
for (let i = 0; i < questions.length; i += 12)
  vectors.push(...(await encode(questions.slice(i, i + 12))));
await writeFile(
  new URL("../server/public-assistant-intent-vectors.json", import.meta.url),
  JSON.stringify({
    fingerprint: bankFingerprint(),
    vectors: vectors.map((vector) => vector.map((x) => Number(x.toFixed(6)))),
  }) + "\n",
);
console.log("Wrote " + vectors.length + " vectors");
