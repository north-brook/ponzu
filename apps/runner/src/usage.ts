import { existsSync, readFileSync } from "node:fs";
import type { ModelUsage } from "./api/protocol.ts";
import { writeDurably } from "./durable.ts";

const FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const;

/**
 * Turns Claude Code's running totals into what each turn used. Every result carries the
 * session's totals so far, by model, and a resumed session starts from the totals it saved, so
 * a turn's use is the difference from the totals the last turn reported. Those are kept on
 * disk beside the session, for the first turn after a restart.
 *
 * After a crash Claude Code restores the totals it saved at its last clean exit, which can be
 * less than the last turn reported: the difference is then counted as nothing, not as less
 * than nothing, and that turn is undercounted.
 */
export class UsageMeter {
  private session: string | null = null;
  private totals = new Map<string, ModelUsage>();

  constructor(private readonly path: string) {}

  /** What this turn used, by model, leaving out models it did not use. */
  turn(sessionId: string, running: ModelUsage[]): ModelUsage[] {
    if (this.session !== sessionId) this.load(sessionId);
    const used: ModelUsage[] = [];
    for (const now of running) {
      const before = this.totals.get(now.model);
      const delta = { ...now };
      for (const field of FIELDS) delta[field] = Math.max(0, now[field] - (before?.[field] ?? 0));
      if (FIELDS.some((field) => delta[field] > 0)) used.push(delta);
      this.totals.set(now.model, now);
    }
    this.save();
    return used;
  }

  /**
   * The totals on the disk, as a checkpoint carries them (save/checkpoints.ts), when they are of
   * `sessionId`: null otherwise, or when there are none.
   */
  saved(sessionId: string): string | null {
    const saved = this.read();
    return saved?.sessionId === sessionId ? JSON.stringify(saved) : null;
  }

  /**
   * Totals a checkpoint carried, put back after the disk was found behind it. Never lowers what
   * the disk has of the same session: each count is the larger of the two, since a disk that came
   * back old has the smaller and one that holds a turn the checkpoint missed has the larger.
   * Totals of another session replace the disk's: the checkpoint is newer than the disk. Answers
   * whether the disk's totals changed.
   */
  restore(data: string): boolean {
    let carried: Saved | null;
    try {
      carried = valid(JSON.parse(data));
    } catch {
      carried = null;
    }
    if (!carried) return false;
    const disk = this.read();
    const totals = new Map<string, ModelUsage>();
    if (disk?.sessionId === carried.sessionId)
      for (const usage of disk.totals) totals.set(usage.model, usage);
    let changed = disk?.sessionId !== carried.sessionId;
    for (const usage of carried.totals) {
      const had = totals.get(usage.model);
      const next = { ...(had ?? usage) };
      for (const field of FIELDS) next[field] = Math.max(had?.[field] ?? 0, usage[field]);
      if (!had || FIELDS.some((field) => next[field] !== had[field])) changed = true;
      totals.set(usage.model, next);
    }
    if (!changed) return false;
    writeDurably(
      this.path,
      JSON.stringify({ sessionId: carried.sessionId, totals: [...totals.values()] }),
    );
    // Read again by the next turn.
    this.session = null;
    return true;
  }

  private load(sessionId: string): void {
    this.session = sessionId;
    this.totals = new Map();
    const saved = this.read();
    if (saved?.sessionId === sessionId) for (const u of saved.totals) this.totals.set(u.model, u);
  }

  /** The disk's totals, or null for a file that is missing or can't be read. */
  private read(): Saved | null {
    try {
      // A file that can't be read counts as none: the next turn is counted from zero.
      return existsSync(this.path) ? valid(JSON.parse(readFileSync(this.path, "utf8"))) : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    const totals = [...this.totals.values()];
    writeDurably(this.path, JSON.stringify({ sessionId: this.session, totals }));
  }
}

interface Saved {
  sessionId: string;
  totals: ModelUsage[];
}

/** What the totals file holds, checked: counts that are numbers, not below zero. */
function valid(value: unknown): Saved | null {
  if (typeof value !== "object" || value === null) return null;
  const { sessionId, totals } = value as Record<string, unknown>;
  if (typeof sessionId !== "string" || !Array.isArray(totals)) return null;
  const ok = totals.every(
    (u) =>
      typeof u === "object" &&
      u !== null &&
      typeof u.model === "string" &&
      FIELDS.every((field) => Number.isFinite(u[field]) && u[field] >= 0),
  );
  return ok ? { sessionId, totals: totals as ModelUsage[] } : null;
}
