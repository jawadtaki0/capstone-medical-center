const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "cedarLauncher",
  Object.freeze({
    ready: () => ipcRenderer.invoke("cedar-launcher:ready"),
    cancel: () => ipcRenderer.invoke("cedar-launcher:cancel"),
    status: (callback) => {
      if (typeof callback !== "function")
        throw new Error("Invalid status callback.");
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("cedar-launcher:status", listener);
      return () =>
        ipcRenderer.removeListener("cedar-launcher:status", listener);
    },
  }),
);
