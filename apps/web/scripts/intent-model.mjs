// Fetches the pinned open model (MIT, base intfloat/multilingual-e5-small) at
// build time. The files are too large for Git, so every one is hash-checked.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const intentModel = {
  repository: "Xenova/multilingual-e5-small",
  revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  files: [
    {
      path: "config.json",
      sha256:
        "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
    },
    {
      path: "tokenizer.json",
      sha256:
        "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    {
      path: "tokenizer_config.json",
      sha256:
        "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
    {
      path: "onnx/model_quantized.onnx",
      sha256:
        "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    },
  ],
};

export const intentModelDirectory = fileURLToPath(
  new URL("../intent-model/multilingual-e5-small", import.meta.url),
);

async function checksum(path) {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return hash.digest("hex");
}

export async function fetchIntentModel({
  directory = intentModelDirectory,
  model = intentModel,
  fetch = globalThis.fetch,
} = {}) {
  for (const { path, sha256 } of model.files) {
    const target = join(directory, path);
    if ((await checksum(target)) === sha256) continue;
    const response = await fetch(
      `https://huggingface.co/${model.repository}/resolve/${model.revision}/${path}`,
    );
    if (!response.ok)
      throw Error(`Intent model download failed: ${path} ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw Error("Intent model checksum mismatch: " + path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target + ".part", bytes);
    await rm(target, { force: true });
    await rename(target + ".part", target);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await fetchIntentModel();
