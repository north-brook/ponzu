import { describe, expect, test } from "bun:test";
import { ApiError, type CanvasHeadRow } from "@ponzu/client";
import type { Person } from "@ponzu/client/model";
import { createFakeBackend } from "@ponzu/client/testing";
import { billingWait, chatFoot, chatItems, chatRows, revealRow, sendFailed } from "./lines";
import type { RunnerItem } from "./thread-store";

/*
 * What the chat sheet shows (lines.ts): the Mac's thread rules over the phone's thread, the
 * person's messages on their way, and the line at the foot.
 */

const maya: Person = { id: "u_maya", name: "Maya Lin", login: "maya", avatarUrl: null };
const sam: Person = { id: "u_sam", name: "Sam Ortiz", login: "sam", avatarUrl: null };
const NOW = Date.parse("2026-11-13T12:00:00Z");

let seq = 0;
const at = (s: number) => new Date(NOW - 60_000 + s * 1000).toISOString();
const from = (p: Person) => ({ id: p.id, name: p.name, login: p.login });
const message = (who: Person, text: string): RunnerItem =>
  ({
    id: `m${++seq}`,
    seq,
    at: at(seq),
    streaming: false,
    kind: "message",
    payload: { text, from: from(who) },
  }) as RunnerItem;
const reply = (text: string, streaming = false): RunnerItem =>
  ({
    id: `a${++seq}`,
    seq,
    at: at(seq),
    streaming,
    kind: "assistant",
    payload: { text },
  }) as RunnerItem;
const tool = (streaming: boolean): RunnerItem =>
  ({
    id: `t${++seq}`,
    seq,
    at: at(seq),
    streaming,
    kind: "tool",
    payload: { label: "Edited", steps: 1, artboards: [] },
  }) as RunnerItem;
const notice = (payload: object): RunnerItem =>
  ({ id: `n${++seq}`, seq, at: at(seq), streaming: false, kind: "notice", payload }) as RunnerItem;

const head = (over: Partial<CanvasHeadRow> = {}) =>
  ({
    agentState: "idle",
    agentStatus: null,
    agentBlocker: null,
    agentBlockedUntil: null,
    seq: 1,
    ...over,
  }) as CanvasHeadRow;

const context = {
  people: new Map<string, Person>(),
  assetsUrl: "https://assets.test/k/",
  doc: null,
};
const items = (thread: RunnerItem[], pending: Parameters<typeof chatItems>[0]["pending"] = []) =>
  chatItems({ items: thread, pending, openAsks: new Set(), context, me: maya });

