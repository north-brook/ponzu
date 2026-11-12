import type { SessionState } from "@ponzu/client";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import {
  type AnalyticsSetup,
  type BorrowedToken,
  type BridgeError,
  CHANNELS,
  type DeepLink,
  type MacNotice,
  type MenuCommand,
  type PonzuDesktop,
  type SessionPersistence,
  type SignInResult,
  type UpdateState,
} from "./bridge.ts";

/*
 * `window.ponzuDesktop`: the studio's whole view of the shell (bridge.ts). Each call is one
 * named channel with plain data; nothing of Electron or Node reaches the page.
 */

/** Hear `channel` until the returned function is called. */
function on<T>(channel: string, listener: (value: T) => void): () => void {
  const heard = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, heard);
  return () => ipcRenderer.removeListener(channel, heard);
}

/** What the main process put on the renderer's command line (window.ts's `args`). */
function argument(name: string): string {
  const prefix = `--ponzu-${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? "";
}

/** The analytics setup the main process passed, URI-encoded JSON; none when it passed none. */
function analytics(): AnalyticsSetup | null {
  const passed = argument("analytics");
  if (!passed) return null;
  try {
    return JSON.parse(decodeURIComponent(passed)) as AnalyticsSetup;
  } catch {
    return null;
  }
}

const desktop: PonzuDesktop = {
  platform: process.platform,
  glass: argument("glass") === "1",
  version: argument("version"),
  config: {
    apiUrl: argument("api"),
    client: argument("client"),
    dev: argument("dev") === "1",
    linkScheme: argument("scheme"),
    analytics: analytics(),
  },
  session: {
    state: () => ipcRenderer.invoke(CHANNELS.sessionState) as Promise<SessionState>,
    onState: (listener) => on<SessionState>(CHANNELS.sessionChanged, listener),
    persistence: () =>
      ipcRenderer.invoke(CHANNELS.sessionPersistence) as Promise<SessionPersistence>,
    accessToken: (rejected) =>
      ipcRenderer.invoke(CHANNELS.accessToken, rejected) as Promise<BorrowedToken>,
    report: (error: BridgeError) => ipcRenderer.send(CHANNELS.report, error),
    signIn: () => ipcRenderer.invoke(CHANNELS.signIn) as Promise<SignInResult>,
    signOut: () => ipcRenderer.invoke(CHANNELS.signOut) as Promise<void>,
  },
  onLink(listener) {
    const off = on<DeepLink>(CHANNELS.link, listener);
    void (ipcRenderer.invoke(CHANNELS.links) as Promise<DeepLink[]>).then((links) => {
      for (const link of links) listener(link);
    });
    // With no listener left (signed out), the main process keeps links for the next one.
    return () => {
      off();
      ipcRenderer.send(CHANNELS.linksStop);
    };
  },
  onCommand: (listener) => on<MenuCommand>(CHANNELS.command, listener),
  update: {
    state: () => ipcRenderer.invoke(CHANNELS.updateState) as Promise<UpdateState>,
    onState: (listener) => on<UpdateState>(CHANNELS.updateChanged, listener),
    check: () => ipcRenderer.send(CHANNELS.updateCheck),
    install: () => ipcRenderer.send(CHANNELS.updateInstall),
  },
  openExternal: (url) => ipcRenderer.send(CHANNELS.openExternal, url),
  comeForward: () => ipcRenderer.send(CHANNELS.comeForward),
  notifications: {
    supported: argument("notify") === "1",
    installId: argument("install"),
    deviceName: deviceName(),
    show: (notice: MacNotice) => ipcRenderer.send(CHANNELS.notifyShow, notice),
    remove: (ids) => ipcRenderer.send(CHANNELS.notifyRemove, ids),
    setBadge: (count) => ipcRenderer.send(CHANNELS.notifyBadge, count),
    onFailed: (listener) => on<string>(CHANNELS.notifyFailed, listener),
  },
  welcome1x: () => ipcRenderer.invoke(CHANNELS.welcome1x) as Promise<boolean>,
};

/** The computer's name the main process passed, URI-encoded; null when it passed none. */
function deviceName(): string | null {
  try {
    return decodeURIComponent(argument("device")) || null;
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld("ponzuDesktop", desktop);
