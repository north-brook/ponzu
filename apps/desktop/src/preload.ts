import { contextBridge, ipcRenderer } from "electron";

/** The small surface the studio uses when it runs inside the desktop app. */
contextBridge.exposeInMainWorld("ponzuDesktop", {
  platform: process.platform,
  openFolder: (): Promise<string | null> => ipcRenderer.invoke("ponzu:open-folder"),
  newFile: (): Promise<string | null> => ipcRenderer.invoke("ponzu:new-file"),
  reveal: (path: string) => ipcRenderer.send("ponzu:reveal", path),
  /** The notes of every release since the one whose notes were last shown, once per update. */
  whatsNew: (): Promise<{ version: string; notes: string[] } | null> =>
    ipcRenderer.invoke("ponzu:whats-new"),
  whatsNewSeen: () => ipcRenderer.send("ponzu:whats-new-seen"),
});
