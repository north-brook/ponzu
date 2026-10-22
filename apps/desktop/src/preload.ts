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
  /** File > Close Tab (⌘W). The studio closes its open tab, or the window from home. */
  onCloseTab: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("ponzu:close-tab", listener);
    return () => ipcRenderer.removeListener("ponzu:close-tab", listener);
  },
  closeWindow: () => ipcRenderer.send("ponzu:close-window"),
  /** A timelapse onto the clipboard as a file, so it pastes into a post or a chat. */
  copyFile: (path: string): Promise<void> => ipcRenderer.invoke("ponzu:copy-file", path),
});
