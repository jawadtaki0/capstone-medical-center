import { app, BrowserWindow, ipcMain, session } from "electron";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  readLauncherConfig,
  launcherConfigPath,
  projectRoot,
  childEnvironment,
} from "../../staff-api/scripts/launcher/configuration.js";

const directory = fileURLToPath(new URL("./", import.meta.url));
const allowedProgress = new Set([
  "Checking database",
  "Checking staff server",
  "Opening Cedar Staff",
]);
app.enableSandbox();
if (process.platform === "win32")
  app.setAppUserModelId("org.capstone.cedar.launcher");

export async function createLauncherWindow({ makeRunner } = {}) {
  let runner;
  let finished = false;
  let committing = false;
  let cancellationRequested = false;
  let lastMessage = { type: "progress", message: "Checking database" };
  const window = new BrowserWindow({
    width: 480,
    height: 345,
    minWidth: 390,
    minHeight: 325,
    resizable: false,
    maximizable: false,
    title: "Start Cedar Staff",
    icon: join(projectRoot, "apps", "staff", "assets", "cedar-staff.ico"),
    backgroundColor: "#f1f8fd",
    show: false,
    webPreferences: {
      preload: join(directory, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
    },
  });
  const publish = (message) => {
    lastMessage = message;
    if (message.type === "failure" && !window.isDestroyed())
      window.setSize(480, 440);
    if (!window.isDestroyed())
      window.webContents.send("cedar-launcher:status", message);
  };
  const cancel = () => {
    if (finished) {
      window.close();
      return;
    }
    if (committing) return;
    cancellationRequested = true;
    publish({ type: "progress", message: "Cancelling startup safely…" });
    if (runner?.connected) runner.send({ type: "cancel" }, () => {});
  };
  const trusted = (event) =>
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame;
  ipcMain.handle("cedar-launcher:cancel", (event) => {
    if (!trusted(event)) throw new Error("Unavailable action.");
    cancel();
  });
  ipcMain.handle("cedar-launcher:ready", (event) => {
    if (!trusted(event)) throw new Error("Unavailable action.");
    return lastMessage;
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.on("close", (event) => {
    if (!finished) {
      event.preventDefault();
      cancel();
    }
  });
  window.on("closed", () => {
    ipcMain.removeHandler("cedar-launcher:cancel");
    ipcMain.removeHandler("cedar-launcher:ready");
  });
  await window.loadFile(join(directory, "index.html"));
  window.show();
  const onMessage = (value) => {
    if (
      !value ||
      typeof value.message !== "string" ||
      value.message.length > 1200
    )
      return;
    if (value.type === "progress" && allowedProgress.has(value.message)) {
      if (cancellationRequested) return;
      committing = value.message === "Opening Cedar Staff";
      publish(value);
    } else if (value.type === "complete") {
      finished = true;
      publish(value);
      setTimeout(() => {
        if (!window.isDestroyed()) window.close();
      }, 600);
    } else if (value.type === "failure") {
      finished = true;
      publish(value);
    }
  };
  try {
    if (makeRunner) runner = await makeRunner();
    else {
      if (!process.argv.includes("--demo-loopback")) throw new Error("demo");
      const index = process.argv.indexOf("--config");
      const path = index >= 0 ? process.argv[index + 1] : launcherConfigPath;
      const config = await readLauncherConfig(path);
      runner = fork(
        join(projectRoot, "apps", "staff-api", "scripts", "start-staff.js"),
        ["--demo-loopback", "--config", path],
        {
          execPath: config.nodePath,
          execArgv: [],
          cwd: projectRoot,
          windowsHide: true,
          shell: false,
          env: childEnvironment(config.runtimeDirectory),
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
    }
    runner.on("message", onMessage);
    const lost = () => {
      if (!finished) {
        finished = true;
        publish({
          type: "failure",
          message:
            "The startup worker exited before completing. No unrelated service was stopped. Check the selected package/runtime and retry.",
        });
      }
    };
    runner.on("error", lost);
    runner.on("exit", lost);
    if (cancellationRequested && runner.connected)
      runner.send({ type: "cancel" }, () => {});
  } catch {
    finished = true;
    publish({
      type: "failure",
      message:
        "The launcher could not open its settings or Node.js runtime. Run the one-time shortcut setup with --demo-loopback and the intended packaged application. Nothing was downloaded or reset.",
    });
  }
  return window;
}

async function main() {
  app.setName("Cedar Staff Launcher");
  app.setPath("userData", join(projectRoot, ".local", "staff-launcher-ui"));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  let window;
  app.on("second-instance", () => {
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });
  app.on("window-all-closed", () => app.quit());
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = await createLauncherWindow();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main();
