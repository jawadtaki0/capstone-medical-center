import { startPrivateMongo, rootClient } from "../mongo-process.js";
import { readAuthority } from "../../src/local-security.js";
import { startStaffServer } from "../../src/server.js";
import { terminateCapturedChild } from "./orchestrator.js";

// A launcher-owned IPC channel controls only this host's captured service.
// Successful handoff permits parent exit; a lost parent before handoff cleans
// startup up. No public stop endpoint, registry PID, or secret command argument.
if (
  !process.send ||
  !process.argv.includes("--demo-loopback") ||
  !["mongo", "api"].includes(process.argv[2])
)
  throw new Error("Owned launcher host required.");
let child;
let api;
let handedOff = false;
let stopping;

async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (api) await api.stop();
    if (child && child.exitCode === null && child.signalCode === null) {
      const client = rootClient(await readAuthority(), {
        socketTimeoutMS: 3000,
      });
      try {
        await client.connect();
        const status = await client.db("admin").command({ serverStatus: 1 });
        if (status.pid !== child.pid)
          throw new Error("Captured Mongo process changed.");
        try {
          await client.db("admin").command({ shutdown: 1 });
        } catch (error) {
          if (
            error.name !== "MongoNetworkError" &&
            error.name !== "MongoServerSelectionError"
          )
            throw error;
        }
      } catch {
        // A failed pre-listen startup cannot accept authenticated shutdown.
        // Only the live child spawned here can be terminated, never a PID file.
        terminateCapturedChild(child);
      } finally {
        await client.close();
      }
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => child.once("exit", resolve));
    }
  })();
  return stopping;
}

async function finish() {
  const deadline = setTimeout(() => {
    // First attempt authenticated graceful shutdown. If it cannot finish,
    // do not orphan our detached Mongo child by merely exiting its host.
    terminateCapturedChild(child);
    process.exit(1);
  }, 10000);
  try {
    await stop();
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    clearTimeout(deadline);
    process.exit(1);
  }
}

process.on("message", (message) => {
  if (message?.type === "stop") void finish();
  if (message?.type === "prepare-release" && !stopping) {
    process.send?.({ type: "release-ready" });
  }
  if (message?.type === "release" && !stopping) {
    handedOff = true;
    process.send?.({ type: "released" });
  }
});
process.on("disconnect", () => {
  if (!handedOff) void finish();
  else if (child) {
    child.unref();
    process.exit(0);
  }
});
process.on("SIGTERM", () => {
  void finish();
});
process.on("SIGINT", () => {
  void finish();
});

try {
  if (process.argv[2] === "mongo") {
    child = await startPrivateMongo({ detached: true });
    child.once("error", () => {
      void finish();
    });
    child.once("exit", () => {
      if (!stopping && !handedOff) void finish();
    });
  } else api = await startStaffServer({ demoMode: true });
  process.send?.({ type: "started" });
} catch {
  await finish();
}
