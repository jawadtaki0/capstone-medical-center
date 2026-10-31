// Explicit, isolated synthetic review tooling. Never packaged into the client.
import { createServer } from "node:http";
import { createServer as createProbe } from "node:net";
import { once } from "node:events";
import {
  readFile,
  writeFile,
  mkdir,
  open,
  unlink,
  access,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLauncherConfig } from "../../staff-api/scripts/launcher/configuration.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const folder = join(root, ".local/website-requests-hosting");
const privateFolder = join(folder, "private");
const accessPath = join(privateFolder, "cedar-review-access.dpapi");
const lockPath = join(folder, "hosted-review.lock");

async function assertPortAvailable() {
  const probe = createProbe();
  try {
    probe.listen(4101, "127.0.0.1");
    await once(probe, "listening");
  } finally {
    if (probe.listening) await new Promise((resolve) => probe.close(resolve));
  }
}

export async function runHostedWebsiteRequestReview(
  args = process.argv.slice(2),
) {
  if (
    args.some((arg) => !["--initialize-review", "--show-access"].includes(arg))
  )
    throw new Error(
      "Only --initialize-review or --show-access are supported; no reset action exists.",
    );
  if (process.version !== "v24.22.1")
    throw new Error(
      "Use the verified portable Node 24.22.1 runtime from the private review instructions.",
    );
  process.env.CAPSTONE_STAFF_RUNTIME_DIR = (
    await readLauncherConfig()
  ).runtimeDirectory;
  delete process.env.STAFF_SETUP_TEST_MEMORY;
  const { dpapi, protectDirectory } =
    await import("../../staff-api/src/local-security.js");
  async function readProtected(path) {
    const plain = await dpapi(await readFile(path), "Unprotect");
    try {
      return JSON.parse(plain.toString("utf8"));
    } finally {
      plain.fill(0);
    }
  }
  const environment = await readProtected(
    join(privateFolder, "hosted-review.dpapi"),
  );
  const { loadHostedReviewEnvironment } =
    await import("../../api/src/hosted-review.js");
  const cloud = loadHostedReviewEnvironment(environment);
  const { hostedReviewIdentity } =
    await import("../../../shared/hosted-review-config.mjs");
  const source = JSON.parse(
    await readFile(join(privateFolder, "published-source.json"), "utf8"),
  );
  const approved = JSON.parse(
    await readFile(join(folder, "approved-review-limits.json"), "utf8"),
  );
  const identity = {
    sourceDigest: source.sourceDigest,
    configDigest: hostedReviewIdentity(cloud),
    streamId: cloud.streamId,
  };

  if (args.includes("--show-access")) {
    if (args.includes("--initialize-review"))
      throw new Error(
        "Access display and initialization are separate actions.",
      );
    const saved = await readProtected(accessPath);
    if (saved.version !== 1 || saved.syntheticOnly !== true)
      throw new Error("Review access format refused.");
    const { showSyntheticReviewAccess } =
      await import("./private-review-access.js");
    await showSyntheticReviewAccess(saved);
    return;
  }

  await mkdir(folder, { recursive: true });
  const lock = await open(lockPath, "wx");
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, kind: "hosted-website-request-review" }),
  );
  let fixture, server, worker, stopped, stopHandler, inputHandler;
  async function stop() {
    if (stopped) return stopped;
    stopped = (async () => {
      if (stopHandler) {
        process.removeListener("SIGINT", stopHandler);
        process.removeListener("SIGTERM", stopHandler);
      }
      if (inputHandler) {
        process.stdin.removeListener("data", inputHandler);
        process.stdin.pause();
      }
      await worker?.stop();
      if (server) {
        server.closeIdleConnections?.();
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            server.closeAllConnections?.();
            resolve();
          }, 5000);
          server.close(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      await fixture?.close();
      await lock.close();
      await unlink(lockPath);
    })();
    return stopped;
  }
  try {
    await assertPortAvailable();
    const {
      createRequestTransport,
      validateHostedReviewRequestConfig,
      startHostedReviewRequestWorker,
    } = await import("../../staff-api/src/request-integration.js");
    const requestConfig = {
      version: 1,
      mode: "hosted-review",
      apiOrigin: cloud.apiOrigin,
      publicBase: cloud.publicBase,
      publicDatabase: cloud.publicDatabase,
      publicSrvHost: cloud.publicSrvHost,
      streamId: cloud.streamId,
      target: `${cloud.apiOrigin}/api/requests/integration`,
      contact: cloud.contact,
      credential: cloud.requestCredential,
      key: environment.CEDAR_REVIEW_REQUEST_KEY,
      manualRefreshOnly: true,
    };
    validateHostedReviewRequestConfig(requestConfig);
    const integration = {
      ...requestConfig,
      key: cloud.key,
      transport: createRequestTransport(requestConfig),
    };
    const { createSecurityFixture } =
      await import("../../staff-api/test/helpers/security-fixture.js");
    fixture = await createSecurityFixture({
      hostedReview: true,
      requestIntegration: integration,
    });
    // Fixtures normally start HTTP as part of reset(). Review startup must
    // preserve records, so start its owned ephemeral API without resetting.
    await fixture.restart();
    const { ensureRequestIndexes } =
      await import("../../staff-api/src/website-requests.js");
    await ensureRequestIndexes(fixture.db);
    const { assertHostedSeedLedger, seedHostedReview } =
      await import("./hosted-review-seed.js");
    const ledger = await fixture.db
      .collection("hosted_seed_state")
      .findOne({ _id: "baseline" });
    if (
      !assertHostedSeedLedger(ledger, identity) &&
      !args.includes("--initialize-review")
    )
      throw new Error(
        "Review is not initialized. Use the explicit --initialize-review step in the private guide.",
      );
    if (!ledger) {
      try {
        await access(accessPath);
        throw new Error("Existing review access requires reconciliation.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await seedHostedReview(fixture, {
      source,
      approved,
      identity,
      saveAccess: async (value) => {
        await protectDirectory(privateFolder);
        const plain = Buffer.from(JSON.stringify(value));
        try {
          await writeFile(accessPath, await dpapi(plain, "Protect"), {
            flag: "wx",
            mode: 0o600,
          });
        } finally {
          plain.fill(0);
        }
      },
    });
    await access(accessPath);
    await fixture.stopServer();
    const { createApp } = await import("../../staff-api/src/app.js");
    const app = createApp({
      db: fixture.db,
      client: fixture.client,
      vault: fixture.vault,
      clock: () => new Date(),
      demoMode: true,
      requestIntegration: integration,
    });
    server = createServer((request, response) => {
      if (request.url === "/__review/identity") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(
          JSON.stringify({
            ownedReview: true,
            mode: "hosted-review",
            namespace: "hosted_review_",
            database: "capstone_staff_test",
            configDigest: identity.configDigest,
            pid: process.pid,
          }),
        );
      } else app(request, response);
    }).listen(4101, "127.0.0.1");
    await once(server, "listening");
    worker = startHostedReviewRequestWorker(app.locals.websiteRequests());
    await writeFile(
      join(folder, "cedar-ready.json"),
      JSON.stringify(
        {
          pid: process.pid,
          api: "http://127.0.0.1:4101",
          publicBase: cloud.publicBase,
          configDigest: identity.configDigest,
          sourceDigest: source.sourceDigest,
          syntheticOnly: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "Isolated Cedar hosted review ready on 127.0.0.1:4101. Pending tracking work synchronizes automatically; Refresh retrieves new requests. Idle checks stay local; no WhatsApp opening is performed.",
    );
    const stopSafely = () => {
      void stop().catch(() => {
        console.error(
          "Owned review shutdown did not finish. Preserve the lock for operator reconciliation; do not stop unrelated services.",
        );
        process.exitCode = 1;
      });
    };
    stopHandler = stopSafely;
    inputHandler = (chunk) => {
      if (chunk.toString().trim() === "stop") stopSafely();
    };
    process.once("SIGINT", stopHandler);
    process.once("SIGTERM", stopHandler);
    process.stdin.on("data", inputHandler);
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runHostedWebsiteRequestReview().catch(() => {
    console.error(
      "Hosted Cedar review did not start. Existing services/records preserved. Check the private guide for review-only runtime, lock, port and initialization prerequisites; do not reset data or kill unrelated processes.",
    );
    process.exitCode = 1;
  });
}
