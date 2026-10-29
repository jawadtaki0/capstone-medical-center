import {
  loadRequestConfig,
  createRequestTransport,
  startRequestWorker,
} from "./request-integration.js";
import { ensureRequestIndexes } from "./website-requests.js";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectStaffDatabase } from "./db.js";
import { createVault } from "./local-security.js";
import { createApp } from "./app.js";
import {
  loadPublicationConfig,
  publicationEnvironment,
} from "./publication-config.js";
import { createPublicationWorker } from "./publication-delivery.js";

// Own one captured connection/vault pair. Refreshes share a promise rather
// than overlapping interval callbacks that can close a newer connection.
export function createAuthorityLifecycle({
  database = "capstone_staff_dev",
  connectDatabase = connectStaffDatabase,
  makeVault = createVault,
  makeApp = createApp,
  log = () => {},
  publicationConfig = loadPublicationConfig,
  makePublicationWorker = createPublicationWorker,
} = {}) {
  let current;
  let refreshPromise;
  let stopping = false;
  const unavailable = JSON.stringify({
    error: {
      code: "AUTHORITY_UNAVAILABLE",
      message:
        "The local staff authority is unavailable. No offline sign-in is permitted.",
    },
  });

  async function dispose(candidate) {
    if (!candidate) return;
    try {
      await candidate.requestWorker?.stop().catch(() => {});
      await candidate.worker?.stop().catch(() => {});
      await candidate.connection.client.close();
    } catch {
    } finally {
      try {
        candidate.vault?.destroy();
      } catch {}
    }
  }

  async function refreshOnce() {
    if (stopping) return;
    const captured = current;
    if (captured) {
      try {
        await captured.connection.db.command({ ping: 1 });
        return;
      } catch {
        if (current === captured) current = undefined;
        await dispose(captured);
      }
    }
    if (stopping) return;
    let candidate;
    try {
      const connection = await connectDatabase({ database, demoMode: true });
      candidate = { connection };
      if (stopping) {
        await dispose(candidate);
        return;
      }
      candidate.vault = makeVault(connection.config.key);
      let delivery = null,
        publicationDeliveryBlocked = false;
      try {
        delivery =
          database === "capstone_staff_dev" ? await publicationConfig() : null;
        if (delivery) {
          const state = await connection.db
            .collection("operational_state")
            .findOne({ _id: "working" });
          const imported = await connection.db
            .collection("operational_imports")
            .findOne({ _id: "public-baseline-v1" });
          if (
            state?.streamId !== delivery.streamId ||
            imported?.digest !== delivery.importDigest ||
            imported?.rolledBackAt
          )
            throw new Error(
              "Publication authority configuration does not match its import/stream.",
            );
        }
        if (delivery)
          candidate.worker = makePublicationWorker({
            ...connection,
            target: delivery.target,
            token: delivery.token,
            demoMode: true,
            environment: publicationEnvironment(delivery),
            streamId: delivery.streamId,
          });
      } catch {
        delivery = null;
        publicationDeliveryBlocked = true;
        log(
          "Publication configuration needs operator reconciliation. Other local staff functions remain available.",
        );
      }
      let requestIntegration = null;
      try {
        const requestConfig =
          database === "capstone_staff_dev" ? await loadRequestConfig() : null;
        if (requestConfig) {
          await ensureRequestIndexes(connection.db);
          requestIntegration = {
            ...requestConfig,
            transport: createRequestTransport(requestConfig),
          };
        }
      } catch {
        log(
          "Website request configuration unavailable; other staff functions remain available.",
        );
      }
      candidate.app = makeApp({
        ...connection,
        vault: candidate.vault,
        requestIntegration,
        demoMode: true,
        publicationDeliveryConfigured: Boolean(delivery),
        publicationDeliveryBlocked,
      });
      if (requestIntegration)
        candidate.requestWorker = startRequestWorker(
          candidate.app.locals.websiteRequests(),
          { onError: log },
        );
      if (stopping) {
        await dispose(candidate);
        return;
      }
      current = candidate;
      log("Staff authority connected to its isolated local database.");
    } catch {
      if (current === candidate) current = undefined;
      await dispose(candidate);
    }
  }

  return {
    handler(request, response) {
      if (current && !stopping) return current.app(request, response);
      response.writeHead(503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(unavailable);
    },
    refresh() {
      if (stopping) return Promise.resolve();
      if (!refreshPromise)
        refreshPromise = refreshOnce().finally(() => {
          refreshPromise = undefined;
        });
      return refreshPromise;
    },
    async stop() {
      stopping = true;
      await refreshPromise;
      const captured = current;
      current = undefined;
      await dispose(captured);
    },
  };
}

export async function startStaffServer({ demoMode, testMode = false } = {}) {
  if (!demoMode) throw new Error("Explicit demo mode required.");
  const port = testMode ? 4101 : 4100;
  const authority = createAuthorityLifecycle({
    database: testMode ? "capstone_staff_test" : "capstone_staff_dev",
    log: console.log,
  });
  const server = createServer(authority.handler);
  let timer;
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    server.closeIdleConnections();
    // Stop accepting requests and drain existing responses before destroying
    // the vault they use; in-flight refresh candidates are also cleaned up.
    await new Promise((resolveClose) => server.close(resolveClose));
    await authority.stop();
  }
  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });
  server.on("error", () => {
    console.error("Staff listener failed.");
    process.exitCode = 1;
    void stop();
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`Staff HTTP demo listening only on loopback port ${port}.`),
  );
  async function check() {
    await authority.refresh();
    if (!stopping)
      timer = setTimeout(() => {
        void check();
      }, 5000);
  }
  await check();
  return { stop };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startStaffServer({
    demoMode: process.argv.includes("--demo-loopback"),
    testMode: process.argv.includes("--test-database"),
  }).catch(() => {
    console.error(
      "Staff API requires explicitly enabled local demo mode and the private runtime.",
    );
    process.exitCode = 1;
  });
}