describe("the thread's lines", () => {
  test("asides show while the turn runs, then only the answer stays; no tool lines", () => {
    const thread = [message(maya, "Go"), reply("Starting."), tool(true)];
    const running = chatRows(items(thread), head({ agentState: "working" }));
    expect(running.map((r) => [r.item.kind, Boolean(r.aside)])).toEqual([
      ["message", false],
      ["assistant", true],
    ]);
    const ended = [
      ...thread.slice(0, 2),
      { ...thread[2]!, streaming: false } as RunnerItem,
      reply("Done: three plans."),
    ];
    const done = chatRows(items(ended), head({ agentState: "idle" }));
    expect(
      done.map((r) => (r.item.kind === "assistant" ? r.item.payload.text : r.item.kind)),
    ).toEqual(["message", "Done: three plans."]);
  });

  test("avatars show once more than one person has written, on the last of each run", () => {
    const thread = [message(maya, "One"), message(maya, "Two"), message(sam, "Three")];
    const rows = chatRows(items(thread), head());
    expect(rows.map((r) => r.avatar)).toEqual([false, true, true]);
    expect(rows[1]!.continues).toBe(true);
    const alone = chatRows(items([message(maya, "Only me")]), head());
    expect(alone[0]!.avatar).toBe(false);
  });

  test("a message on its way is the person's bubble, last, marked sending, with its pictures", () => {
    const thread = [message(maya, "Go")];
    const list = items(thread, [
      {
        id: "local_1",
        text: "And this",
        at: at(99),
        pictures: [{ ref: "assets/a.png", uri: "file:///a.png", contentType: "image/png" }],
      },
    ]);
    const last = list.at(-1)!;
    expect(last.kind).toBe("message");
    if (last.kind !== "message") return;
    expect(last.payload.delivery).toBe("sending");
    expect(last.payload.from.id).toBe(maya.id);
    expect(last.payload.attachments[0]!.url).toBe("file:///a.png");
  });

  test("an open question is not in the thread: it is in the composer's place", () => {
    const thread = [
      notice({ type: "question", questionId: "q1", header: "Colour", text: "Which blue?" }),
    ];
    const open = chatItems({
      items: thread,
      pending: [],
      openAsks: new Set(["q1"]),
      context,
      me: maya,
    });
    expect(open).toEqual([]);
    const closed = chatItems({
      items: thread,
      pending: [],
      openAsks: new Set(),
      context,
      me: maya,
    });
    expect(closed.length).toBe(1);
  });

  test("a link names a message: the row at or after its seq, else the last", () => {
    const rows = chatRows(items([message(maya, "a"), reply("b"), message(maya, "c")]), head());
    expect(revealRow(rows, rows[1]!.item.seq)).toBe(1);
    expect(revealRow(rows, 10_000)).toBe(2);
  });
});

describe("the line at the foot", () => {
  const foot = (h: CanvasHeadRow | undefined, thread: RunnerItem[] = [], over = {}) =>
    chatFoot({
      items: items(thread),
      head: h,
      owner: maya,
      meId: sam.id,
      workspace: null,
      now: NOW,
      ...over,
    });

  test("working: what the agent is doing, or Thinking", () => {
    expect(foot(head({ agentState: "working", agentStatus: "Drawing the dark plans" }))).toEqual({
      kind: "working",
      text: "Drawing the dark plans",
    });
    expect(foot(head({ agentState: "working" }))).toEqual({ kind: "working", text: "Thinking" });
    expect(foot(head({ agentState: "waking" }))).toEqual({ kind: "working", text: "Waking up" });
  });

  test("a message just sent says Thinking before the agent does; nothing once it rests", () => {
    expect(
      foot(head(), [], {
        items: items(
          [],
          [{ id: "local_1", text: "Go", at: new Date(NOW).toISOString(), pictures: [] }],
        ),
      }),
    ).toEqual({ kind: "working", text: "Thinking" });
    expect(foot(head(), [message(maya, "Long ago"), reply("Answered")])).toBeNull();
  });

  test("nothing while the agent waits on a question", () => {
    expect(foot(head({ agentState: "needs_you" }))).toBeNull();
  });

  test("the sandbox: waiting for a machine, paused, failed", () => {
    expect(foot(head({ agentBlocker: "sandbox_busy" }))).toEqual({
      kind: "waiting",
      text: "Waiting for a free machine. Your messages go in as soon as one starts.",
      failed: false,
    });
    expect(foot(head({ agentBlocker: "sandbox_failed" }))?.kind).toBe("waiting");
    expect((foot(head({ agentBlocker: "sandbox_failed" })) as { failed: boolean }).failed).toBe(
      true,
    );
    expect((foot(head({ agentBlocker: "paused" })) as { text: string }).text).toContain(
      "paused while Ponzu updates",
    );
  });

  test("the owner's Claude: at its limit until a time, or not connected", () => {
    const limited = foot(
      head({ agentBlocker: "claude_limited", agentBlockedUntil: "2026-11-13T16:00:00Z" }),
    ) as { text: string };
    expect(limited.text).toStartWith("Maya's plan is at its limit until");
    expect(limited.text).toEndWith("This canvas waits.");
    expect((foot(head({ agentBlocker: "claude_not_connected" })) as { text: string }).text).toBe(
      "Maya's Claude isn't connected. This canvas waits.",
    );
  });

  test("the owner's Claude while the members aren't known yet: nothing, never 'its owner left'", () => {
    for (const blocker of ["claude_not_connected", "claude_expired", "claude_limited"] as const) {
      expect(
        foot(head({ agentBlocker: blocker, agentBlockedUntil: "2026-11-13T16:00:00Z" }), [], {
          owner: undefined,
        }),
      ).toBeNull();
    }
    // Known to be gone, it says so.
    expect(
      (
        foot(head({ agentBlocker: "claude_not_connected" }), [], { owner: null }) as {
          text: string;
        }
      ).text,
    ).toStartWith("Its owner left the workspace");
    // Not knowing the owner changes nothing else.
    expect(foot(head({ agentState: "working" }), [], { owner: undefined })).toEqual({
      kind: "working",
      text: "Thinking",
    });
  });

  test("a billing blocker before the workspace is known: only that the canvas waits", () => {
    expect(foot(head({ agentBlocker: "credits_used_up" }), [], { workspace: null })).toEqual({
      kind: "waiting",
      text: "This canvas waits.",
      failed: false,
    });
  });

  test("billing: the neutral first sentence and 'This canvas waits.', never a way to pay", () => {
    const team = { name: "Acme", personal: false };
    for (const blocker of ["credits_used_up", "cap_reached", "payment_failed"] as const) {
      const said = foot(head({ agentBlocker: blocker }), [], { workspace: team }) as {
        text: string;
      };
      expect(said.text).toEndWith("This canvas waits.");
      expect(said.text).not.toMatch(/card|pay |invoice|raise|Mac/i);
    }
    expect(billingWait("credits_used_up", { name: "Personal", personal: true })).toBe(
      "Your free credits for this month are used up. This canvas waits.",
    );
    expect(billingWait("payment_failed", team)).toBe(
      "Acme's last payment didn't go through. This canvas waits.",
    );
  });
});

