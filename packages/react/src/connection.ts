import {
  applyOp,
  type ClientMessage,
  type ColorScheme,
  type Doc,
  type Op,
  type Origin,
  type Presence,
  type ServerMessage,
} from "@ponzu/core";

/**
 * Where the canvas gets its document and sends edits. The studio uses a
 * WebSocket to `ponzu serve`; a host app can implement this over anything.
 */
export interface CanvasSource {
  subscribe(listener: (state: CanvasState) => void): () => void;
  getState(): CanvasState;
  apply(op: Op): void;
  undo(): void;
  redo(): void;
  /** Base URL for this design's assets/ folder. */
  assetBase?: string;
  /** Upload a file into assets/, returning its relative path. */
  upload?(file: File): Promise<string>;
  /** Tell the host how the canvas looks, so agents can see artboards that way. */
  setTheme?(theme: ColorScheme): void;
  /** Each change as it lands, with who made it and the doc after it: for motion. */
  onOp?(listener: (op: Op, origin: Origin, doc: Doc) => void): () => void;
}

export interface CanvasState {
  status: "connecting" | "ready" | "offline" | "error";
  doc: Doc | null;
  path: string;
  presence: Presence[];
  canUndo: boolean;
  canRedo: boolean;
  /** Artboard the server asked us to show (after an agent created it). */
  focus?: { artboard: string; page: string; at: number };
  /** Last change and who made it, for the activity indicator. */
  lastOrigin?: Origin;
  error?: string;
}

type Listener = (s: CanvasState) => void;

/** A CanvasSource backed by `ponzu serve` over WebSocket, with reconnect. */
export class SocketSource implements CanvasSource {
  private state: CanvasState;
  private listeners = new Set<Listener>();
  private opListeners = new Set<(op: Op, origin: Origin, doc: Doc) => void>();
  private socket: WebSocket | null = null;
  private req = 0;
  private retry = 0;
  private closed = false;
  private theme?: ColorScheme;
  readonly assetBase: string;

  /**
   * `watch` only listens: the home screen's live cards show a design without
   * editing it or counting as an open canvas.
   */
  constructor(
    private origin: string,
    readonly file: string,
    private opts: { watch?: boolean } = {},
  ) {
    this.state = {
      status: "connecting",
      doc: null,
      path: file,
      presence: [],
      canUndo: false,
      canRedo: false,
    };
    this.assetBase = `${origin}/files/${encodeURIComponent(file)}`;
    this.connect();
  }

  private connect() {
    const watch = this.opts.watch ? "&watch=1" : "";
    const url = `${this.origin.replace(/^http/, "ws")}/ws?file=${encodeURIComponent(this.file)}${watch}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
    socket.onopen = () => {
      this.retry = 0;
      if (this.theme) this.send({ t: "theme", theme: this.theme });
    };
    socket.onclose = () => {
      if (this.closed) return;
      // Who's here is unknown until we're back; hello brings it again.
      this.set({ status: "offline", presence: [] });
      const delay = Math.min(5000, 250 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case "hello":
        this.set({
          status: "ready",
          doc: msg.doc,
          path: msg.path,
          presence: msg.presence,
          canUndo: msg.canUndo,
          canRedo: msg.canRedo,
        });
        break;
      case "op": {
        const doc = this.state.doc;
        if (!doc) return;
        // Ops from this client were applied optimistically; the server echoes
        // every op, so apply on a fresh copy only if it isn't already reflected.
        const next = structuredClone(doc);
        try {
          applyOp(next, msg.op);
        } catch {
          return;
        }
        for (const l of this.opListeners) l(msg.op, msg.origin, next);
        this.set({ doc: next, canUndo: msg.canUndo, canRedo: msg.canRedo, lastOrigin: msg.origin });
        break;
      }
      case "reset":
        this.set({ doc: msg.doc });
        break;
      case "presence":
        this.set({ presence: msg.presence });
        break;
      case "focus":
        this.set({ focus: { artboard: msg.artboard, page: msg.page, at: Date.now() } });
        break;
      case "error":
        this.set({ error: msg.message });
        break;
    }
  }

  private send(msg: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private set(patch: Partial<CanvasState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState() {
    return this.state;
  }

  onOp(listener: (op: Op, origin: Origin, doc: Doc) => void) {
    this.opListeners.add(listener);
    return () => this.opListeners.delete(listener);
  }

  // Edits go to the server, which applies them and echoes the op back.
  // Round trips on localhost are ~1ms, so we skip optimistic application
  // and avoid ever diverging from the file on disk.
  apply(op: Op) {
    this.send({ t: "op", req: ++this.req, op });
  }

  undo() {
    this.send({ t: "undo", req: ++this.req });
  }

  redo() {
    this.send({ t: "redo", req: ++this.req });
  }

  setTheme(theme: ColorScheme) {
    if (this.opts.watch || theme === this.theme) return;
    this.theme = theme;
    this.send({ t: "theme", theme });
  }

  async upload(file: File): Promise<string> {
    const body = new FormData();
    body.set("file", file);
    const res = await fetch(`${this.assetBase}/upload`, { method: "POST", body });
    if (!res.ok) throw new Error(await res.text());
    return ((await res.json()) as { path: string }).path;
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}

/**
 * A source that shows another without ever changing it: edits, undo and redo
 * go nowhere. A read-only canvas wraps its source in one, so no control it
 * missed can write.
 */
export function viewOnly(source: CanvasSource): CanvasSource {
  return {
    subscribe: (listener) => source.subscribe(listener),
    getState: () => source.getState(),
    apply() {},
    undo() {},
    redo() {},
    assetBase: source.assetBase,
    setTheme: source.setTheme ? (theme) => source.setTheme?.(theme) : undefined,
    onOp: source.onOp ? (listener) => source.onOp!(listener) : undefined,
  };
}

/** A CanvasSource over a plain doc in memory, for hosts that own state. */
export class MemorySource implements CanvasSource {
  private state: CanvasState;
  private listeners = new Set<Listener>();
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  readonly assetBase?: string;

  /** `assetBase` is where the design's assets/ live, such as a raw GitHub URL at one commit. */
  constructor(
    doc: Doc,
    private onChange?: (doc: Doc, op: Op) => void,
    opts: { assetBase?: string } = {},
  ) {
    this.assetBase = opts.assetBase;
    this.state = {
      status: "ready",
      doc,
      path: doc.name,
      presence: [],
      canUndo: false,
      canRedo: false,
    };
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  getState() {
    return this.state;
  }

  private commit(op: Op, stack: "undo" | "redo" | "new") {
    const doc = structuredClone(this.state.doc!);
    const inverse = applyOp(doc, op);
    if (stack === "redo") this.redoStack.push(inverse);
    else {
      this.undoStack.push(inverse);
      if (stack === "new") this.redoStack = [];
    }
    this.state = {
      ...this.state,
      doc,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
    for (const l of this.listeners) l(this.state);
    this.onChange?.(doc, op);
  }

  apply(op: Op) {
    this.commit(op, "new");
  }

  undo() {
    const op = this.undoStack.pop();
    if (op) this.commit(op, "redo");
  }

  redo() {
    const op = this.redoStack.pop();
    if (op) this.commit(op, "undo");
  }
}
