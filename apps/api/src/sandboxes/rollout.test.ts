import { expect, test } from "bun:test";
import type { CheckpointCover, SandboxImage, SandboxRow } from "@ponzu/db";
import { rollout } from "./rollout.ts";

const NOW = `ponzu-runner@sha256:${"b".repeat(64)}`;
const OLD = `ponzu-runner@sha256:${"a".repeat(64)}`;

function row(
  canvasId: string,
  sandbox: Partial<SandboxRow>,
  { status = "active", client = null }: { status?: string; client?: string | null } = {},
): SandboxImage {
  return {
    sandbox: { canvasId, state: "asleep", image: OLD, ...sandbox } as SandboxRow,
    canvasStatus: status as SandboxImage["canvasStatus"],
    client,
  };
}

test("each canvas's sandbox says what its next wake does about the image this build ships", () => {
  const sandboxes = [
    // As Vercel reports it, with its full repository path: the digest is what counts.
    row("current", { image: `team/project/${NOW}` }, { client: "runner/0.1.0" }),
    row("asleep", {}),
    row("never_woke", { image: null }),
    row("awake", { state: "awake" }),
    row("behind", {}),
    row("never_saved", {}),
    row("settled", {}, { status: "settled" }),
  ];
  const covers = new Map<string, CheckpointCover>([
    ["asleep", "covered"],
    ["awake", "covered"],
    ["behind", "behind"],
    ["never_saved", "none"],
  ]);
  const rows = rollout(sandboxes, covers, { image: NOW });
  expect(rows.map((r) => [r.canvasId, r.next])).toEqual([
    ["current", "current"],
    ["asleep", "recreates"],
    ["never_woke", "current"],
    ["awake", "recreates_after_sleep"],
    ["behind", "recreates_after_a_checkpoint"],
    ["never_saved", "stays_no_checkpoint"],
    ["settled", "retired"],
  ]);
  expect(rows[0]).toMatchObject({ client: "runner/0.1.0" });
});
