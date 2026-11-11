import { expect, test } from "bun:test";
import type { CheckpointCover, Sandbox, SandboxImage } from "@ponzu/db";
import { rollout } from "./rollout.ts";

const NOW = "ponzu-runner-bbbbbbbbbbbb";
const OLD = "ponzu-runner-aaaaaaaaaaaa";

function row(
  designId: string,
  sandbox: Partial<Sandbox>,
  { status = "active", client = null }: { status?: string; client?: string | null } = {},
): SandboxImage {
  return {
    sandbox: {
      id: `sbx_${designId}`,
      designId,
      generation: 1,
      state: "asleep",
      image: OLD,
      imageFailed: null,
      ...sandbox,
    } as Sandbox,
    designStatus: status as SandboxImage["designStatus"],
    client,
  };
}

test("each design's sandbox says what its next wake does about the image set now", () => {
  const sandboxes = [
    row("current", { image: NOW }, { client: `runner/0.1.0+${NOW}` }),
    row("asleep", {}),
    row("unrecorded", { image: null }, { client: "runner/0.1.0" }),
    row("awake", { state: "awake" }),
    row("behind", {}),
    row("never_saved", {}),
    row("failed_move", { imageFailed: NOW }),
    row("settled", {}, { status: "settled" }),
  ];
  const covers = new Map<string, CheckpointCover>([
    ["asleep", "covered"],
    ["unrecorded", "covered"],
    ["awake", "covered"],
    ["behind", "behind"],
    ["never_saved", "none"],
    ["failed_move", "covered"],
  ]);
  const rows = rollout(sandboxes, covers, { image: NOW, maxMoves: 3 });
  expect(rows.map((r) => [r.designId, r.next])).toEqual([
    ["current", "current"],
    ["asleep", "moves"],
    ["unrecorded", "moves"],
    ["awake", "moves_after_sleep"],
    ["behind", "moves_after_a_checkpoint"],
    ["never_saved", "stays_no_checkpoint"],
    ["failed_move", "stays_image_failed"],
    ["settled", "retired"],
  ]);
  expect(rows[0]).toMatchObject({ image: NOW, runnerImage: NOW });
  expect(rows[2]).toMatchObject({ image: null, runnerImage: null });

  const off = rollout(sandboxes, covers, { image: NOW, maxMoves: 0 });
  expect(off[1]!.next).toBe("stays_moving_off");
});
