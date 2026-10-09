const { contextBridge, ipcRenderer } = require("electron");

const names = [
  "status",
  "setupStatus",
  "claimSetup",
  "signIn",
  "enrollment",
  "completeMfa",
  "useBackupCode",
  "acknowledgeBackupCodes",
  "sessionStatus",
  "activity",
  "signOut",
  "workspace",
  "activateAssignedAccount",
  "staffDirectory",
  "ownProfile",
  "staffProfile",
  "createStaff",
  "updateStaffProfile",
  "updateOwnContact",
  "changeStaffRoles",
  "changeStaffStatus",
  "replaceStaffSetupCode",
  "releaseStaffEmail",
  "startVerification",
  "completeVerification",
  "contactStatus",
  "startContactIdentity",
  "completeContactIdentity",
  "resendContactCode",
  "cancelContactChange",
  "completeContactChange",
];

const api = Object.fromEntries(
  names.map((name) => [
    name,
    (payload) => ipcRenderer.invoke(`staff:${name}`, payload),
  ]),
);
contextBridge.exposeInMainWorld("staffApi", Object.freeze(api));
