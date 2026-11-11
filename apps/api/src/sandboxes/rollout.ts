import type { CheckpointCover, SandboxImage } from "@ponzu/db";
import { runnerImage } from "../runner/client.ts";
import { moveHold } from "./orchestrate.ts";

/*
 * Where a rollout of a new sandbox image stands (docs/cloud.md, "How images roll out"): for each
 * design's sandbox, the image it was made from, what its runner says it runs, and what its next
 * wake will do about the image set now. `scripts/images.ts` prints it; it changes nothing.
 */

export type Next =
  /** It is on the image set now. */
  | "current"
  /** Its next wake moves it. */
  | "moves"
  /** Awake or on its way: it moves at the first wake after it next sleeps. */
  | "moves_after_sleep"
  /** Its next wake resumes it, since the last checkpoint is behind; the one after moves it. */
  | "moves_after_a_checkpoint"
  /** It stays where it is: a move onto this image failed for it, until another is set. */
  | "stays_image_failed"
  /** It stays: its runner never saved a checkpoint, so a move would lose what is on its disk. */
  | "stays_no_checkpoint"
  /** It stays: moving is off (`PONZU_SANDBOX_MAX_MOVES=0`). */
  | "stays_moving_off"
  /** Its design is settled: the sweep destroys it. */
  | "retired";

export interface RolloutRow {
  designId: string;
  sandboxId: string;
  state: string;
  generation: number;
  /** What it was made from; null for one made before that was recorded. */
  image: string | null;
  /** What its runner says it runs; null for a runner too old to say. */
  runnerImage: string | null;
  next: Next;
}

export function rollout(
  sandboxes: SandboxImage[],
  covers: ReadonlyMap<string, CheckpointCover>,
  { image, maxMoves }: { image: string; maxMoves: number },
): RolloutRow[] {
  return sandboxes.map(({ sandbox, designStatus, client }) => {
    const row = {
      designId: sandbox.designId,
      sandboxId: sandbox.id,
      state: sandbox.state,
      generation: sandbox.generation,
      image: sandbox.image,
      runnerImage: runnerImage(client),
    };
    return { ...row, next: nextFor() };

    function nextFor(): Next {
      if (designStatus === "settled") return "retired";
      if (sandbox.image === image) return "current";
      const hold = moveHold(sandbox, image, maxMoves, covers.get(sandbox.designId) ?? "none");
      if (hold === "moving_off") return "stays_moving_off";
      if (hold === "image_failed") return "stays_image_failed";
      if (hold === "no_checkpoint") return "stays_no_checkpoint";
      if (sandbox.state !== "asleep" && sandbox.state !== "failed") return "moves_after_sleep";
      if (hold === "checkpoint_behind") return "moves_after_a_checkpoint";
      return "moves";
    }
  });
}
