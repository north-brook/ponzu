import type { Doc, Op } from "./doc.ts";
import type { Author } from "./types.ts";

/** Who caused a change. Disk means an outside edit picked up by the watcher. */
export type Origin = Author | { kind: "disk"; name: string };

export interface Selection {
  /** Artboard ids or node ids. */
  ids: string[];
  page?: string;
}

export interface Presence {
  /** Agent or client id. */
  id: string;
  name: string;
  kind: "user" | "agent";
  /** The agent's product, for the right icon: claude, openai, other. */
  client?: string;
  /** Artboards the agent said it is working on. */
  working: string[];
  /** A few words on what it's doing, from start_working. */
  status?: string;
  /** The design (key) it last worked or listened in. */
  file?: string;
  /** Waiting in wait_for_activity right now. */
  listening?: boolean;
  /** When it last came back from wait_for_activity, to tell a collaborate loop from one look. */
  listenedAt?: number;
  /** Where the session comes from, for the studio's hover card. */
  origin?: PresenceOrigin;
  /** When the agent first showed up. */
  since: number;
  lastSeen: number;
}

export interface PresenceOrigin {
  /** The MCP client's own name and version, e.g. "claude-code" "2.1.0". */
  clientName?: string;
  clientVersion?: string;
  /** The agent's working directory, when it reached us through `ponzu mcp`. */
  cwd?: string;
  /** "bridge": through `ponzu mcp`. "http": straight to /mcp. */
  via?: "bridge" | "http";
}

export interface Viewport {
  page: string;
  x: number;
  y: number;
  zoom: number;
}

/** Events agents can subscribe to, and the studio listens to. */
export type PonzuEvent =
  | { type: "change"; seq: number; origin: Origin; artboards: string[]; summary: string }
  | {
      type: "comment.created";
      seq: number;
      thread: string;
      /** Absent for a comment on the open canvas. */
      artboard?: string;
      text: string;
      author: string;
    }
  | {
      type: "comment.replied";
      seq: number;
      thread: string;
      /** Absent for a comment on the open canvas. */
      artboard?: string;
      text: string;
      author: string;
    }
  | { type: "comment.resolved"; seq: number; thread: string; artboard?: string; author: string }
  | { type: "comment.reopened"; seq: number; thread: string; artboard?: string; author: string }
  | { type: "selection"; seq: number; ids: string[]; page?: string }
  | { type: "file.changed"; seq: number; path: string; artboards: string[] }
  | { type: "presence"; seq: number; presence: Presence[] };

export type EventType = PonzuEvent["type"];

/** Server → studio. */
export type ServerMessage =
  | {
      t: "hello";
      doc: Doc;
      seq: number;
      path: string;
      presence: Presence[];
      selection: Selection;
      canUndo: boolean;
      canRedo: boolean;
    }
  | { t: "op"; seq: number; op: Op; origin: Origin; canUndo: boolean; canRedo: boolean }
  | { t: "reset"; doc: Doc; seq: number }
  | { t: "presence"; presence: Presence[] }
  | { t: "selection"; selection: Selection }
  | { t: "focus"; artboard: string; page: string }
  | { t: "error"; message: string; req?: number }
  | { t: "ack"; req: number };

/** Studio → server. */
export type ClientMessage =
  | { t: "op"; req: number; op: Op }
  | { t: "select"; selection: Selection }
  | { t: "undo"; req: number }
  | { t: "redo"; req: number }
  | { t: "viewport"; viewport: Viewport };
