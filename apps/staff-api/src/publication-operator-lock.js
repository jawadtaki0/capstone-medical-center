import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Serializes complete cross-database operator actions on this approved single
// Windows host, not just their individual Mongo transactions. Never steal a
// stale lock: a crashed operator requires explicit identity/state reconciliation.
export async function withPublicationOperatorLock(directory, action) {
  const path = join(directory, "publication-transition.lock"),
    owner = randomUUID();
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another publication operator action is running or needs crash reconciliation. No transition was started.",
      );
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({
        owner,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );
    await handle.sync();
    return await action();
  } finally {
    await handle.close();
    const marker = JSON.parse(await readFile(path, "utf8"));
    if (marker.owner !== owner)
      throw new Error(
        "Operator lock ownership changed. No foreign lock was removed.",
      );
    await unlink(path);
  }
}
