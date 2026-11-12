import type { CheckpointCover, SandboxImage } from "@ponzu/db";
import { imageHold, sameImage } from "./orchestrate.ts";

/*
 * Where a rollout of a new sandbox image stands (docs/cloud.md, "How images roll out"): for each
 * canvas's sandbox, the image it runs and what its next wake will do about the image this build
 * ships (`current.json`). A wake on another image recreates the sandbox (its disk is lost and
 * the runner restores the last checkpoint), unless that checkpoint is behind. `scripts/images.ts`
 * prints it; it changes nothing.
 */

export type Next =
  /** It is on the image set now. */
  | "current"
  /** Its next wake recreates it on the image set now. */
  | "recreates"
  /** Awake or on its way: it is recreated at the first wake after it next sleeps. */
  | "recreates_after_sleep"
  /** Its next wake resumes it, since the last checkpoint is behind; a later one recreates it. */
  | "recreates_after_a_checkpoint"
  /** It stays: its runner never saved a checkpoint, so a recreate would lose what is on disk. */
  | "stays_no_checkpoint"
  /** Its canvas is settled: the sweep retires it. */
  | "retired";

export interface RolloutRow {
  canvasId: string;
  state: string;
  /** The image it runs; null before its first wake. */
  image: string | null;
  /** What its runner said it is when it last started. */
  client: string | null;
  next: Next;
}

export function rollout(
  sandboxes: SandboxImage[],
  covers: ReadonlyMap<string, CheckpointCover>,
  { image }: { image: string },
): RolloutRow[] {
  return sandboxes.map((row) => ({
    canvasId: row.sandbox.canvasId,
    state: row.sandbox.state,
    image: row.sandbox.image,
    client: row.client,
    next: nextFor(row, covers.get(row.sandbox.canvasId) ?? "none", image),
  }));
}

/** What the next wake of one sandbox does about `image`. */
export function nextFor(
  { sandbox, canvasStatus }: SandboxImage,
  cover: CheckpointCover,
  image: string,
): Next {
  if (canvasStatus === "settled") return "retired";
  if (!sandbox.image || sameImage(sandbox.image, image)) return "current";
  const hold = imageHold(cover);
  if (hold === "no_checkpoint") return "stays_no_checkpoint";
  if (sandbox.state !== "asleep") return "recreates_after_sleep";
  if (hold === "checkpoint_behind") return "recreates_after_a_checkpoint";
  return "recreates";
}
