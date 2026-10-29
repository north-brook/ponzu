import { contextBridge, ipcRenderer, webUtils } from "electron";

/** The small surface the studio uses when it runs inside the desktop app. */
contextBridge.exposeInMainWorld("ponzuDesktop", {
  platform: process.platform,
  openFolder: (): Promise<string | null> => ipcRenderer.invoke("ponzu:open-folder"),
  newFile: (): Promise<string | null> => ipcRenderer.invoke("ponzu:new-file"),
  reveal: (path: string) => ipcRenderer.send("ponzu:reveal", path),
  /** File > Close Tab (⌘W). The studio closes its open tab, or the window from home. */
  onCloseTab: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("ponzu:close-tab", listener);
    return () => ipcRenderer.removeListener("ponzu:close-tab", listener);
  },
  closeWindow: () => ipcRenderer.send("ponzu:close-window"),
  /** Ponzu › Pair iPhone…, including a click from before the studio was listening. */
  onPairIphone: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("ponzu:pair-iphone", listener);
    void ipcRenderer.invoke("ponzu:pair-iphone-pending").then((pending) => pending && handler());
    return () => ipcRenderer.removeListener("ponzu:pair-iphone", listener);
  },
});

/**
 * Windows and Linux: a .design folder, its design.json, or a folder holding one, dropped
 * anywhere on the window opens it, as the Mac's dock icon does. Anything else goes on to the
 * studio, which takes images. Which is which, the main process says while the drop waits.
 */
if (process.platform !== "darwin") {
  window.addEventListener(
    "dragover",
    (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    },
    true,
  );
  window.addEventListener(
    "drop",
    (e) => {
      const paths = [...(e.dataTransfer?.files ?? [])]
        .map((f) => webUtils.getPathForFile(f))
        .filter(Boolean);
      if (!paths.length) return;
      const designs = ipcRenderer.sendSync("ponzu:designs", paths) as string[];
      if (!designs.length) return;
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.send("ponzu:open-designs", designs);
    },
    true,
  );
}
