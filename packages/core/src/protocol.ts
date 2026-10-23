import type { Doc, Op } from "./doc.ts";
import type { Author } from "./types.ts";

/** Who caused a change. Disk means an outside edit picked up by the watcher. */
export type Origin = Author | { kind: "disk"; name: string };

export interface Presence {
  /** Agent or client id. */
  id: string;
  name: string;
  kind: "user" | "agent";
  /** The agent's product, for the right icon: claude, openai, other. */
  client?: string;
  /** Artboards the agent is changing, until it goes quiet or waits for activity. */
  working: string[];
  /** A few words on what it's doing, from set_status. */
  status?: string;
  /** The design (key) it last worked or listened in. */
  file?: string;
  /** Waiting in wait_for_activity right now. */
  listening?: boolean;
  /** When it last came back from wait_for_activity, to tell an iterate loop from one look. */
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
  | {
      type: "comment.edited";
      seq: number;
      thread: string;
      /** Absent for a comment on the open canvas. */
      artboard?: string;
      text: string;
      author: string;
    }
  | { type: "comment.resolved"; seq: number; thread: string; artboard?: string; author: string }
  | { type: "comment.reopened"; seq: number; thread: string; artboard?: string; author: string }
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
      canUndo: boolean;
      canRedo: boolean;
    }
  | { t: "op"; seq: number; op: Op; origin: Origin; canUndo: boolean; canRedo: boolean }
  | { t: "reset"; doc: Doc; seq: number }
  | { t: "presence"; presence: Presence[] }
  | { t: "focus"; artboard: string; page: string }
  | { t: "error"; message: string; req?: number }
  | { t: "ack"; req: number };

/** Studio → server. */
export type ClientMessage =
  | { t: "op"; req: number; op: Op }
  | { t: "undo"; req: number }
  | { t: "redo"; req: number }
  | { t: "viewport"; viewport: Viewport }
  /** The canvas's appearance, so agents render artboards the way the person sees them. */
  | { t: "theme"; theme: ColorScheme }
  /**
   * The canvas missed an op (its seq skipped one) or has one that doesn't fit its doc:
   * send the whole doc again. A watching canvas may send this too.
   */
  | { t: "sync"; reason: SyncReason };

/** Why a canvas asked for the whole doc again. */
export type SyncReason = "gap" | "apply";

export type ColorScheme = "light" | "dark";
