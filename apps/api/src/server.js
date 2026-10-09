import { createApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase, connectDatabase, getDatabaseStatus } from "./db.js";

let stopping = false;
let recoveryTimer = null;
let lastReportedState = null;

async function refreshDatabase() {
  try {
    await connectDatabase();
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
const server = createApp().listen(config.port, () => {
  console.log(
    `Medical center API listening on http://localhost:${config.port}`,
  );
  void refreshDatabase();
});

async function shutDown(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(recoveryTimer);
  console.log(`${signal} received; shutting down.`);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutDown("SIGINT"));
process.on("SIGTERM", () => shutDown("SIGTERM"));
