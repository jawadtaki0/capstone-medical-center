// Fetches the pinned open model (MIT, base intfloat/multilingual-e5-small) once,
// the same files Ask Cedar pins. Staff AI then runs it only from disk.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { intentModel, intentModelDirectory } from "../src/assistant/model.js";

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
  fetch = globalThis.fetch,
} = {}) {
  for (const { path, sha256 } of intentModel.files) {
    const target = join(directory, path);
    if ((await checksum(target)) === sha256) continue;
    const response = await fetch(
      `https://huggingface.co/${intentModel.repository}/resolve/${intentModel.revision}/${path}`,
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
