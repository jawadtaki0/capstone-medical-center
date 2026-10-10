import { access, mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { runtimeDirectory } from "../src/local-security.js";
import {
  checkLauncherFiles,
  validateLauncherConfig,
  launcherConfigPath,
  projectRoot,
  childEnvironment,
} from "./launcher/configuration.js";
import { launcherIcon } from "./launcher/icon.js";
import { LauncherError } from "./launcher/orchestrator.js";

async function install() {
  if (process.platform !== "win32" || !process.argv.includes("--demo-loopback"))
    throw new LauncherError(
      "Windows and explicit --demo-loopback are required for this local shortcut.",
    );
  const update = process.argv.includes("--update");
  const parameter = (name) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  let previous;
  try {
    previous = JSON.parse(await readFile(launcherConfigPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new LauncherError(
        "Existing launcher settings are unreadable; they were not replaced.",
      );
  }
  if (previous && !update)
    throw new LauncherError(
      "Launcher settings already exist. Use --update with an explicit --app target to update this launcher only.",
    );
  const target = parameter("--app");
  if (!target)
    throw new LauncherError(
      "Provide --app followed by the exact reviewed packaged Cedar Staff executable. No timestamp-based selection is used.",
    );
  const config = validateLauncherConfig({
    version: 1,
    demoMode: true,
    runtimeDirectory: parameter("--runtime")
      ? resolve(parameter("--runtime"))
      : previous?.runtimeDirectory || runtimeDirectory,
    nodePath: process.execPath,
    appPath: resolve(target),
  });
  await checkLauncherFiles(config);
  const electron = join(
    projectRoot,
    "node_modules",
    "electron",
    "dist",
    "electron.exe",
  );
  try {
    await access(electron);
  } catch {
    throw new LauncherError(
      "The existing Electron runtime is missing. Restore reviewed project dependencies manually; nothing will be downloaded.",
    );
  }
  await mkdir(dirname(launcherConfigPath), { recursive: true });
  // This selection contains local paths only, never protected authority or
  // delivery credentials. Electron's shortcut helper commits after inspecting
  // any existing link, refusing a same-name unrelated shortcut.
  const selection = join(
    dirname(launcherConfigPath),
    "cedar-staff-launcher-selection.json",
  );
  await writeFile(selection, JSON.stringify(config, null, 2));
  const icon = join(dirname(launcherConfigPath), "cedar-staff-launcher.ico");
  await writeFile(icon, launcherIcon());
  const script = join(
    projectRoot,
    "apps",
    "staff",
    "launcher",
    "install-shortcut.cjs",
  );
  const child = spawn(electron, [script, selection, launcherConfigPath, icon], {
    cwd: projectRoot,
    windowsHide: true,
    shell: false,
    env: childEnvironment(config.runtimeDirectory),
    stdio: "ignore",
  });
  const code = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolveExit(1);
    }, 20000);
    child.once("error", () => {
      clearTimeout(timer);
      resolveExit(1);
    });
    child.once("exit", (value) => {
      clearTimeout(timer);
      resolveExit(value);
    });
  });
  if (code !== 0)
    throw new LauncherError(
      "Shortcut setup did not complete. A same-name unrelated shortcut, Windows desktop access or the Electron runtime may need checking. Existing launcher settings were not replaced unless its own link was successfully written.",
    );
  console.log(
    "Created/updated Start Cedar Staff on your Windows desktop. Launcher settings: .local/cedar-staff-launcher.json. No services, accounts or sending settings were changed.",
  );
}
install().catch((error) => {
  console.error(
    error instanceof LauncherError
      ? error.message
      : "Shortcut setup failed safely; no accounts or protected configuration were changed.",
  );
  process.exitCode = 1;
});
