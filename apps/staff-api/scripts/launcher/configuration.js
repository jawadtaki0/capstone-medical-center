import { access, readFile, realpath } from "node:fs/promises";
import { resolve, isAbsolute, sep, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LauncherError } from "./orchestrator.js";

export const projectRoot = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
export const launcherConfigPath = join(
  projectRoot,
  ".local",
  "cedar-staff-launcher.json",
);
export const serverEntry = join(
  projectRoot,
  "apps",
  "staff-api",
  "src",
  "server.js",
);
export const hostEntry = fileURLToPath(
  new URL("./service-host.js", import.meta.url),
);

export function validateLauncherConfig(value) {
  if (!value || value.version !== 1 || value.demoMode !== true)
    throw new LauncherError(
      "Launcher settings are missing or unsupported. Run the one-time shortcut setup with --demo-loopback.",
    );
  for (const field of ["runtimeDirectory", "nodePath", "appPath"]) {
    const path = value[field];
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      /[\0\r\n]/.test(path) ||
      !/^[A-Za-z]:[\\/]/.test(path) ||
      path.slice(2).includes(":")
    )
      throw new LauncherError(
        "Launcher paths must be absolute local Windows paths. Run shortcut setup again with the intended paths.",
      );
  }
  const releaseRoot = resolve(projectRoot, "apps", "staff", "release") + sep;
  if (
    !resolve(value.appPath)
      .toLowerCase()
      .startsWith(releaseRoot.toLowerCase()) ||
    !value.appPath.endsWith(`${sep}Cedar Staff Development.exe`)
  )
    throw new LauncherError(
      "Select an explicit Cedar Staff packaged application under apps/staff/release.",
    );
  if (!value.nodePath.toLowerCase().endsWith(`${sep}node.exe`))
    throw new LauncherError(
      "Select the installed Node.js executable, not a shell or downloader.",
    );
  return Object.freeze({
    version: 1,
    demoMode: true,
    runtimeDirectory: resolve(value.runtimeDirectory),
    nodePath: resolve(value.nodePath),
    appPath: resolve(value.appPath),
  });
}

export async function readLauncherConfig(path = launcherConfigPath) {
  try {
    return validateLauncherConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof LauncherError) throw error;
    throw new LauncherError(
      "Launcher settings could not be read. Run the one-time shortcut setup; no account setup or database reset is needed.",
    );
  }
}

export async function checkLauncherFiles(config) {
  const requirements = [
    [
      config.nodePath,
      "The configured Node.js executable is missing. Reinstall/update the launcher target manually; nothing is downloaded automatically.",
    ],
    [
      config.appPath,
      "The selected packaged Cedar Staff application is missing. Build/select that package and update the shortcut settings.",
    ],
    [
      join(resolve(config.appPath, ".."), "resources", "app.asar"),
      "The selected application package is incomplete. Rebuild/select a complete Windows package.",
    ],
    [
      join(config.runtimeDirectory, "ready.json"),
      "The existing staff runtime is missing its readiness marker. Ask the operator to check the intended runtime; the launcher does not run prepare or bootstrap.",
    ],
    [
      join(config.runtimeDirectory, "authority.dpapi"),
      "The existing protected staff configuration is missing. Check the configured runtime path; do not recreate keys or accounts.",
    ],
    [
      join(config.runtimeDirectory, "replica.key"),
      "The existing replica-set key file is missing. Ask the operator to check the configured runtime.",
    ],
    [
      serverEntry,
      "The staff API source is missing. Restore the reviewed project checkout.",
    ],
  ];
  for (const [path, message] of requirements) {
    try {
      await access(path);
    } catch {
      throw new LauncherError(message);
    }
  }
  const actual = await realpath(config.appPath);
  if (
    !actual
      .toLowerCase()
      .startsWith(
        (resolve(projectRoot, "apps", "staff", "release") + sep).toLowerCase(),
      )
  )
    throw new LauncherError(
      "The application target resolves outside the approved package directory.",
    );
}

export function childEnvironment(runtimeDirectory) {
  const environment = {};
  const allowed =
    /^(PATH|SYSTEMROOT|WINDIR|USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|PROGRAMFILES|PROGRAMFILES\(X86\)|COMSPEC|HOMEDRIVE|HOMEPATH)$/i;
  for (const [key, value] of Object.entries(process.env))
    if (allowed.test(key)) environment[key] = value;
  environment.CAPSTONE_STAFF_RUNTIME_DIR = runtimeDirectory;
  environment.STAFF_API_URL = "http://127.0.0.1:4100";
  return environment;
}
