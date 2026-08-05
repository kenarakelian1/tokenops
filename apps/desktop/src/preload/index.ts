import { contextBridge, ipcRenderer } from "electron";

// Every call is enumerated. Do not add a generic invoke(channel, ...) bridge —
// that hands the renderer the whole main process. getStatus() below returns
// presence booleans only (ingestTokenPresent, upstreamKeyPresent); the actual
// PAT and provider API key never cross this bridge in either direction.
//
// openDashboard() takes no argument on purpose: the URL comes from main's own
// config (see main/ipc.ts), not from the renderer. Accepting a
// renderer-supplied URL here would let anything the renderer can construct
// reach shell.openExternal in main -- including a URL never validated against
// the http(s)-only check the rest of the app applies (main/url-safety.ts).
contextBridge.exposeInMainWorld("tokenops", {
  getStats: () => ipcRenderer.invoke("tokenops:stats"),
  getStatus: () => ipcRenderer.invoke("tokenops:status"),
  openDashboard: () => ipcRenderer.send("tokenops:open-dashboard"),
  openConfigFolder: () => ipcRenderer.send("tokenops:open-config"),
});
