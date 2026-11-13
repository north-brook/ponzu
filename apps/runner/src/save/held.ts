/*
 * What a checkpoint's transcript holds of the canvas's events (`heldThrough`, docs/cloud.md,
 * "Saving the sandbox"). The API counts an event delivered after `saved_through` as work the
 * checkpoint may not hold, and keeps the canvas off a new image until a later one covers it. So
 * the runner says how far its archive goes, as of the moment it was taken: never further.
 *
 * An event this process was handed is settled once it is in the session or will never go into
 * one (it is acknowledged). As an archive is about to be taken, a mark begins: every event with a
 * lower seq than the oldest one still unsettled was settled before the archive, and so is in it
 * or never needs to be. An event that settles after the mark began (one that went into a new
 * turn while the archive was being packed or uploaded) is not in it, so the mark stops below it.
 * Events delivered before this process started were settled by the process before.
 */

/** An archive's mark: read just before the checkpoint is recorded, then ended. */
export interface HeldMark {
  /** The newest event the archive holds, or undefined when nothing bounds it. */
  read(): number | undefined;
  /** Stops following what settles. Safe to repeat. */
  end(): void;
}

export class HeldEvents {
  private readonly marks = new Set<{ after: number }>();

  /** An event this process was handed went into the session, or never will. */
  settled(seq: number): void {
    for (const mark of this.marks) mark.after = Math.min(mark.after, seq);
  }

  /**
   * Begins a mark as an archive is about to be taken, with the seqs of the events handed to this
   * process and not settled yet.
   */
  begin(unsettled: Iterable<number>): HeldMark {
    let bound = Number.POSITIVE_INFINITY;
    for (const seq of unsettled) bound = Math.min(bound, seq - 1);
    const mark = { after: Number.POSITIVE_INFINITY };
    this.marks.add(mark);
    return {
      read: () => {
        const through = Math.min(bound, mark.after - 1);
        // Nothing unsettled and nothing settled since: every event delivered is in the archive,
        // which is what the API counts when it is not told.
        return Number.isFinite(through) ? Math.max(0, through) : undefined;
      },
      end: () => {
        this.marks.delete(mark);
      },
    };
  }
}
