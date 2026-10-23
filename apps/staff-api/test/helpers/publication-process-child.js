import { once } from "node:events";
import { resolve } from "node:path";
import { connectStaffDatabase } from "../../src/db.js";
import { createVault } from "../../src/local-security.js";
import { createApp as createStaffApp } from "../../src/app.js";
import { createApp as createPublicApp } from "../../../api/src/app.js";
import { createPublicationReceiver } from "../../../api/src/publication-receiver.js";
import { createPublicationWorker } from "../../src/publication-delivery.js";
import { assertPublicationReviewStorage } from "../../../../shared/publication-review-guard.mjs";

let connection,
  server,
  worker,
  vault,
  booted = false,
  stopping,
  paused = false,
  stage = "validation";
async function finish(code = 0) {
  if (stopping) return stopping;
  stopping = (async () => {
    try {
      await worker?.stop();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await connection?.client.close();
      vault?.destroy();
    } catch {
      code = 1;
    }
    process.exit(code);
  })();
  return stopping;
}
async function boot(options) {
  if (
    booted ||
    !process.send ||
    !process.argv.includes("--isolated-publication-review") ||
    !["staff", "receiver", "sender"].includes(options?.mode)
  )
    throw new Error("Refused TEST boot");
  booted = true;
  stage = "TEST connection";
  connection = await connectStaffDatabase({
    database: "capstone_staff_test",
    demoMode: true,
  });
  assertPublicationReviewStorage(connection.db, connection.client, true);
  const { db, client } = connection;
  const started = Date.now(),
    epoch = options.clockAt ?? started;
  if (!Number.isFinite(epoch)) throw new Error("Invalid TEST clock");
  const clock = () => new Date(epoch + Date.now() - started);
  const port = options.port ?? 0;
  stage = "TEST port validation";
  if (
    !Number.isInteger(port) ||
    (port !== 0 &&
      (options.mode === "staff"
        ? port !== 4101
        : port < 1024 ||
          port > 65535 ||
          [4000, 4100, 4101, 27018].includes(port)))
  )
    throw new Error("Refused TEST port");
  if (options.mode === "receiver") {
    stage = "receiver initialization";
    const receiver = await createPublicationReceiver({
      db,
      client,
      token: options.token,
      streamId: options.streamId,
      demoMode: true,
    });
    server = createPublicApp({
      publicationReceiver: receiver,
      ...(options.website
        ? { websiteDirectory: resolve("apps/web/dist") }
        : {}),
    }).listen(port, "127.0.0.1");
  } else {
    stage = "sender initialization";
    const request = options.pauseAtSend
      ? async (_url, { signal }) => {
          process.send({ type: "claimed" });
          return new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("Synthetic interrupted send")),
              { once: true },
            ),
          );
        }
      : async (...args) => {
          if (paused) throw new Error("Owned TEST receiver outage");
          return fetch(...args);
        };
    worker = createPublicationWorker({
      db,
      client,
      target: options.target,
      token: options.token,
      demoMode: true,
      automatic: options.mode === "staff",
      clock,
      request,
    });
    if (options.mode === "staff") {
      vault = createVault(connection.config.key);
      server = createStaffApp({
        db,
        client,
        vault,
        clock,
        demoMode: true,
        publicationDeliveryConfigured: true,
      }).listen(port, "127.0.0.1");
    }
  }
  stage = "owned listener";
  if (server) await once(server, "listening");
  process.send({ type: "ready", port: server?.address().port ?? null });
}
process.on("message", (message) => {
  if (message?.type === "stop") return void finish();
  if (message?.type === "boot")
    return void boot(message.options).catch(() => {
      process.send?.({ type: "failed", stage });
      void finish(1);
    });
  if (message?.type !== "control" || !booted) return;
  void (async () => {
    let result;
    if (message.action === "tick") result = await worker?.tick();
    else if (message.action === "pause") {
      paused = true;
      result = { paused: true };
    } else if (message.action === "resume") {
      paused = false;
      result = { paused: false };
    } else throw new Error("Invalid TEST control");
    process.send?.({ type: "result", id: message.id, ok: true, result });
  })().catch(() =>
    process.send?.({ type: "result", id: message.id, ok: false }),
  );
});
process.on("disconnect", () => void finish());
process.on("SIGINT", () => void finish());
process.on("SIGTERM", () => void finish());
process.on("uncaughtException", () => void finish(1));
process.on("unhandledRejection", () => void finish(1));
