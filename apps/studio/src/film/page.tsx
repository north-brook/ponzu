import type { FilmShape, JournalEntry, Range } from "@ponzu/core";
import { parseJournal } from "@ponzu/core";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createEncoder, type FilmEncoder } from "./encode.ts";
import { Film } from "./Film.tsx";
import { buildFilm, type FilmModel, settleAssets } from "./model.ts";

/**
 * The film page, at /film: renders one timelapse frame-exactly for a host
 * (the server's headless Chrome, or the desktop app's offscreen window) to
 * capture, and encodes the captured frames itself with WebCodecs. Hosts
 * drive it through `window.ponzuFilm`.
 */
export interface FilmSpec {
  /** The design's key, its path on the server. */
  file: string;
  shape: FilmShape;
  length: number;
  range?: Range;
  theme: "light" | "dark";
  fps?: number;
  /** Journal text, when the host has it; otherwise fetched from the server. */
  journal?: string;
}

export interface FilmInfo {
  frames: number;
  fps: number;
  width: number;
  height: number;
  scale: number;
  duration: number;
}

declare global {
  interface Window {
    ponzuFilm?: {
      load(spec: FilmSpec): Promise<FilmInfo>;
      /** Show frame i and wait until it's fully drawn. */
      frame(i: number): Promise<void>;
      /** Show film time t (seconds). */
      seek(t: number): Promise<void>;
      /** Start encoding at the film's output size. */
      begin(): Promise<{ codec: string; mime: string }>;
      /** Hand over a captured frame (base64 PNG/JPEG) for encoding. */
      add(data: string, index: number): Promise<void>;
      /** Finish and return the video, base64. */
      finish(): Promise<{ data: string; mime: string; codec: string }>;
    };
  }
}

export async function journalText(file: string): Promise<string> {
  const res = await fetch(`/api/timelapse/journal?file=${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error(`Couldn't read the journal: ${res.status} ${await res.text()}`);
  return res.text();
}

export function startFilmPage(el: HTMLElement) {
  document.documentElement.style.background = "transparent";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  const root = createRoot(el);
  let model: FilmModel | null = null;
  let fps = 30;
  let encoder: FilmEncoder | null = null;

  const draw = async (t: number) => {
    if (!model) throw new Error("Call load first.");
    const m = model;
    flushSync(() => root.render(<Film model={m} f={t} />));
    await settleAssets(document, 6000);
    for (const host of document.querySelectorAll("[data-artboard-host]"))
      if (host.shadowRoot) await settleAssets(host.shadowRoot, 6000);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };

  window.ponzuFilm = {
    async load(spec) {
      fps = spec.fps ?? 30;
      const text = spec.journal ?? (await journalText(spec.file));
      const entries: JournalEntry[] = parseJournal(text);
      const name = nameOf(spec.file, entries);
      document.documentElement.dataset.theme = spec.theme;
      await document.fonts.load('700 40px "Funnel Display"').catch(() => {});
      await document.fonts.load('400 12px "IBM Plex Mono"').catch(() => {});
      await document.fonts.load('500 12px "Inter"').catch(() => {});
      model = await buildFilm({
        name,
        entries,
        shape: spec.shape,
        length: spec.length,
        range: spec.range,
        theme: spec.theme,
        assetBase: `${location.origin}/files/${encodeURIComponent(spec.file)}`,
      });
      (window as unknown as { __film?: FilmModel }).__film = model;
      const frames = Math.round(model.plan.duration * fps);
      await draw(0);
      return {
        frames,
        fps,
        width: Math.round(model.view.w * model.view.scale),
        height: Math.round(model.view.h * model.view.scale),
        scale: model.view.scale,
        duration: model.plan.duration,
      };
    },
    frame: (i) => draw(i / fps),
    seek: (t) => draw(t),
    async begin() {
      if (!model) throw new Error("Call load first.");
      encoder?.close();
      encoder = await createEncoder({
        width: Math.round(model.view.w * model.view.scale),
        height: Math.round(model.view.h * model.view.scale),
        fps,
      });
      return { codec: encoder.codec, mime: encoder.mime };
    },
    async add(data, index) {
      if (!encoder) throw new Error("Call begin first.");
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes]));
      try {
        await encoder.add(bitmap, index);
      } finally {
        bitmap.close();
      }
    },
    async finish() {
      if (!encoder) throw new Error("Call begin first.");
      const out = await encoder.finish();
      const e = encoder;
      encoder = null;
      return { data: toBase64(out), mime: e.mime, codec: e.codec };
    },
  };
  document.body.dataset.filmReady = "1";
}

function nameOf(file: string, entries: JournalEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "checkpoint") return e.doc.name;
    if (e.kind === "op" && e.op.op === "file.rename") return e.op.name;
  }
  return (
    file
      .split("/")
      .pop()
      ?.replace(/\.design$/, "") ?? "Untitled"
  );
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
