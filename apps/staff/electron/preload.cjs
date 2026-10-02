const { contextBridge, ipcRenderer } = require('electron');

const names = ['status', 'setupStatus', 'claimSetup', 'signIn', 'enrollment', 'completeMfa', 'useBackupCode', 'acknowledgeBackupCodes', 'sessionStatus', 'activity', 'signOut', 'workspace'];
const api = Object.fromEntries(names.map(name => [name, async payload => {
  const reply = await ipcRenderer.invoke(`staff:${name}`, payload);
  if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.result;
}]));
contextBridge.exposeInMainWorld('staffApi', Object.freeze(api));
