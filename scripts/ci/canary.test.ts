/**
 * The canary against the client's fake backend (packages/client/src/testing): the same `Api` the
 * real run gets from `createApi(session)`, with the agent and the sandbox played by the test.
 * The clock is the test's: each wait the canary makes moves the world one step, so nothing
 * sleeps.
 */
import { describe, expect, test } from "bun:test";
import { createFakeBackend, type FakeBackend } from "../../packages/client/src/testing/backend.ts";
import { FakeClock } from "../../packages/client/src/testing/clock.ts";
import { canary, EFFORT, MODEL } from "./canary.ts";

interface World {
  fake: FakeBackend;
  api: ReturnType<FakeBackend["connect"]>["api"];
  sandbox: Map<string, string | null>;
  crons: number;
  /** What the agent and the sandbox do between two of the canary's polls. */
  step: () => void;
}

function world(
  opts: {
    claude?: "api_key" | "subscription" | null;
    workspaces?: "alone" | "two" | "shared" | "others_personal";
    agent?: "answers" | "silent" | "never_sleeps";
  } = {},
): World {
  const fake = createFakeBackend({ clock: new FakeClock(Date.parse("2026-11-13T12:00:00Z")) });
  const check = fake.addPerson({ login: "ponzu-check" });
  const other = fake.addPerson({ login: "someone" });
  const members: Record<string, "admin" | "member"> = { [check.id]: "admin" };
  if (opts.workspaces === "shared") members[other.id] = "member";
  fake.addWorkspace({ login: "ponzu-check", kind: "personal", members });
  if (opts.workspaces === "two")
    fake.addWorkspace({ login: "acme", members: { [check.id]: "member", [other.id]: "admin" } });
  if (opts.workspaces === "others_personal")
    fake.addWorkspace({
      login: "someone",
      kind: "personal",
      members: { [check.id]: "member", [other.id]: "admin" },
    });
  const claude = opts.claude === undefined ? "api_key" : opts.claude;
  if (claude) fake.claude.connect(check.id, claude);
  const { api } = fake.connect(check);
  const sandbox = new Map<string, string | null>();
  const w: World = {
    fake,
    api,
    sandbox,
    crons: 0,
    step() {
      for (const canvas of fake.canvases.values()) {
        const agent = fake.agent(canvas.id);
        const items = canvas.thread.map((entry) => entry.item);
        const said = items.filter((item) => item.kind === "message").length;
        const answered = items.filter((item) => item.kind === "assistant").length;
        if (opts.agent === "silent") continue;
        if (said > answered) {
          // A message wakes the sandbox, and the agent answers it.
          sandbox.set(canvas.id, "awake");
          agent.say(said === 1 ? "ready" : "again");
          agent.idle();
        } else if (w.crons > 0 && canvas.agent.state === "idle" && opts.agent !== "never_sleeps") {
          sandbox.set(canvas.id, "asleep");
        }
      }
    },
  };
  return w;
}

async function run(w: World, overrides: Partial<Parameters<typeof canary>[0]> = {}) {
  let now = 0;
  const lines: string[] = [];
  const marks = await canary({
    api: w.api,
    sandboxState: async (id) => w.sandbox.get(id) ?? null,
    cron: async () => {
      w.crons++;
    },
    now: () => now,
    wait: async (ms) => {
      now += ms;
      w.step();
    },
    log: (line) => lines.push(line),
    ...overrides,
  });
  return { marks, lines };
}

describe("the canary", () => {
  test("makes a canvas on Haiku, hears Claude, sleeps the sandbox, wakes it, and deletes it", async () => {
    const w = world();
    const created: unknown[] = [];
    const create = w.api.canvases.create;
    w.api.canvases.create = async (body) => {
      created.push(body);
      return create(body);
    };
    const { marks, lines } = await run(w);
    expect(Object.keys(marks)).toEqual([
      "the check account is alone in its workspace, on an API key",
      "canvas made with its first message",
      "Claude answered",
      "agent idle",
      "sandbox asleep",
      "second message sent",
      "sandbox woken",
      "Claude answered again",
      "canvas deleted",
    ]);
    // Scratch (no repo), on the cheapest model at its lowest effort.
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ model: MODEL, effort: EFFORT });
    expect((created[0] as { repoId?: unknown }).repoId).toBeUndefined();
    expect(MODEL).toBe("claude-haiku-5-5");
    expect(EFFORT).toBe("low");
    expect(w.crons).toBeGreaterThan(0);
    expect(w.fake.canvases.size).toBe(0);
    expect(lines.some((line) => /^canvas \S+$/.test(line))).toBe(true);
  });

  test("refuses an account that is not alone in its own workspace, before making anything", async () => {
    const w = world({ workspaces: "shared" });
    await expect(run(w)).rejects.toThrow("personal workspace has other members");
    expect(w.fake.canvases.size).toBe(0);
  });

  test("works in its personal workspace alone when the account can see another", async () => {
    const w = world({ workspaces: "two" });
    const created: { workspaceId?: string }[] = [];
    const create = w.api.canvases.create;
    w.api.canvases.create = async (body) => {
      created.push(body);
      return create(body);
    };
    await run(w);
    const me = await w.api.me();
    const personal = me.workspaces.find((x) => x.kind === "personal");
    expect(me.workspaces.length).toBe(2);
    expect(created.map((c) => c.workspaceId)).toEqual([personal?.id]);
    expect(w.fake.canvases.size).toBe(0);
  });

  test("never counts or opens another person's personal workspace it can see", async () => {
    const w = world({ workspaces: "others_personal" });
    const opened: string[] = [];
    const get = w.api.workspaces.get;
    w.api.workspaces.get = async (id) => {
      opened.push(id);
      return get(id);
    };
    const created: { workspaceId?: string }[] = [];
    const create = w.api.canvases.create;
    w.api.canvases.create = async (body) => {
      created.push(body);
      return create(body);
    };
    await run(w);
    const me = await w.api.me();
    const own = me.workspaces.find((x) => x.githubLogin === "ponzu-check");
    expect(me.workspaces.filter((x) => x.kind === "personal").length).toBe(2);
    expect(opened).toEqual([own!.id]);
    expect(created.map((c) => c.workspaceId)).toEqual([own!.id]);
  });

  test("never runs on a subscription or with no Claude, and never connects one", async () => {
    for (const claude of ["subscription", null] as const) {
      const w = world({ claude });
      await expect(run(w)).rejects.toThrow("is not an API key");
      expect(w.fake.canvases.size).toBe(0);
      expect((await w.api.claude.get()).account?.kind ?? null).toBe(claude);
    }
  });

  test("a silent agent or a sandbox that never sleeps fails it, and the canvas is still deleted", async () => {
    const silent = world({ agent: "silent" });
    await expect(run(silent)).rejects.toThrow("Gave up waiting for Claude's first answer.");
    expect(silent.fake.canvases.size).toBe(0);
    const awake = world({ agent: "never_sleeps" });
    await expect(run(awake)).rejects.toThrow("Gave up waiting for the sandbox to sleep.");
    expect(awake.fake.canvases.size).toBe(0);
  });
});
