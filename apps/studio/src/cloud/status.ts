import type { CanvasSummary, WorkspaceKind } from "./model.ts";

/**
 * The one indicator at the end of a canvas's row. Needs you outranks working, which outranks
 * unseen: what waits on the viewer first, then what is moving, then what moved.
 */
export type RowIndicator =
  | { kind: "needs_you"; count: number }
  | { kind: "working" }
  | { kind: "unseen" };

export function rowIndicator(
  canvas: Pick<CanvasSummary, "needsYou" | "agentState" | "unseen">,
): RowIndicator | null {
  if (canvas.needsYou > 0) return { kind: "needs_you", count: canvas.needsYou };
  // A sandbox waking up is the agent getting to work: the row turns from the first moment.
  if (canvas.agentState === "working" || canvas.agentState === "waking") return { kind: "working" };
  if (canvas.unseen) return { kind: "unseen" };
  return null;
}

/**
 * What the thread toggle shows while the rail is closed, in the same order as a row. `unseen` is
 * the thread's own: the agent said something since the rail was last open.
 */
export type RailSignal = "idle" | "unseen" | "working" | { needsYou: number };

export function railSignal(
  canvas: Pick<CanvasSummary, "needsYou" | "agentState">,
  threadUnseen: boolean,
): RailSignal {
  const row = rowIndicator({ ...canvas, unseen: threadUnseen });
  if (!row) return "idle";
  return row.kind === "needs_you" ? { needsYou: row.count } : row.kind;
}

/**
 * The sidebar's order: most recent activity first. On a team, canvases waiting on the viewer rank
 * above the rest, so a question isn't buried under teammates' work.
 */
export function orderCanvases(
  canvases: CanvasSummary[],
  workspace: WorkspaceKind,
): CanvasSummary[] {
  return canvases.toSorted((a, b) => {
    if (workspace === "org") {
      const waiting = Number(b.needsYou > 0) - Number(a.needsYou > 0);
      if (waiting) return waiting;
    }
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

/** Settled canvases, most recently settled first. */
export function orderSettled(canvases: CanvasSummary[]): CanvasSummary[] {
  return canvases.toSorted((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
}

/**
 * The settled rows the sidebar shows: all of them, most recent first, while the section is
 * open; closed, only the canvas that is open in the window, if it is one of them, so the row
 * you are in is never out of sight.
 */
export function settledShown(
  canvases: CanvasSummary[],
  expanded: boolean,
  openId: string | null,
): CanvasSummary[] {
  const ordered = orderSettled(canvases);
  return expanded ? ordered : ordered.filter((canvas) => canvas.id === openId);
}
