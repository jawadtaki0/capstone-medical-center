// Owns synthetic TEST fixtures and ports only. Never run concurrently with fixture suites.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, open, unlink } from "node:fs/promises";
import { createServer as probe } from "node:net";
import { once } from "node:events";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { readLauncherConfig } from "../../staff-api/scripts/launcher/configuration.js";
process.env.CAPSTONE_STAFF_RUNTIME_DIR = (
  await readLauncherConfig()
).runtimeDirectory;
delete process.env.STAFF_SETUP_TEST_MEMORY;
const folder = resolve(".local/website-requests-review"),
  lockPath = resolve(".local/professional-schedule-review/review.lock");
await mkdir(folder, { recursive: true });
await mkdir(resolve(".local/professional-schedule-review"), {
  recursive: true,
});
const lock = await open(lockPath, "wx");
await lock.writeFile(
  JSON.stringify({
    pid: process.pid,
    kind: "website-requests-synthetic-review",
  }),
);
let f, staff, publicServer, worker, advance;
async function available(port) {
  const s = probe();
  s.listen(port, "127.0.0.1");
  await once(s, "listening");
  await new Promise((r) => s.close(r));
}
try {
  await available(4101);
  await available(5191);
  const { createSecurityFixture } =
    await import("../../staff-api/test/helpers/security-fixture.js");
  const { seedPublicationAuthority } =
    await import("../../staff-api/test/helpers/publication-authority.js");
  const { createPublicationReceiver } =
    await import("../../api/src/publication-receiver.js");
  const { createPublicIntake, ensureIntakeIndexes } =
    await import("../../api/src/website-requests.js");
  const { ensureRequestIndexes } =
    await import("../../staff-api/src/website-requests.js");
  const { createRequestTransport, startRequestWorker } =
    await import("../../staff-api/src/request-integration.js");
  const { createApp: staffApp } = await import("../../staff-api/src/app.js");
  const { createApp: publicApp } = await import("../../api/src/app.js");
  const { buildDelivery } =
    await import("../../../shared/publication-contract.mjs");
  let keys;
  try {
    keys = JSON.parse(await readFile(folder + "/test-keys.json", "utf8"));
  } catch {
    keys = {
      key: randomBytes(32).toString("base64url"),
      credential: randomBytes(32).toString("base64url"),
    };
    await writeFile(folder + "/test-keys.json", JSON.stringify(keys), {
      flag: "wx",
    });
  }
  const config = {
    key: Buffer.from(keys.key, "base64url"),
    credential: keys.credential,
    mode: "test",
    target: "http://127.0.0.1:5191/api/requests/integration",
    publicBase: "http://127.0.0.1:5191",
    contact: "+961 00 000 000 — SYNTHETIC TEST ONLY",
  };
  config.transport = createRequestTransport(config);
  f = await createSecurityFixture({ requestIntegration: config });
  let accessData;
  if (process.argv.includes("--reset-test")) {
    await f.reset();
    const a = await seedPublicationAuthority(f);
    await a.save("professionals", {
      id: "specialist:synthetic",
      name: "Nour Synthetic",
      specialty: "Therapist",
      kind: "specialist",
      gender: "female",
      active: true,
      scopeIds: ["clinic:synthetic"],
    });
    await a.save("sessions", {
      id: "session:specialist",
      scopeId: "clinic:synthetic",
      professionalId: "specialist:synthetic",
      weekday: 1,
      startTime: "13:00",
      endTime: "14:30",
      capacity: 3,
      status: "active",
      appointmentRequired: true,
    });
    a.ok(await a.publish(null));
    const r = await f.account({
      username: "synthetic.requests",
      roles: ["Receptionist"],
    });
    await f.db.collection("operational_grants").insertOne({
      _id: r.id,
      id: r.id,
      scopeIds: ["clinic:synthetic"],
      revision: 1,
    });
    accessData = {
      username: r.username,
      password: r.password,
      scope: "clinic:synthetic",
      syntheticOnly: true,
    };
    await writeFile(
      folder + "/access.json",
      JSON.stringify(accessData, null, 2),
    );
  } else {
    accessData = JSON.parse(await readFile(folder + "/access.json", "utf8"));
  }
  await f.stopServer();
  await ensureIntakeIndexes(f.db);
  await ensureRequestIndexes(f.db);
  const state = await f.db
    .collection("operational_state")
    .findOne({ _id: "working" });
  const receiver = await createPublicationReceiver({
    db: f.db,
    client: f.client,
    token: keys.credential,
    streamId: state.streamId,
    demoMode: true,
    environment: { mode: "test" },
  });
  const history = await f.db
    .collection("operational_publications")
    .find({})
    .sort({ sequence: 1 })
    .toArray();
  await receiver.accept(buildDelivery(state.streamId, history));
  const intake = createPublicIntake({
    db: f.db,
    client: f.client,
    key: config.key,
    clock: f.clock,
    sessionReader: (d) => receiver.requestSessions(d),
    professionalReader: (d) => receiver.requestProfessionals(d),
  });
  publicServer = publicApp({
    websiteDirectory: resolve("apps/web/dist"),
    websiteRequests: { service: intake, credential: keys.credential },
    publicationReceiver: receiver,
    databaseHealthReader: async () => {
      await f.db.command({ ping: 1 });
      return "connected";
    },
  }).listen(5191, "127.0.0.1");
  await once(publicServer, "listening");
  const app = staffApp({
    db: f.db,
    client: f.client,
    vault: f.vault,
    clock: f.clock,
    demoMode: true,
    requestIntegration: config,
  });
  staff = createServer((q, r) => {
    if (q.url === "/__review/identity") {
      r.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      r.end(
        JSON.stringify({
          database: "capstone_staff_test",
          ownedReview: true,
          pid: process.pid,
        }),
      );
      return;
    }
    app(q, r);
  }).listen(4101, "127.0.0.1");
  await once(staff, "listening");
  worker = startRequestWorker(app.locals.websiteRequests());
  advance = setInterval(() => f.advance(1000), 1000);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(f.clock());
  const d = new Date(today + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  await writeFile(
    folder + "/ready.json",
    JSON.stringify(
      {
        pid: process.pid,
        public: "http://127.0.0.1:5191/request",
        staff: "http://127.0.0.1:4101",
        date: d.toISOString().slice(0, 10),
        database: "capstone_staff_test",
        fixtureOnly: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Synthetic website review ready: http://127.0.0.1:5191/request ; owned staff TEST API4101. No WhatsApp opening is performed by this harness.",
  );
  let ending = false;
  async function stop() {
    if (ending) return;
    ending = true;
    clearInterval(advance);
    await worker?.stop();
    for (const s of [staff, publicServer]) {
      s?.closeIdleConnections();
      await new Promise((r) => (s ? s.close(r) : r()));
    }
    await f?.close();
    await lock.close();
    await unlink(lockPath);
    process.exit(0);
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.on("data", (chunk) => {
    if (chunk.toString().trim() === "stop") void stop();
  });
} catch (e) {
  console.error(
    "Isolated review startup failed safely: " + e.name + " " + (e.code ?? ""),
  );
  clearInterval(advance);
  await worker?.stop();
  staff?.close();
  publicServer?.close();
  await f?.close();
  await lock.close();
  await unlink(lockPath);
  process.exitCode = 1;
}
