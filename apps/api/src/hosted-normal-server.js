import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadHostedNormalEnvironment,
  createNormalSource,
  createHostedNormalApplication,
} from "./hosted-normal.js";

export async function startHostedNormalServer({
  environment = process.env,
} = {}) {
  const config = loadHostedNormalEnvironment(environment),
    raw = environment.PORT ?? "10000";
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535)
    throw Error("Invalid hosted PORT.");
  const application = createHostedNormalApplication({
    config,
    sourceReader: createNormalSource(environment, config),
  });
  const server = application.app.listen(Number(raw), "0.0.0.0");
  try {
    await once(server, "listening");
  } catch {
    server.close();
    await application.close();
    throw Error("Hosted capstone startup failed.");
  }
  return {
    server,
    async stop() {
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
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const service = await startHostedNormalServer();
    console.log("Cedar capstone public API started.");
    for (const signal of ["SIGTERM", "SIGINT"])
      process.on(
        signal,
        () =>
          void service.stop().then(
            () => process.exit(0),
            () => process.exit(1),
          ),
      );
  } catch {
    console.error(
      "Hosted capstone startup refused. Reconcile protected configuration and provisioned state.",
    );
    process.exitCode = 1;
  }
}
