import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A local migration lock, not a database setting or public writing endpoint.
export const MIGRATION_LOCK = fileURLToPath(new URL("../../../.tmp/schema-cleanup/public-data.lock", import.meta.url));

export function createPublicDataGate({ paused = () => existsSync(MIGRATION_LOCK) } = {}) {
  let readers = 0;
  return {
    status: () => ({ paused: paused(), activeReaders: readers }),
    guard(handler) {
      return async (request, response, next) => {
        if (paused()) {
          response.status(503).json({ error: "schema_migration_in_progress", message: "Public data is temporarily unavailable. Please try again shortly." });
          return;
        }
        readers += 1;
        try {
          await handler(request, response, next);
        } finally {
          // A disconnected client does not cancel an awaited database operation.
          // Keep the reader counted until the actual handler settles, so a
          // migration cannot begin while that operation is still reading data.
          readers -= 1;
        }
      };
    },
  };
}
