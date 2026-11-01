import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { MongoClient } from "mongodb";
import { connectStaffDatabase } from "../src/db.js";
import { createAuthService } from "../src/auth.js";
import { createVault } from "../src/local-security.js";
import { loadRequestConfig } from "../src/request-integration.js";
import {
  loadPublicationConfig,
  publicationEnvironment,
} from "../src/publication-config.js";
import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import { createPublicIntake } from "../../api/src/website-requests.js";
const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
async function main() {
  const args = process.argv.slice(2),
    apply = args.includes("--apply"),
    test = args.includes("--test-database"),
    normal = args.includes("--normal-local");
  if (
    test === normal ||
    args.some(
      (x) =>
        ![
          "--apply",
          "--preview",
          "--test-database",
          "--normal-local",
          "--confirm-request-cleanup",
        ].includes(x),
    ) ||
    (apply && !args.includes("--confirm-request-cleanup"))
  )
    throw Error("Select one explicit target; apply needs confirmation.");
  let config, publicClient, c, vault;
  try {
    if (test) {
      const saved = JSON.parse(
        await readFile(
          join(root, ".local/website-requests-review/test-keys.json"),
          "utf8",
        ),
      );
      config = {
        key: Buffer.from(saved.key, "base64url"),
        contact: "SYNTHETIC TEST ONLY",
        publicBase: "http://127.0.0.1:5191",
        transport: {},
      };
    } else {
      config = await loadRequestConfig();
      if (!config) throw Error("Protected request configuration required.");
    }
    c = await connectStaffDatabase({
      database: test ? "capstone_staff_test" : "capstone_staff_dev",
      demoMode: true,
      initializeIndexes: false,
    });
    let publicDb = c.db;
    if (normal) {
      const publication = await loadPublicationConfig();
      if (!publication) throw Error("Approved public target required.");
      const env = parse(await readFile(join(root, "apps/api/.env")));
      publicClient = new MongoClient(
        process.env.MONGODB_URI ?? env.MONGODB_URI,
        {
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 5000,
          socketTimeoutMS: 10000,
        },
      );
      await publicClient.connect();
      publicDb = publicClient.db(
        process.env.MONGODB_DB_NAME ?? env.MONGODB_DB_NAME,
      );
      const environment = publicationEnvironment(publication);
      assertPublicationStorage(c.db, c.client, true, "staff", environment);
      assertPublicationStorage(
        publicDb,
        publicClient,
        true,
        "public",
        environment,
      );
      const authority = await publicDb
        .collection("public_data_authority")
        .findOne({ _id: "source" });
      if (authority?.mode !== "cedar")
        throw Error("Current public authority must be reconciled.");
    }
    vault = createVault(c.config.key);
    const service = createAuthService({
      ...c,
      vault,
      requestIntegration: config,
    }).websiteRequests;
    const intake = createPublicIntake({
      db: publicDb,
      client: publicClient ?? c.client,
      key: config.key,
      sessionReader: async () => [],
    });
    console.log(
      JSON.stringify({
        target: test ? "guarded TEST" : "explicit normal-local",
        mode: apply ? "apply" : "preview",
        cedar: await service.cleanup({ apply }),
        public: await intake.cleanup({ apply }),
      }),
    );
  } finally {
    vault?.destroy();
    await publicClient?.close();
    await c?.client.close();
  }
}
main().catch(() => {
  console.error(
    "Request cleanup refused or incomplete. Reconcile the explicit target/configuration and rerun preview; do not restore authentication or bypass guards.",
  );
  process.exitCode = 1;
});
