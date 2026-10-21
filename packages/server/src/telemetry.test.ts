import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RenderError, type Renderer } from "@ponzu/render";
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

test("a crash carries a coarse reason, never the message", async () => {
  const events: Record<string, unknown>[] = [];
  let fail: () => never = () => {
    throw new Error("n_secret broke in /Users/someone/client.design");
  };
  const failing = new LocalWorkspace({
    cwd: dir,
    previews: false,
    renderer: { render: async () => fail(), close: async () => {} } as Renderer,
    telemetry: {
      capture: (_event, properties) => events.push(properties ?? {}),
      feedback: async () => false,
    },
  });
  const file = await runTool(
    getTool("create_file")!,
    { path: "reasons.design" },
    { ws: failing, caller },
  );
  expect(file.isError).toBeFalsy();
  const ab = await runTool(
    getTool("create_artboard")!,
    { name: "A", width: 400, height: 300 },
    { ws: failing, caller },
  );
  const id = (ab.data as { id: string }).id;
  events.length = 0;
  const shoot = (args: Record<string, unknown> = {}) =>
    runTool(getTool("screenshot")!, { id, ...args }, { ws: failing, caller });

  // A stuck render host: its own words reach the agent, and its class reaches telemetry.
  fail = () => {
    throw new RenderError("Ponzu's renderer didn't answer within 60s.", "host_unresponsive");
  };
  expect((await shoot()).text).toBe("Ponzu's renderer didn't answer within 60s.");
  fail = () => {
    throw new RenderError("The render stalled loading the page.", "timeout", "load");
  };
  await shoot();
  // Anything else is unknown, and its message stays out of telemetry.
  fail = () => {
    throw new Error("n_secret broke in /Users/someone/client.design");
  };
  expect((await shoot()).text).toStartWith("screenshot failed:");
  // A hover id that isn't there is the agent's to fix, and never reaches the renderer.
  await shoot({ hover: "n_nope" });

  expect(events.map((e) => [e.outcome, e.error_class, e.stage])).toEqual([
    ["crash", "host_unresponsive", undefined],
    ["crash", "timeout", "load"],
    ["crash", "unknown", undefined],
    ["mistake", "invalid_target", undefined],
  ]);
  const sent = JSON.stringify(events);
  for (const word of ["n_secret", "/Users/someone", "n_nope", "didn't answer"])
    expect(sent).not.toContain(word);
  await failing.closeAll();
});

test("lint without its image still counts as a crash", async () => {
  const events: Record<string, unknown>[] = [];
  const partial = new LocalWorkspace({
    cwd: dir,
    previews: false,
    renderer: {
      render: async () => ({
        bytes: new Uint8Array(),
        mime: "",
        width: 400,
        height: 300,
        contentHeight: 300,
        issues: [],
        captureError: "The render stalled capturing the image (stopped after 20s).",
      }),
      close: async () => {},
    } as Renderer,
    telemetry: {
      capture: (_event, properties) => events.push(properties ?? {}),
      feedback: async () => false,
    },
  });
  await runTool(getTool("create_file")!, { path: "partial.design" }, { ws: partial, caller });
  const ab = await runTool(
    getTool("create_artboard")!,
    { name: "A", width: 400, height: 300 },
    { ws: partial, caller },
  );
  events.length = 0;
  const r = await runTool(
    getTool("screenshot")!,
    { id: (ab.data as { id: string }).id },
    { ws: partial, caller },
  );
  expect(r.text).toContain("Lint: clean.");
  expect(events[0]).toMatchObject({
    outcome: "crash",
    error_class: "capture_failed",
    stage: "capture",
  });
  await partial.closeAll();
});
