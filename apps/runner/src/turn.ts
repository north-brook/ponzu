import {
  MAX_STEP_TEXT,
  MAX_TURN_GROUPS,
  type StepGroup,
  type TurnEnding,
  type WorkItem,
} from "./api/protocol.ts";
import type { Step } from "./steps.ts";

/*
 * One turn of the agent's, as the thread keeps it: a single `tool` item, opened when the turn
 * first shows something and finished when it ends, whose `turn` record says what it did, in
 * order and compactly, between the things it said. Repeats of a step after the same message are
 * one group with a count, and past `MAX_TURN_GROUPS` steps are only counted, so a turn of
 * hundreds of tool calls stays a few kilobytes.
 */
export class TurnLog {
  readonly startedAt = Date.now();
  /** The thread item this turn is written to. */
  readonly id: string;
  private groups: StepGroup[] = [];
  private listed = 0;
  private steps = 0;
  private boards = new Set<string>();
  private files = new Set<string>();
  /** The agent's latest message, and whether any step came after it. */
  private after: string | null = null;
  private stepsAfter = false;
  /** The weightiest step, which names the turn for clients that read only its label. */
  private best: { text: string; weight: number } | null = null;

  constructor(id: string) {
    this.id = id;
  }

  /** The agent said something: what it does next is listed after it. */
  said(item: string): void {
    this.after = item;
    this.stepsAfter = false;
  }

  /** A step is done. */
  add(step: Step): void {
    if (!step.done) return;
    this.steps++;
    this.stepsAfter = true;
    if (step.board) this.boards.add(step.board);
    if (step.file) this.files.add(step.file);
    if (!this.best || step.weight >= this.best.weight)
      this.best = { text: step.done, weight: step.weight };
    const text =
      step.done.length > MAX_STEP_TEXT ? `${step.done.slice(0, MAX_STEP_TEXT - 1)}…` : step.done;
    // The same step after the same message is one group, counted.
    const same = this.groups.find((g) => g.after === this.after && g.text === text);
    if (same) {
      same.count++;
      return;
    }
    if (this.listed < MAX_TURN_GROUPS) {
      this.listed++;
      this.groups.push({ after: this.after, text, count: 1 });
      return;
    }
    // Past the limit: counted, after the message they came after.
    const rest = this.groups.find((g) => g.after === this.after && g.text === null);
    if (rest) rest.count++;
    else this.groups.push({ after: this.after, text: null, count: 1 });
  }

  get stepCount(): number {
    return this.steps;
  }

  /**
   * The item's payload. While it runs `label` is the working state, for clients that show a
   * streaming `tool` item as the working line; once it ends, what it did in a few words.
   */
  payload(opts: { label: string; artboards: string[]; ended: TurnEnding | null }): WorkItem {
    const { ended } = opts;
    return {
      label: ended ? this.summary() : opts.label,
      steps: this.steps,
      artboards: opts.artboards,
      turn: {
        ended,
        ms: Date.now() - this.startedAt,
        // The answer, in full once the turn has folded: its last message, unless it went on
        // working after it (a stop, a failure) and so has none.
        final: this.stepsAfter ? null : this.after,
        boards: this.boards.size,
        files: this.files.size,
        log: this.groups.map((g) => ({ ...g })),
      },
    };
  }

  /** What the turn did, in a few words: its boards and files, or its weightiest step. */
  summary(): string {
    const parts = [
      this.boards.size ? `${this.boards.size} ${this.boards.size === 1 ? "board" : "boards"}` : "",
      this.files.size ? `${this.files.size} ${this.files.size === 1 ? "file" : "files"}` : "",
    ].filter(Boolean);
    if (parts.length) return `Worked on ${parts.join(" and ")}`;
    return this.best?.text ?? "Worked";
  }
}
