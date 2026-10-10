import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readLauncherConfig,
  launcherConfigPath,
} from "./launcher/configuration.js";
import { LauncherError } from "./launcher/orchestrator.js";

export async function startStaffCommand() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  process.on("message", (message) => {
    if (message?.type === "cancel") cancel();
  });
  process.on("disconnect", cancel);
  const report = (value) => {
    if (process.send) process.send(value);
    else console.log(value.message);
  };
  try {
    if (!process.argv.includes("--demo-loopback"))
      throw new LauncherError(
        "Explicit --demo-loopback is required. The launcher does not enable HTTP for LAN or remote use.",
      );
    const index = process.argv.indexOf("--config");
    const config = await readLauncherConfig(
      index >= 0 ? process.argv[index + 1] : launcherConfigPath,
    );
    process.env.CAPSTONE_STAFF_RUNTIME_DIR = config.runtimeDirectory;
    const { runConfiguredLauncher } = await import("./launcher/runtime.js");
    await runConfiguredLauncher(config, {
      signal: controller.signal,
      progress: (message) => report({ type: "progress", message }),
    });
    report({
      type: "complete",
      message: "Cedar Staff opened. Local services remain running.",
    });
  } catch (error) {
    report({
      type: "failure",
      message:
        error instanceof LauncherError
          ? error.message
          : "Cedar Staff startup could not complete safely. Check the selected package and local runtime, then retry.",
    });
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (process.connected) process.disconnect();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void startStaffCommand();
