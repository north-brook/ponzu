/*
 * What a checkpoint's transcript holds of the canvas's events (`heldThrough`, docs/cloud.md,
 * "Saving the sandbox"). The API counts an event delivered after `saved_through` as work the
 * checkpoint may not hold, and keeps the canvas off a new image until a later one covers it. So
 * the runner says how far its archive goes, as of the moment it was taken: never further, and
 * always as a number, since the API records the call when it lands and an event that went into
 * the session while the call was on its way is not in the archive.
 *
 * An event this process was handed is settled once it is in the session or will never go into
 * one (it is acknowledged). Claims hand events out oldest first, so the session has taken in
 * everything up to the newest event this process settled, and everything up to the canvas's head
 * as of a claim that was not full (every event below it was handed to this process, or delivered
 * to the session before it started). As an archive is about to be taken, a mark begins from that
 * newest seq. It stops below the oldest event still unsettled then, and below any event that
 * settles while the archive is packed or uploaded, since that one is not in it.
 */

/** An archive's mark: read just before the checkpoint is recorded, then ended. */
export interface HeldMark {
  /** The newest event the archive holds; 0 when the runner knows of none. */
  read(): number;
  /** Stops following what settles. Safe to repeat. */
  end(): void;
}

export class HeldEvents {
  /** The newest event seq the session is known to have taken in. */
  private taken = 0;
  private readonly marks = new Set<{ after: number }>();

  /** An event this process was handed went into the session, or never will. */
  settled(seq: number): void {
    this.taken = Math.max(this.taken, seq);
    for (const mark of this.marks) mark.after = Math.min(mark.after, seq);
  }

  /**
   * A claim that was not full answered with the canvas's head `seq`: every event up to it has
   * been handed to this process (settled, or still unsettled), or was delivered before it.
   * Called once that claim's events are held.
   */
  handedThrough(seq: number): void {
    this.taken = Math.max(this.taken, seq);
  }

  /**
   * Begins a mark as an archive is about to be taken, with the seqs of the events handed to this
   * process and not settled yet.
   */
  begin(unsettled: Iterable<number>): HeldMark {
    let bound = this.taken;
    for (const seq of unsettled) bound = Math.min(bound, seq - 1);
    const mark = { after: Number.POSITIVE_INFINITY };
    this.marks.add(mark);
    return {
      read: () => Math.max(0, Math.min(bound, mark.after - 1)),
      end: () => {
        this.marks.delete(mark);
      },
    };
  }
}
