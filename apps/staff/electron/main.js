import { whatsappUrl } from "./whatsapp.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  net,
  session,
  shell,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, sep } from "node:path";
import { writeFile } from "node:fs/promises";
import { createBroker } from "./transport.js";

const directory = dirname(fileURLToPath(import.meta.url));
const demoMode = process.argv.includes("--demo-loopback");
const apiUrl =
  process.env.STAFF_API_URL ||
  (demoMode ? "http://127.0.0.1:4100" : "https://127.0.0.1:4100");
const broker = createBroker({
  url: apiUrl,
  demoMode,
  reviewColdStart: process.argv.includes("--hosted-review"),
  hostedConnection: process.argv.includes("--hosted-capstone"),
  openWhatsApp: (phone, message) =>
    shell.openExternal(whatsappUrl(phone, message)),
});
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
if (process.platform === "win32")
  app.setAppUserModelId("org.capstone.cedar.staff");

function validatePayload(name, payload) {
  if (payload === undefined) return;
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    JSON.stringify(payload).length > 12000
  )
    throw new Error("Invalid action payload.");
  if (name === "websiteRequests") {
    const actionFields = {
      list: ["status", "date", "cursor", "query"],
      notices: ["cursor", "state"],
      bookingNoticeLookup: ["bookingId"],
      phoneVerification: ["phoneAction", "id"],
      refresh: [],
      detail: ["id"],
      markCancellationSeen: ["id"],
      link: [
        "id",
        "revision",
        "patientId",
        "patientRevision",
        "acknowledged",
        "reason",
      ],
      createPatient: ["id", "revision", "reviewDigest", "duplicateOverride"],
      notes: ["id", "revision", "notes"],
      review: ["id"],
      confirm: ["id", "revision", "booking", "patientMode"],
      reconcileBooking: [
        "id",
        "revision",
        "bookingId",
        "acknowledged",
        "reason",
      ],
      reject: ["id", "revision", "reason"],
      cancel: ["id", "revision", "reason", "privateReason"],
      rotate: ["id", "revision", "key", "reason", "confirmed"],
      notification: [
        "noticeId",
        "noticeAction",
        "language",
        "contactAcknowledged",
        "outcome",
      ],
    };
    const { action, ...rest } = payload,
      keys = actionFields[action];
    if (!keys || Object.keys(rest).some((k) => !keys.includes(k)))
      throw Error("Invalid request action fields.");
    return;
  }
  const fields = {
    operationalSummary: [],
    viewOperationalActivity: ["eventId"],
    openRequestWhatsApp: ["noticeId"],
    openStaffPhoneWhatsApp: ["accountId"],
    openPatientPhoneWhatsApp: ["id"],
    bookingSessions: ["date"],
    lab: [
      "action",
      "id",
      "revision",
      "name",
      "specimen",
      "group",
      "fields",
      "reason",
      "patientId",
      "patientRevision",
      "testIds",
      "target",
      "checked",
      "results",
      "templateRevision",
      "reviewed",
      "reportId",
      "patientNumber",
      "orderNumber",
      "phone",
      "confirmed",
      "language",
      "noticeId",
    ],
    queueTransition: [
      "date",
      "scopeId",
      "sourceSessionId",
      "sessionVersion",
      "bookingId",
      "expectedRevision",
      "idempotencyKey",
      "action",
      "reason",
      "professionalInstructed",
      "arrivedBeforeEnd",
    ],
    queueSessions: ["date"],
    queueAdmit: [
      "date",
      "scopeId",
      "sourceSessionId",
      "sessionVersion",
      "patientId",
      "patientRevision",
      "patientCreate",
      "kind",
      "reason",
      "professionalAgreed",
      "idempotencyKey",
    ],
    queueList: ["date", "scopeId", "sourceSessionId", "sessionVersion"],
    checkInPatient: [
      "date",
      "scopeId",
      "sourceSessionId",
      "sessionVersion",
      "bookingId",
      "expectedRevision",
      "idempotencyKey",
    ],
    reviewBooking: [
      "patientId",
      "patientRevision",
      "date",
      "scopeId",
      "sourceSessionId",
    ],
    confirmBooking: [
      "patientId",
      "patientRevision",
      "date",
      "scopeId",
      "sourceSessionId",
      "sessionVersion",
      "idempotencyKey",
      "noticeLanguage",
    ],
    listBookings: ["date", "scopeId", "cursor"],
    cancelBooking: ["bookingId", "reason", "publicReason"],
    affectedBookings: ["cursor"],
    searchPatients: [
      "firstName",
      "fatherName",
      "lastName",
      "motherFirstName",
      "dateOfBirth",
      "phone",
      "patientNumber",
      "cursor",
    ],
    readPatient: ["patientId"],
    checkPatientDuplicates: ["record", "patientId", "expectedRevision"],
    createPatient: ["record", "reviewDigest", "duplicateOverride"],
    updatePatient: [
      "patientId",
      "expectedRevision",
      "record",
      "reviewDigest",
      "duplicateOverride",
    ],
    operationalState: [],
    saveOperationalRecord: ["type", "record", "expectedRevision"],
    assignOperationalScopes: [
      "accountId",
      "scopeIds",
      "expectedRevision",
      "confirmed",
    ],
    publishOperationalDrafts: [
      "scopeIds",
      "expectedRevision",
      "expectedHead",
      "effectiveFrom",
      "confirmed",
    ],
    previewOperationalPublication: ["date"],
    reviewOperationalChanges: [
      "scopeIds",
      "expectedRevision",
      "expectedHead",
      "effectiveFrom",
    ],
    retryOperationalDelivery: ["deliveryId"],
    requestRecovery: ["username"],
    verifyRecovery: ["code"],
    resendRecovery: [],
    verifyRecoveryFactor: ["method", "code"],
    redeemRecovery: ["username", "handoff", "password"],
    proveRecoveryPassword: ["username", "password", "method", "code", "resume"],
    replaceRecoveryMfa: [],
    saveRecoveryPassword: ["newPassword", "confirmation"],
    recoveryEnrollment: [],
    confirmRecoveryMfa: ["code"],
    recoveryBackups: [],
    acknowledgeRecoveryBackups: [],
    recoveryStatus: [],
    cancelRecovery: [],
    assistStaffRecovery: [
      "accountId",
      "scope",
      "version",
      "identityConfirmed",
      "purpose",
      "confirmed",
    ],
    revokeStaffRecovery: ["accountId", "version", "confirmed"],
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
    startPasswordChange: ["password"],
    completePasswordIdentity: ["method", "code"],
    savePasswordChange: ["newPassword", "confirmation"],
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
            "requestRecovery",
            "verifyRecovery",
            "resendRecovery",
            "verifyRecoveryFactor",
            "redeemRecovery",
            "proveRecoveryPassword",
            "replaceRecoveryMfa",
            "saveRecoveryPassword",
            "confirmRecoveryMfa",
            "acknowledgeRecoveryBackups",
            "assistStaffRecovery",
            "revokeStaffRecovery",
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
            "startPasswordChange",
            "completePasswordIdentity",
            "savePasswordChange",
          ].includes(name)
        ) {
          if (authenticationBusy)
            throw new Error("Wait for the current authentication action.");
          authenticationBusy = true;
          ownsLock = true;
        }
        const result = await broker[name](payload);
        if (name === "lab" && result?.pdf) {
          let { pdf, filename, ...metadata } = result;
          const reviewDirectory =
            demoMode && apiUrl === "http://127.0.0.1:4101"
              ? process.env.CEDAR_LAB_PDF_DIRECTORY
              : undefined;
          const selection = await dialog.showSaveDialog(window, {
            title:
              payload.action === "preview-report"
                ? "Save preview PDF to review"
                : "Save Lab PDF",
            defaultPath: reviewDirectory
              ? resolve(reviewDirectory, filename)
              : filename,
            filters: [{ name: "PDF document", extensions: ["pdf"] }],
          });
          if (selection.canceled) return { ok: true, result: metadata };
          if (payload.action === "open-notice") {
            const latest = await broker.lab({
              ...payload,
              revision: metadata.order.revision,
            });
            if (latest.pdf !== pdf || latest.phone !== metadata.phone)
              return {
                ok: true,
                result: {
                  order: latest.order,
                  fileError:
                    "The report or verified contact changed. Open the current draft again.",
                },
              };
            ({ pdf, filename, ...metadata } = latest);
          }
          try {
            if (
              reviewDirectory &&
              dirname(resolve(selection.filePath)).toLowerCase() !==
                resolve(reviewDirectory).toLowerCase()
            )
              return {
                ok: true,
                result: {
                  ...metadata,
                  fileError:
                    "Save this fictional review PDF directly in the Capstone Lab PDFs folder.",
                },
              };
            await writeFile(selection.filePath, Buffer.from(pdf, "base64"));
          } catch {
            return {
              ok: true,
              result: {
                ...metadata,
                fileError:
                  "The PDF could not be saved. Choose a writable folder and try again.",
              },
            };
          }
          if (
            payload.action === "open-notice" &&
            apiUrl !== "http://127.0.0.1:4101"
          )
            await shell.openExternal(
              whatsappUrl(metadata.phone, metadata.message),
            );
          return {
            ok: true,
            result: { ...metadata, filename, fileSaved: true },
          };
        }
        if (
          name === "lab" &&
          payload.action === "open-notice" &&
          result?.message &&
          apiUrl !== "http://127.0.0.1:4101"
        )
          await shell.openExternal(whatsappUrl(result.phone, result.message));
        return { ok: true, result };
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
    icon: resolve(directory, "../assets/cedar-staff.ico"),
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
