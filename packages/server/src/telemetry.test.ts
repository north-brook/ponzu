import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Feedback, getTool, runTool, type ToolCaller } from "@ponzu/tools";
import { LocalWorkspace } from "./index.ts";

const caller: ToolCaller = {
  id: "agent_t",
  author: { kind: "agent", name: "Claude" },
  client: "claude",
};
const captured: { event: string; properties?: Record<string, unknown> }[] = [];
const feedback: Feedback[] = [];
let dir: string;
let ws: LocalWorkspace;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-telemetry-"));
  ws = new LocalWorkspace({
    cwd: dir,
    telemetry: {
      capture: (event, properties) => captured.push({ event, properties }),
      feedback: async (f) => {
        feedback.push(f);
        return true;
      },
    },
  });
});

afterAll(async () => {
  await ws.closeAll();
  await rm(dir, { recursive: true, force: true });
});

test("tool calls report the tool and outcome, never the arguments", async () => {
  await runTool(getTool("create_file")!, { path: "secret-client.design" }, { ws, caller });
  await runTool(getTool("get_node")!, { id: "n_missing" }, { ws, caller });
  await runTool(getTool("set_comment_status")!, { thread: 42 }, { ws, caller });
  expect(captured.map((c) => [c.properties?.tool, c.properties?.outcome])).toEqual([
    ["create_file", "ok"],
    ["get_node", "mistake"],
    ["set_comment_status", "invalid_args"],
  ]);
  expect(JSON.stringify(captured)).not.toContain("secret-client");
  expect(captured[0]!.properties).toMatchObject({ group: "organize", client: "claude" });
});

test("send_feedback hands the agent's feedback to the host", async () => {
  const res = await runTool(
    getTool("send_feedback")!,
    {
      sentiment: "negative",
      category: "confusing_tool",
      summary: "Unclear target.",
      tool: "write_html",
    },
    { ws, caller },
  );
  expect(res.isError).toBeFalsy();
  expect(res.text).toContain("Sent");
  expect(feedback).toEqual([
    {
      sentiment: "negative",
      category: "confusing_tool",
      summary: "Unclear target.",
      tool: "write_html",
      client: "claude",
    },
  ]);
});

test("send_feedback says so when telemetry is off", async () => {
  const off = new LocalWorkspace({ cwd: dir });
  const res = await runTool(
    getTool("send_feedback")!,
    { sentiment: "positive", category: "praise", summary: "Nice." },
    { ws: off, caller },
  );
  expect(res.text).toContain("Not sent");
});

test("a telemetry failure never changes a tool's result", async () => {
  const broken = new LocalWorkspace({
    cwd: dir,
    telemetry: {
      capture: () => {
        throw new Error("offline");
      },
      feedback: async () => false,
    },
  });
  const res = await runTool(getTool("list_files")!, {}, { ws: broken, caller });
  expect(res.isError).toBeFalsy();
  await broken.closeAll();
});
