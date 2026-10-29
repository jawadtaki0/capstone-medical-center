import { connectStaffDatabase } from "../../src/db.js";
import { assertIsolatedTestTarget } from "./security-fixture.js";
import { createVault } from "../../src/local-security.js";
import { createAuthService } from "../../src/auth.js";
import { createRequestTransport } from "../../src/request-integration.js";
if (!process.argv.includes("--guarded-request-test"))
  throw Error("TEST process guard required.");
let connection, vault;
process.on("message", async (m) => {
  try {
    if (m.type === "stop") {
      vault?.destroy();
      await connection?.client.close();
      process.exit(0);
    }
    if (m.type !== "run") return;
    connection = await connectStaffDatabase({
      database: "capstone_staff_test",
      demoMode: true,
      initializeIndexes: false,
    });
    assertIsolatedTestTarget(connection);
    vault = createVault(connection.config.key);
    const config = { ...m.config, key: Buffer.from(m.config.key, "base64url") };
    config.transport = createRequestTransport(config);
    const service = createAuthService({
      ...connection,
      vault,
      clock: () => new Date(m.now),
      requestIntegration: config,
    }).websiteRequests;
    await service.pump();
    const result = await service.list(m.token, {});
    process.send({
      ok: true,
      status: result.requests.map((r) => r.status),
      bookings: await connection.db.collection("bookings").countDocuments({}),
      pending: await connection.db
        .collection("website_request_events")
        .countDocuments({ state: "pending" }),
    });
  } catch {
    process.send({ ok: false });
  }
});
