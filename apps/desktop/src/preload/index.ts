import { contextBridge, ipcRenderer } from "electron";

// Every call is enumerated. Do not add a generic invoke(channel, ...) bridge —
// that hands the renderer the whole main process. getStatus() below returns
// presence booleans only (ingestTokenPresent, upstreamKeyPresent); the actual
// PAT and provider API key never cross this bridge in either direction.
contextBridge.exposeInMainWorld("tokenops", {
  getStats: () => ipcRenderer.invoke("tokenops:stats"),
  getStatus: () => ipcRenderer.invoke("tokenops:status"),
  openDashboard: (url: string) => ipcRenderer.send("tokenops:open-dashboard", url),
  openConfigFolder: () => ipcRenderer.send("tokenops:open-config"),
});
