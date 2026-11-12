import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeDurably } from "./durable.ts";

/*
 * The turn in flight, on the disk (docs/cloud.md, "A turn that never came"). Claude Code taking a
 * message into the session is what the runner acknowledges, and once it has, no claim hands the
 * event out again: the session holds it. A runner that dies before the turn's result (the
 * machine stopped under it, Claude Code crashed) leaves a session whose last message has no
 * answer, and a resumed Claude Code waits for a prompt rather than answering it. So the runner
 * writes down what it put in once Claude Code takes it, flushed, and clears it at the turn's
 * result; one that starts and finds it, with the session holding that message, knows the turn
 * broke off and picks it up.
 */

export interface InFlight {
  /** The uuid the message went into the session under. */
  uuid: string;
  /** The event it carried, if any. */
  event: string | null;
  /**
   * The event that began the turn it is part of (the runner's turn event), which may be an
   * earlier message's than `event`: a pickup restores this one, never the last taken in.
   */
  turn: string | null;
  /** How many times this turn has been picked up already. */
  pickups: number;
}

export class TurnMarker {
  private current: string | null = null;

  constructor(private readonly path: string) {}

  /** What the last runner on this disk had in flight, or null. */
  read(): InFlight | null {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as Partial<InFlight>;
      if (typeof value.uuid !== "string") return null;
      return {
        uuid: value.uuid,
        event: typeof value.event === "string" ? value.event : null,
        turn: typeof value.turn === "string" ? value.turn : null,
        pickups: typeof value.pickups === "number" ? value.pickups : 0,
      };
    } catch {
      return null;
    }
  }

  /** Claude Code took this in: the turn it begins is in flight. */
  write(inFlight: InFlight): void {
    const data = JSON.stringify(inFlight);
    if (data === this.current) return;
    try {
      writeDurably(this.path, data);
      this.current = data;
    } catch {
      // A disk that refuses costs only the pickup; the API's own watch still holds.
    }
  }

  /** The turn ended: nothing is in flight. */
  clear(): void {
    if (this.current === null && !existsSync(this.path)) return;
    try {
      rmSync(this.path, { force: true });
    } catch {}
    this.current = null;
  }
}
