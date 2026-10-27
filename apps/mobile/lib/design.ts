import {
  applyOp,
  type ClientMessage,
  type Doc,
  type Op,
  type Origin,
  type Presence,
  type ServerMessage,
} from "@ponzu/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { USER_AGENT } from "./ua";

export interface SessionState {
  status: "connecting" | "ready" | "offline";
  doc: Doc | null;
  presence: Presence[];
  error?: string;
}

type OpListener = (op: Op, origin: Origin, doc: Doc) => void;

/**
 * One open design: its socket (`/ws?file=`), and the doc as the Mac has it.
 * Mirrors the studio's SocketSource (packages/react/src/connection.ts): ops
 * apply on the server's echo, never optimistically, so the phone never shows
 * what isn't in the file. A dropped socket comes back with backoff, and the
 * new hello replaces the doc.
 */
export class DesignSession {
  private state: SessionState = { status: "connecting", doc: null, presence: [] };
  private listeners = new Set<() => void>();
  private opListeners = new Set<OpListener>();
  private docListeners = new Set<(doc: Doc) => void>();
  private socket: WebSocket | null = null;
  private req = 0;
  private retry = 0;
  private closed = false;
  private writing: string[] = [];
  private pending = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
  readonly assetBase: string;

  constructor(
    private base: string,
    readonly file: string,
  ) {
    this.assetBase = `${base}/files/${encodeURIComponent(file)}`;
    this.connect();
  }

  private connect() {
    const url = `${this.base.replace(/^http/, "ws")}/ws?file=${encodeURIComponent(this.file)}`;
    const socket = new (
      WebSocket as unknown as new (
        url: string,
        protocols: string[] | null,
        options: { headers: Record<string, string> },
      ) => WebSocket
    )(url, null, { headers: { "User-Agent": USER_AGENT } });
    this.socket = socket;
    socket.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        // Not ours.
      }
    };
    socket.onopen = () => {
      this.retry = 0;
      if (this.writing.length)
        socket.send(
          JSON.stringify({ t: "writing", threads: this.writing } satisfies ClientMessage),
        );
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      for (const p of this.pending.values()) p.reject(new Error("The Mac stopped answering"));
      this.pending.clear();
      if (this.closed) return;
      this.set({ status: "offline", presence: [] });
      const delay = Math.min(5000, 250 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case "hello":
        this.set({ status: "ready", doc: msg.doc, presence: msg.presence, error: undefined });
        for (const l of this.docListeners) l(msg.doc);
        break;
      case "op": {
        const doc = this.state.doc;
        if (!doc) return;
        const next = structuredClone(doc);
        try {
          applyOp(next, msg.op);
        } catch {
          return;
        }
        for (const l of this.opListeners)
          try {
            l(msg.op, msg.origin, next);
          } catch (err) {
            console.error("[ponzu] op listener failed:", err);
          }
        this.set({ doc: next });
        break;
      }
      case "reset":
        this.set({ doc: msg.doc });
        for (const l of this.docListeners) l(msg.doc);
        break;
      case "presence":
        this.set({ presence: msg.presence });
        break;
      case "error": {
        this.set({ error: msg.message });
        const p = msg.req !== undefined ? this.pending.get(msg.req) : undefined;
        if (p) {
          this.pending.delete(msg.req!);
          p.reject(new Error(msg.message));
        }
        break;
      }
      case "ack": {
        const p = this.pending.get(msg.req);
        if (p) {
          this.pending.delete(msg.req);
          p.resolve();
        }
        break;
      }
    }
  }

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  /** Every op as it's applied, with who made it: the canvas animates agents' work. */
  onOp(listener: OpListener) {
    this.opListeners.add(listener);
    return () => {
      this.opListeners.delete(listener);
    };
  }

  /** A whole doc: on hello (and every reconnect) and on reset. */
  onDoc(listener: (doc: Doc) => void) {
    this.docListeners.add(listener);
    return () => {
      this.docListeners.delete(listener);
    };
  }

  /** Sends an op. Resolves once the Mac has applied it, rejects with its error. */
  send(op: Op): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN)
        return reject(new Error("The Mac isn't answering"));
      const req = ++this.req;
      this.pending.set(req, { resolve, reject });
      this.socket.send(JSON.stringify({ t: "op", req, op } satisfies ClientMessage));
    });
  }

  setTheme(theme: "light" | "dark") {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ t: "theme", theme } satisfies ClientMessage));
  }

  /** The threads with an unsent reply here: the Mac's agents leave them open. Told again on reconnect. */
  setWriting(threads: string[]) {
    if (threads.join(" ") === this.writing.join(" ")) return;
    this.writing = threads;
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ t: "writing", threads } satisfies ClientMessage));
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}

/** A session for one design while the screen is mounted. */
export function useDesignSession(base: string | null, file: string): DesignSession | null {
  const [session, setSession] = useState<DesignSession | null>(null);
  useEffect(() => {
    if (!base) return;
    const s = new DesignSession(base, file);
    setSession(s);
    return () => s.close();
  }, [base, file]);
  return session;
}

const OFFLINE: SessionState = { status: "connecting", doc: null, presence: [] };

export function useSessionState(session: DesignSession | null): SessionState {
  return useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getState ?? (() => OFFLINE),
  );
}

const noopSubscribe = () => () => {};
