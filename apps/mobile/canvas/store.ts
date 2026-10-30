/*
 * What the app has told the canvas, kept outside React so a message that lands before the first
 * render isn't lost. The app applies nothing: it relays the socket, and ops are applied here on a
 * fresh copy of the doc, as the desktop's SocketSource does.
 */
import { applyOp, type Doc, type Presence } from "@ponzu/core";
import { Arrivals } from "../../../packages/react/src/arrive.ts";
import {
  CANVAS_BRIDGE,
  type FromCanvas,
  type Insets,
  type PendingPin,
  type Theme,
  type ToCanvas,
} from "./protocol.ts";

export interface CanvasState {
  doc: Doc | null;
  assetBase?: string;
  /** The design's key: presence from other designs doesn't ring this one's boards. */
  file?: string;
  theme: Theme;
  pageId: string | null;
  presence: Presence[];
  pending: PendingPin | null;
  unsent: (PendingPin & { key: string })[];
  /** Threads with a reply left unsent. */
  writing: string[];
  /** The unsent comment whose pin is being moved, by its draft's key. */
  moving: string | null;
  /** Counts `place` asks: done moving. */
  place: number;
  thread: string | null;
  /** The last focus the app asked for; `n` tells two asks for the same board apart. */
  focus: { id: string | null; n: number } | null;
  /** Standby: the page alone, on black. */
  standby: boolean;
  /** The board standby's camera eases to, and how long it takes; `n` as `focus`. */
  follow: { id: string; ms: number; n: number } | null;
  insets: Insets;
  /** How far a sheet over the canvas rises, in px from the bottom. */
  sheet: number;
  /** The screen's corner radius, which a focused board's ring follows. */
  radius: number;
}

const listeners = new Set<() => void>();
let n = 0;

export let state: CanvasState = {
  doc: null,
  theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  pageId: null,
  presence: [],
  pending: null,
  unsent: [],
  writing: [],
  moving: null,
  place: 0,
  thread: null,
  focus: null,
  standby: false,
  follow: null,
  // The canvas's top bar and the home indicator, until the app says.
  insets: { top: 110, right: 0, bottom: 34, left: 0 },
  sheet: 0,
  // An iPhone 17 Pro's corners.
  radius: 55,
};

/** The share of gestures the canvas measures (probe.ts), as the app asked. */
let rate = 0;
export const probeRate = () => rate;

/** An agent's work develops onto the canvas, as on desktop. One per open design. */
export let arrivals = new Arrivals();

function set(patch: Partial<CanvasState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getState() {
  return state;
}

/**
 * An unsent comment's pin, moved: drawn at its new spot at once, before the app's `unsent` (with
 * the draft's new key) catches up.
 */
export function placeUnsent(key: string, pin: PendingPin) {
  set({ unsent: state.unsent.map((u) => (u.key === key ? { ...pin, key } : u)) });
}

/** The canvas changed page itself. */
export function setPage(pageId: string) {
  if (pageId !== state.pageId) set({ pageId });
}

export function receive(msg: ToCanvas) {
  switch (msg.t) {
    case "doc": {
      // The page asked for opens a design; the doc sent again (a reconnect) keeps the person's.
      const fresh = !state.doc || msg.file !== state.file;
      const keep = (fresh ? msg.page : undefined) ?? state.pageId;
      const pageId = msg.doc.pages.some((p) => p.id === keep) ? keep : null;
      if (msg.file !== state.file) arrivals = new Arrivals();
      set({ doc: msg.doc, assetBase: msg.assetBase, theme: msg.theme, file: msg.file, pageId });
      break;
    }
    case "op": {
      const doc = state.doc;
      if (!doc) return;
      const next = structuredClone(doc);
      try {
        applyOp(next, msg.op);
      } catch {
        // The app sends the doc again after a reconnect; an op that doesn't fit is dropped.
        return;
      }
      // An agent's work, and files saved straight into the design, develop; only what's new to
      // the canvas arrives. As desktop does.
      if (msg.origin?.kind === "agent" || msg.origin?.kind === "disk") {
        try {
          arrivals.add(msg.op, next, undefined, doc);
        } catch (err) {
          send({ t: "error", message: `arrival: ${String(err)}` });
        }
      }
      set({ doc: next });
      break;
    }
    case "presence":
      set({ presence: msg.presence });
      break;
    case "pending":
      set({ pending: msg.pin });
      break;
    case "unsent":
      set({ unsent: msg.pins, writing: msg.threads ?? [] });
      break;
    case "move":
      set({ moving: msg.key });
      break;
    case "place":
      set({ place: state.place + 1 });
      break;
    case "thread":
      set({ thread: msg.id });
      break;
    case "focus":
      set({ focus: { id: msg.artboardId, n: ++n } });
      break;
    case "theme":
      set({ theme: msg.theme });
      break;
    case "standby":
      set({ standby: msg.on });
      break;
    case "follow":
      set({ follow: { id: msg.artboardId, ms: msg.ms, n: ++n } });
      break;
    case "page":
      set({ pageId: msg.pageId });
      break;
    case "probe":
      rate = msg.rate;
      break;
    case "insets":
      set({
        insets: msg.insets,
        sheet: msg.sheet ?? 0,
        ...(msg.radius !== undefined ? { radius: msg.radius } : {}),
      });
      break;
  }
}

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(data: string): void };
    [CANVAS_BRIDGE]?: { receive(msg: ToCanvas): void };
  }
}

/** To the app. Outside it (the dev harness in a frame), to the page around it. */
export function send(msg: FromCanvas) {
  const data = JSON.stringify(msg);
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(data);
  else if (window.parent !== window) window.parent.postMessage(data, "*");
}

/**
 * The app's `postMessage` arrives as a message event on window on iOS (on document on Android),
 * its data the string it sent; `injectJavaScript` can call the bridge directly.
 */
export function listen() {
  const seen = new WeakSet<Event>();
  const onMessage = (e: Event) => {
    if (seen.has(e)) return;
    seen.add(e);
    const data = (e as MessageEvent).data;
    if (typeof data !== "string") return;
    let msg: ToCanvas;
    try {
      msg = JSON.parse(data) as ToCanvas;
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;
    try {
      receive(msg);
    } catch (err) {
      send({ t: "error", message: String((err as Error)?.stack ?? err) });
    }
  };
  window.addEventListener("message", onMessage);
  document.addEventListener("message", onMessage);
  window[CANVAS_BRIDGE] = { receive };
}
