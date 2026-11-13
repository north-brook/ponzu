import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import {
  CHANNELS,
  type PictureAnswer,
  type PictureHostBridge,
  type PictureRequest,
} from "./bridge.ts";

/*
 * `window.ponzuPictureHost`: all the hidden picture window (pictures.ts) gives the studio it
 * loads there. It hears a comment's picture to draw and answers it, and nothing else: no session,
 * no links, no notifications.
 */

const host: PictureHostBridge = {
  onRequest(listener) {
    ipcRenderer.on(
      CHANNELS.pictureHostRequest,
      (_event: IpcRendererEvent, id: number, request: PictureRequest) => listener(id, request),
    );
    ipcRenderer.send(CHANNELS.pictureHostReady);
  },
  answer: (id: number, answer: PictureAnswer) =>
    ipcRenderer.send(CHANNELS.pictureHostAnswer, id, answer),
};

contextBridge.exposeInMainWorld("ponzuPictureHost", host);
