import { access } from "node:fs/promises";
import { join } from "node:path";
import { runtimeDirectory } from "../src/local-security.js";
import {
  startPrivateMongo,
  checkOwnedMongo,
  stopOwnedMongo,
  sleep,
} from "./mongo-process.js";

async function run() {
  if (!process.argv.includes("--demo-loopback"))
    throw new Error("Explicit demo mode required.");
  await access(join(runtimeDirectory, "ready.json"));
  if (process.argv.includes("--stop")) {
    await stopOwnedMongo();
    console.log(
      "Owned staff-only MongoDB stopped; existing service untouched.",
    );
    return;
  }
  try {
    await checkOwnedMongo();
    console.log(
      "Isolated staff MongoDB already running; not starting or stopping another process.",
    );
    return;
  } catch {}
  const child = await startPrivateMongo();
  let stopping = false;
  async function cleanup() {
    // This process spawned the child: cleanup cannot stop the existing service.
    if (child.exitCode !== null) return;
    try {
      await stopOwnedMongo();
    } catch {
      if (child.exitCode === null) child.kill();
    }
  }
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await cleanup();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await checkOwnedMongo();
        break;
      } catch {
        if (child.exitCode !== null || attempt === 39)
          throw new Error("Private MongoDB unavailable.");
        await sleep(500);
      }
    }
    console.log(
      "Staff-only MongoDB running on loopback port 27018. Ctrl+C stops this owned instance.",
    );
    if (child.exitCode === null)
      await new Promise((resolve) => child.once("exit", resolve));
  } finally {
    await cleanup();
  }
}
run().catch(() => {
  console.error(
    "Isolated staff database unavailable. Run staff:prepare first; existing MongoDB is untouched.",
  );
  process.exitCode = 1;
});
