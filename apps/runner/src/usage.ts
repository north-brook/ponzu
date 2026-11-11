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

  private load(sessionId: string): void {
    this.session = sessionId;
    this.totals = new Map();
    try {
      const saved = existsSync(this.path) && JSON.parse(readFileSync(this.path, "utf8"));
      if (saved?.sessionId === sessionId)
        for (const u of saved.totals as ModelUsage[]) this.totals.set(u.model, u);
    } catch {
      // A file that can't be read counts as none: the next turn is counted from zero.
    }
  }

  private save(): void {
    const totals = [...this.totals.values()];
    writeDurably(this.path, JSON.stringify({ sessionId: this.session, totals }));
  }
}
