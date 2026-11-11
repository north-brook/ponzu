import type { DesignSummary, WorkspaceKind } from "./model.ts";

/**
 * The one indicator at the end of a design's row. Needs you outranks working, which outranks
 * unseen: what waits on the viewer first, then what is moving, then what moved.
 */
export type RowIndicator =
  | { kind: "needs_you"; count: number }
  | { kind: "working" }
  | { kind: "unseen" };

export function rowIndicator(
  design: Pick<DesignSummary, "needsYou" | "agentState" | "unseen">,
): RowIndicator | null {
  if (design.needsYou > 0) return { kind: "needs_you", count: design.needsYou };
  // A sandbox waking up is the agent getting to work: the row turns from the first moment.
  if (design.agentState === "working" || design.agentState === "waking") return { kind: "working" };
  if (design.unseen) return { kind: "unseen" };
  return null;
}

/**
 * What the thread toggle shows while the rail is closed, in the same order as a row. `unseen` is
 * the thread's own: the agent said something since the rail was last open.
 */
export type RailSignal = "idle" | "unseen" | "working" | { needsYou: number };

export function railSignal(
  design: Pick<DesignSummary, "needsYou" | "agentState">,
  threadUnseen: boolean,
): RailSignal {
  const row = rowIndicator({ ...design, unseen: threadUnseen });
  if (!row) return "idle";
  return row.kind === "needs_you" ? { needsYou: row.count } : row.kind;
}

/**
 * The sidebar's order: most recent activity first. On a team, designs waiting on the viewer rank
 * above the rest, so a question isn't buried under teammates' work.
 */
export function orderDesigns(designs: DesignSummary[], workspace: WorkspaceKind): DesignSummary[] {
  return designs.toSorted((a, b) => {
    if (workspace === "org") {
      const waiting = Number(b.needsYou > 0) - Number(a.needsYou > 0);
      if (waiting) return waiting;
    }
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

/** Settled designs, most recently settled first. */
export function orderSettled(designs: DesignSummary[]): DesignSummary[] {
  return designs.toSorted((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
}

/**
 * The settled rows the sidebar shows: all of them, most recent first, while the section is
 * open; closed, only the design that is open in the window, if it is one of them, so the row
 * you are in is never out of sight.
 */
export function settledShown(
  designs: DesignSummary[],
  expanded: boolean,
  openId: string | null,
): DesignSummary[] {
  const ordered = orderSettled(designs);
  return expanded ? ordered : ordered.filter((design) => design.id === openId);
}
