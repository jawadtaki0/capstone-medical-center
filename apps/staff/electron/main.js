import { app, BrowserWindow, ipcMain, protocol, net, session } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, sep } from "node:path";
import { createBroker } from "./transport.js";

const directory = dirname(fileURLToPath(import.meta.url));
const demoMode = process.argv.includes("--demo-loopback");
const apiUrl =
  process.env.STAFF_API_URL ||
  (demoMode ? "http://127.0.0.1:4100" : "https://127.0.0.1:4100");
const broker = createBroker({ url: apiUrl, demoMode });
let window;
let closing = false;
let authenticationBusy = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.enableSandbox();

function validatePayload(name, payload) {
  if (payload === undefined) return;
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    JSON.stringify(payload).length > 12000
  )
    throw new Error("Invalid action payload.");
  const fields = {
    claimSetup: ["code", "username", "password", "profile"],
    signIn: ["username", "password"],
    completeMfa: ["code"],
    useBackupCode: ["code"],
    activateAssignedAccount: ["username", "code", "password"],
    staffProfile: ["accountId"],
    createStaff: ["username", "roles", "profile"],
    updateStaffProfile: ["accountId", "expectedRevision", "profile"],
    updateOwnContact: ["expectedRevision", "address", "phone"],
    changeStaffRoles: ["accountId", "expectedVersion", "roles"],
    changeStaffStatus: ["accountId", "expectedVersion", "enabled"],
    replaceStaffSetupCode: ["accountId", "expectedVersion"],
    releaseStaffEmail: [
      "accountId",
      "expectedVersion",
      "expectedRevision",
      "confirmed",
    ],
    startVerification: ["password"],
    completeVerification: ["code", "method"],
    startContactIdentity: [
      "type",
      "destination",
      "password",
      "expectedRevision",
    ],
    completeContactIdentity: ["type", "code", "method"],
    resendContactCode: ["type"],
    cancelContactChange: ["type"],
    completeContactChange: ["type", "code"],
  }[name];
  if (!fields || Object.keys(payload).some((key) => !fields.includes(key)))
    throw new Error("Unexpected action fields.");
}

function initialize() {
  const root = resolve(directory, "..", "dist");
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "staff" || request.method !== "GET")
      return new Response("Not found", { status: 404 });
    const path = resolve(
      root,
      `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
    );
    if (!path.startsWith(root + sep))
      return new Response("Not found", { status: 404 });
    try {
      return await net.fetch(pathToFileURL(path).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );

  for (const name of Object.keys(broker).filter((name) => name !== "forget")) {
    ipcMain.handle(`staff:${name}`, async (event, payload) => {
      let ownsLock = false;
      try {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          !event.senderFrame.url.startsWith("app://staff/")
        )
          throw new Error("Untrusted application frame.");
        validatePayload(name, payload);
        if (
          [
            "claimSetup",
            "signIn",
            "activateAssignedAccount",
            "completeMfa",
            "useBackupCode",
            "acknowledgeBackupCodes",
            "startVerification",
            "completeVerification",
            "startContactIdentity",
            "completeContactIdentity",
          ].includes(name)
        ) {
          if (authenticationBusy)
            throw new Error("Wait for the current authentication action.");
          authenticationBusy = true;
          ownsLock = true;
        }
        return { ok: true, result: await broker[name](payload) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error.code || "INVALID_ACTION",
            message: error.code
              ? error.message
              : "This application action was refused.",
          },
        };
      } finally {
        if (ownsLock) authenticationBusy = false;
      }
    });
  }
  createWindow();
}

function createWindow() {
  window = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 360,
    minHeight: 500,
    title: "Cedar Staff — Development",
    backgroundColor: "#eef6fc",
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolve(directory, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    Promise.race([
      broker.signOut().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).finally(() => {
      broker.forget();
      window.destroy();
    });
  });
  window.loadURL("app://staff/index.html");
}
app
  .whenReady()
  .then(initialize)
  .catch(() => {
    console.error("The trusted staff application could not initialize.");
    app.exit(1);
  });
app.on("window-all-closed", () => app.quit());
