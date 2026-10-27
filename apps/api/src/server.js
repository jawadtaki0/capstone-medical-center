import { createApp } from "./app.js";
import { config } from "./config.js";
import {
  closeDatabase,
  connectDatabase,
  getDatabaseStatus,
  getDatabase,
} from "./db.js";
import {
  createPublicationLifecycle,
  assertLegacyReaderMode,
} from "./normal-publication.js";
import { getScheduleForDate } from "./schedule.js";
import { getPublicProfessionals } from "./professionals.js";

const publicationEnabled =
  process.env.CAPSTONE_PUBLICATION_MODE === "normal-local";
if (publicationEnabled && config.port !== 4000)
  throw new Error(
    "Normal-local publication must use the explicitly approved loopback public API port 4000.",
  );
if (process.env.CAPSTONE_PUBLICATION_MODE && !publicationEnabled)
  throw new Error("Unsupported explicit publication mode.");
const publication = publicationEnabled
  ? createPublicationLifecycle({ getDatabase })
  : null;
const receiverProxy = publicationEnabled
  ? {
      authorized: (request) => {
        try {
          return publication.ready().receiver.authorized(request);
        } catch {
          return false;
        }
      },
      accept: async (payload) =>
        publication.withReady(({ receiver }) => receiver.accept(payload)),
      health: async () => {
        try {
          return await publication.withReady(({ receiver }) =>
            receiver.health(),
          );
        } catch {
          return "unavailable";
        }
      },
      schedule: async (date) =>
        publication.withReady(({ receiver }) => receiver.schedule(date)),
      professionals: async () =>
        publication.withReady(({ receiver }) => receiver.professionals()),
    }
  : null;
const authorityProxy = publicationEnabled
  ? {
      mode: async () =>
        publication.withReady(({ authority }) => authority.mode()),
    }
  : null;

let stopping = false;
let recoveryTimer = null;
let lastReportedState = null;

async function refreshDatabase() {
  try {
    await connectDatabase();
    if (stopping) return;
    if (publicationEnabled) await publication.refresh();
  } catch {
    // Keep the HTTP API available and retry, without logging credentials/URIs.
  }
  if (stopping) return;
  const state = getDatabaseStatus();
  if (state !== lastReportedState) {
    if (state === "connected")
      console.log("MongoDB connected; public data is available.");
    else if (state === "unavailable")
      console.warn(
        "MongoDB unavailable; public data returns 503. Retrying in 5 seconds. Check Atlas IP access and network connectivity.",
      );
    else if (state === "not-configured")
      console.warn("MongoDB is not configured; public data returns 503.");
    lastReportedState = state;
  }
  if (state !== "not-configured") {
    recoveryTimer = setTimeout(refreshDatabase, 5000);
    recoveryTimer.unref();
  }
}

// Listen immediately: a database handshake must not cause proxy ECONNREFUSED.
const server = createApp({
  publicationReceiver: receiverProxy,
  publicAuthority: authorityProxy,
  scheduleReader: async (date) => {
    await assertLegacyReaderMode(getDatabase());
    return getScheduleForDate(date);
  },
  professionalsReader: async () => {
    await assertLegacyReaderMode(getDatabase());
    return getPublicProfessionals();
  },
}).listen(config.port, publicationEnabled ? "127.0.0.1" : undefined, () => {
  console.log(
    `Medical center API listening on http://localhost:${config.port}`,
  );
  void refreshDatabase();
});

async function shutDown(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(recoveryTimer);
  publication?.invalidate();
  console.log(`${signal} received; shutting down.`);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutDown("SIGINT"));
process.on("SIGTERM", () => shutDown("SIGTERM"));
