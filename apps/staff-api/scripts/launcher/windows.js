import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { LauncherError } from "./orchestrator.js";
import { childEnvironment } from "./configuration.js";

const execute = promisify(execFile);
const powershell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

// Fixed scripts and numeric ports only. Process command lines are inspected as
// data; they are never interpolated into a shell or included in diagnostics.
export async function inspectListener(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new LauncherError("Invalid local service port.");
  const command = `$ErrorActionPreference='Stop'; $rows=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue); $items=@(); foreach($row in $rows){ $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$row.OwningProcess); $items+=@{pid=[int]$row.OwningProcess;address=$row.LocalAddress;executable=$p.ExecutablePath;commandLine=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')} }; ConvertTo-Json -InputObject $items -Compress`;
  try {
    const { stdout } = await execute(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 12000, maxBuffer: 32768 },
    );
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) throw new Error();
    return rows;
  } catch {
    throw new LauncherError(
      "Windows could not inspect the local service port safely. No listener was stopped. Retry from your signed-in desktop.",
    );
  }
}

export function expectedListener(
  rows,
  { executable, entry, arguments: arguments_ = [] },
) {
  if (!rows.length) return "absent";
  if (
    new Set(rows.map((row) => row.pid)).size !== 1 ||
    rows.some((row) => row.address !== "127.0.0.1")
  )
    return "unexpected";
  const row = rows[0];
  if (
    typeof row.executable !== "string" ||
    resolve(row.executable).toLowerCase() !==
      resolve(executable).toLowerCase() ||
    typeof row.commandLine !== "string"
  )
    return "unexpected";
  // Accept the fixed project's ordinary npm command as well as absolute paths.
  // This is operational recognition, NOT cryptographic server authentication.
  const tokens =
    row.commandLine
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((part) =>
        part.replace(/^"|"$/g, "").replaceAll("\\", "/").toLowerCase(),
      ) ?? [];
  const entries = Array.isArray(entry) ? entry : [entry];
  if (
    !entries.some((path) =>
      tokens.includes(path.replaceAll("\\", "/").toLowerCase()),
    )
  )
    return "unexpected";
  if (
    arguments_.some(
      (argument) =>
        !tokens.includes(argument.replaceAll("\\", "/").toLowerCase()),
    ) ||
    tokens.includes("--test-database")
  )
    return "unexpected";
  return "waiting";
}

export async function acquireLauncherLock(key) {
  const digest = createHash("sha256")
    .update(key.toLowerCase())
    .digest("hex")
    .slice(0, 24);
  const pipe = `\\\\.\\pipe\\cedar-staff-start-${digest}`;
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolveReady, reject) => {
    server.once("error", () =>
      reject(
        new LauncherError(
          "Cedar Staff startup is already in progress, or Windows could not reserve its startup lock. Wait for that window to finish and retry.",
        ),
      ),
    );
    server.listen(pipe, resolveReady);
  });
  return () => new Promise((resolveClose) => server.close(resolveClose));
}

export function quoteWindowsArgument(value) {
  if (typeof value !== "string" || /[\0\r\n]/.test(value))
    throw new LauncherError("Invalid shortcut argument.");
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}
export const safeProcessOptions = (runtimeDirectory) => ({
  windowsHide: true,
  shell: false,
  env: childEnvironment(runtimeDirectory),
});

// Packaged Electron is a GUI executable, not a console program. SW_HIDE also
// hides its first window on Windows; keep console suppression for workers only.
export const applicationProcessOptions = (runtimeDirectory) => ({
  ...safeProcessOptions(runtimeDirectory),
  windowsHide: false,
  detached: true,
  stdio: "ignore",
});