describe("a send that doesn't go", () => {
  test("says so, and tapping sends again", () => {
    expect(sendFailed(new ApiError(0, "network", "offline"))).toBe(
      "Couldn't send. Tap to try again.",
    );
    expect(sendFailed(new Error("boom"))).toBe("Couldn't send. Tap to try again.");
  });

  test("a billing refusal: its first sentence and 'This canvas waits.', nothing after", () => {
    // Billing's own codes come with its gate (W6 B2); the phone reads the status alone.
    const billing = "credits_used_up" as ConstructorParameters<typeof ApiError>[1];
    const refusal = new ApiError(
      402,
      billing,
      "Acme's free credits for this month are used up. Add a card on your Mac to keep going.",
    );
    expect(sendFailed(refusal)).toBe(
      "Acme's free credits for this month are used up. This canvas waits.",
    );
    expect(sendFailed(new ApiError(402, billing, ""))).toBe("This canvas waits.");
  });

  test("the thread's foot reads the fake's own items", async () => {
    const fake = createFakeBackend();
    const person = fake.addPerson({ login: "maya", name: "Maya Lin" });
    const acme = fake.addWorkspace({
      login: "acme",
      members: { [person.id]: "admin" },
      repos: [{ name: "site" }],
    });
    const { api } = fake.connect(person);
    const canvas = await api.canvases.create({
      workspaceId: acme.id,
      repoId: acme.repos[0]!.id,
      name: "P",
    });
    await api.canvases.sendMessage(canvas.id, { text: "Go" });
    fake.agent(canvas.id).say("On it");
    const { items: thread } = await api.canvases.thread(canvas.id);
    const rows = chatRows(
      chatItems({
        items: thread as RunnerItem[],
        pending: [],
        openAsks: new Set(),
        context,
        me: maya,
      }),
      head(),
    );
    expect(rows.map((r) => r.item.kind)).toEqual(["message", "assistant"]);
  });
});
