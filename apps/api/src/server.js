import { createApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase, connectDatabase } from "./db.js";

try {
  await connectDatabase();
} catch (error) {
  console.warn(`MongoDB is unavailable; starting the API without persistence: ${error.message}`);
}

const server = createApp().listen(config.port, () => {
  console.log(`Medical center API listening on http://localhost:${config.port}`);
});

async function shutDown(signal) {
  console.log(`${signal} received; shutting down.`);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutDown("SIGINT"));
process.on("SIGTERM", () => shutDown("SIGTERM"));

