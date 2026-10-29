import { isIP } from "node:net";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHostedReviewApp,
  loadHostedReviewEnvironment,
} from "./hosted-review.js";

// This policy must be enabled explicitly only for Render's trusted last hop.
// Deployment verification must establish that the platform appends/overwrites
// this final address; arbitrary public forwarding prefixes are never trusted.
export function createRenderReviewSource(environment, config) {
  if (environment.CEDAR_REVIEW_TRUSTED_PROXY !== "render-last-hop")
    throw new Error("Explicit reviewed Render source policy is required.");
  const host = new URL(config.apiOrigin).host;
  return (request) => {
    const forwarded = request.get("X-Forwarded-For");
    if (
      request.get("Host") !== host ||
      typeof forwarded !== "string" ||
      forwarded.length > 1024 ||
      /[\r\n]/.test(forwarded)
    )
      throw new Error("Hosted source is unavailable.");
    const parts = forwarded.split(",");
    const last = parts.at(-1).trim();
    if (parts.length > 16 || !isIP(last))
      throw new Error("Hosted source is unavailable.");
    return last.toLowerCase();
  };
}

export async function startHostedReviewServer({
  environment = process.env,
  createApplication = createHostedReviewApp,
  listen = (app, port) => app.listen(port, "0.0.0.0"),
} = {}) {
  const config = loadHostedReviewEnvironment(environment);
  const sourceReader = createRenderReviewSource(environment, config);
  const rawPort = environment.PORT ?? "10000";
  if (
    !/^\d{1,5}$/.test(rawPort) ||
    Number(rawPort) < 1 ||
    Number(rawPort) > 65535
  )
    throw new Error("A valid Render PORT is required.");
  const application = createApplication({ config, sourceReader });
  let server;
  try {
    server = listen(application.app, Number(rawPort));
    await once(server, "listening");
  } catch {
    server?.close();
    await application.close();
    throw new Error("Hosted synthetic review could not start safely.");
  }
  let stopping;
  return {
    server,
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        server.closeIdleConnections?.();
        await new Promise((done) => {
          const timer = setTimeout(() => {
            server.closeAllConnections?.();
            done();
          }, 10000);
          server.close(() => {
            clearTimeout(timer);
            done();
          });
        });
        await application.close();
      })();
      return stopping;
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const service = await startHostedReviewServer();
    console.log(
      "Synthetic Cedar review API started; no normal services were changed.",
    );
    for (const signal of ["SIGTERM", "SIGINT"])
      process.on(signal, () => {
        void service.stop().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
  } catch {
    console.error(
      "Hosted review startup refused. Check dedicated review environment, provisioned storage and explicit proxy policy; no normal fallback is used.",
    );
    process.exitCode = 1;
  }
}
