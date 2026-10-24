import type { AgentChange, Presence } from "@ponzu/core";

/**
 * Standby, as iOS StandBy does it: it comes on by itself when an agent is
 * working in this design and the phone is set down standing (the inner
 * display, partly open, sideways) or as a tent (the outer display, on its
 * side), and goes as the phone is picked up.
 *
 * "Set down" is the phone still: gravity steady for a moment, from the
 * accelerometer. "Standing" is the inner display partly open with the
 * window wider than tall. "A tent" is the outer display lit while the hinge
 * is partly open: closed, the hinge reads closed. The app is portrait-only,
 * which the outer display keeps to, so the tent's window stays 466x678
 * (measured on the simulator, turned on its side); it's told apart by the
 * hinge, not the window's shape. All of it is the window and the hinge,
 * never the model.
 */
export function standbyPose(
  window: { width: number; height: number },
  hinge: "closed" | "partiallyOpen" | "fullyOpen" | "unknown" | null,
): boolean {
  if (hinge !== "partiallyOpen") return false;
  const inner = Math.min(window.width, window.height) >= 600;
  return inner ? window.width > window.height : true;
}

export function standbyOn(pose: boolean, still: boolean, working: boolean): boolean {
  return pose && still && working;
}

/** A phone set down: gravity within this of steady (in g) for `STILL_MS`. */
export const STILL_G = 0.04;
export const STILL_MS = 1500;

/**
 * Whether a run of gravity readings (newest last, `[t, x, y, z]`, ms and g)
 * has held steady for the last `STILL_MS`: the phone is lying or standing
 * still, not in a hand.
 */
export function isStill(samples: readonly (readonly [number, number, number, number])[]): boolean {
  const last = samples[samples.length - 1];
  if (!last) return false;
  const since = last[0] - STILL_MS;
  if (samples[0]![0] > since) return false;
  const recent = samples.filter((s) => s[0] >= since);
  for (const s of recent) {
    if (
      Math.abs(s[1] - last[1]) > STILL_G ||
      Math.abs(s[2] - last[2]) > STILL_G ||
      Math.abs(s[3] - last[3]) > STILL_G
    )
      return false;
  }
  return true;
}

/**
 * The boards standby's camera visits, in order: what agents are working on
 * in this design right now (presence `working`), or, while they go quiet
 * between edits, the boards in the newest change-log entries for this
 * design, newest first. Only boards on `page`.
 */
export function standbyPath({
  presence,
  changes,
  file,
  page,
  limit = 6,
}: {
  presence: Presence[];
  changes: AgentChange[];
  file: string;
  /** The artboard ids on the page on screen. */
  page: Set<string>;
  limit?: number;
}): string[] {
  const live = presence
    .filter((p) => p.kind === "agent" && (!p.file || p.file === file))
    .flatMap((p) => p.working)
    .filter((id) => page.has(id));
  if (live.length) return [...new Set(live)];
  const out: string[] = [];
  for (const c of [...changes].filter((c) => c.file === file).sort((a, b) => b.at - a.at))
    for (const a of c.artboards)
      if (page.has(a.id) && !out.includes(a.id) && out.length < limit) out.push(a.id);
  return out;
}

/** Whether an agent is at work in this design now. */
export function agentWorking(presence: Presence[], file: string): boolean {
  return presence.some(
    (p) => p.kind === "agent" && p.working.length > 0 && (!p.file || p.file === file),
  );
}

/** Standby's camera: a ~2s move, then a ~3s rest on each board, as the board's study. */
export const FOLLOW = { move: 2000, rest: 3000 } as const;
