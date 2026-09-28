const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("redfish", {
  request: (args) => ipcRenderer.invoke("redfish:request", args),
  save: (args) => ipcRenderer.invoke("redfish:save", args),
  find: (args) => ipcRenderer.invoke("redfish:find", args),
  findStop: () => ipcRenderer.send("redfish:find-stop"),
  onFound: (cb) => ipcRenderer.on("redfish:found", (_e, result) => cb(result)),
  onFindOpen: (cb) => ipcRenderer.on("redfish:find-open", () => cb()),
});
