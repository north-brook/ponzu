import { describe, expect, test } from "bun:test";
import { ApiError } from "@ponzu/client";
import type { DeepLink } from "@ponzu/desktop/bridge";
import type { Scheduler } from "./card-setups.ts";
import { BillingWall, PAID_POLL_MS } from "./wall.ts";

type SetupStatus = "waiting" | "added" | "cancelled" | "expired" | "failed";

function manualClock(): Scheduler & { advance(ms: number): Promise<void> } {
  let now = 0;
  let timers: { at: number; run: () => void }[] = [];
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return {
    now: () => now,
    after(ms, run) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    async advance(ms) {
      const until = now + ms;
      await flush();
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.run();
        await flush();
      }
      now = until;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const DETAILS = {
  workspaceId: "ws_1",
  workspaceName: "Northwind",
  canManage: true,
  capUsd: 100,
  billedCents: 10_000,
  periodEnd: "2026-12-09T00:00:00.000Z",
  invoiceUrl: null as string | null,
};

function refusal(reason: string, patch: Partial<typeof DETAILS> = {}) {
  return new ApiError(402, "billing_required", "Northwind has used this month's free credits.", {
    ...DETAILS,
    ...patch,
    reason,
  });
}

/** A wall on a fake API: what it was asked, what it opened, the app's links, and analytics. */
function world(opts: { setup?: SetupStatus[]; capError?: ApiError; gates?: string[] } = {}) {
  const clock = manualClock();
  const calls: string[] = [];
  const opened: string[] = [];
  const refreshed: string[] = [];
  const events: [string, unknown][] = [];
  const statuses = [...(opts.setup ?? ["waiting"])];
  const gates = [...(opts.gates ?? ["payment_failed"])];
  const listeners = new Set<(link: DeepLink) => void>();
  const api = {
    billing: {
      startCardSetup: async (workspaceId: string, body: { capUsd: number; source?: string }) => {
        calls.push(`start ${workspaceId} ${body.capUsd} ${body.source}`);
        return { id: "ast_1", url: "https://checkout.stripe.com/c/pay/cs_1" };
      },
      cardSetup: async () => {
        calls.push("poll");
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
        return { status, workspaceId: "ws_1" };
      },
      portal: async () => ({ url: "https://billing.stripe.com/p/1" }),
    },
    usage: {
      setCap: async (workspaceId: string, capUsd: number) => {
        calls.push(`cap ${workspaceId} ${capUsd}`);
        if (opts.capError) throw opts.capError;
        return {};
      },
      get: async () => {
        calls.push("usage");
        const gate = gates.length > 1 ? gates.shift()! : gates[0]!;
        return { billing: { gate } };
      },
    },
  } as never;
  const wall = new BillingWall({
    api,
    openExternal: (url) => opened.push(url),
    onLink: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: (id) => refreshed.push(id),
    analytics: { capture: (event: string, props?: unknown) => events.push([event, props]) },
    scheduler: clock,
  });
  let runs = 0;
  const held = { kind: "message" as const, run: () => void runs++ };
  return {
    wall,
    clock,
    calls,
    opened,
    refreshed,
    events,
    held,
    runs: () => runs,
    link: (link: DeepLink) => {
      for (const l of [...listeners]) l(link);
    },
  };
}

describe("a send at the wall", () => {
  test("anything but the 402 is left to the sender", () => {
    const w = world();
    expect(w.wall.refused(new ApiError(500, "internal", "no"), w.held)).toBe(false);
    expect(w.wall.refused(new ApiError(409, "billing_not_set_up", "no"), w.held)).toBe(false);
    expect(w.wall.getSnapshot().open).toBe(false);
    expect(w.events).toEqual([]);
  });

  test("each reason opens its own dialog", () => {
    for (const [reason, kind] of [
      ["free_used", "free_used"],
      ["cap_reached", "cap_reached"],
      ["payment_failed", "payment_failed"],
    ] as const) {
      const w = world();
      expect(w.wall.refused(refusal(reason), w.held)).toBe(true);
      expect(w.wall.getSnapshot()).toMatchObject({ open: true, dialog: { kind } });
      expect(w.wall.getSnapshot().details?.reason).toBe(reason);
      expect(w.events).toEqual([["billing dialog shown", { reason }]]);
    }
  });

  test("free credits: the card added in the browser sends the held prompt once", async () => {
    const w = world({ setup: ["waiting", "added"] });
    w.wall.refused(refusal("free_used"), w.held);
    const going = w.wall.submitCard(100);
    expect(w.wall.getSnapshot().dialog).toEqual({
      kind: "free_used",
      card: { status: "opening", error: null },
    });
    await going;
    expect(w.calls).toEqual(["start ws_1 100 wall"]);
    expect(w.opened).toEqual(["https://checkout.stripe.com/c/pay/cs_1"]);
    expect(w.wall.getSnapshot().dialog).toEqual({
      kind: "free_used",
      card: { status: "waiting", error: null },
    });
    // The return page's link and the poll: one outcome, one send.
    w.link({ kind: "card_setup", setupId: "ast_1", result: "added" });
    await w.clock.advance(4_000);
    expect(w.runs()).toBe(1);
    expect(w.refreshed).toEqual(["ws_1"]);
    expect(w.wall.getSnapshot().open).toBe(false);
    await w.clock.advance(10_000);
    w.link({ kind: "card_setup", setupId: "ast_1", result: "added" });
    await flush();
    expect(w.runs()).toBe(1);
  });

  test("a card not added keeps the prompt held and says so; the next try can still send it", async () => {
    const w = world({ setup: ["cancelled", "added"] });
    w.wall.refused(refusal("free_used"), w.held);
    await w.wall.submitCard(100);
    await w.clock.advance(2_000);
    expect(w.wall.getSnapshot().dialog).toEqual({
      kind: "free_used",
      card: { status: "idle", error: "The card wasn't added. Your prompt is still here." },
    });
    expect(w.runs()).toBe(0);
    await w.wall.submitCard(100);
    await w.clock.advance(2_000);
    expect(w.runs()).toBe(1);
  });

  test("expired says to try again", async () => {
    const w = world({ setup: ["expired"] });
    w.wall.refused(refusal("free_used"), w.held);
    await w.wall.submitCard(100);
    await w.clock.advance(2_000);
    expect(w.wall.getSnapshot().dialog).toMatchObject({
      card: { status: "idle", error: "That took too long. Try again." },
    });
  });

  test("Stripe unreachable: the API's sentence under the button", async () => {
    const w = world();
    (
      w.wall as unknown as { deps: { api: { billing: { startCardSetup: unknown } } } }
    ).deps.api.billing.startCardSetup = async () => {
      throw new ApiError(503, "upstream_unavailable", "Couldn't reach Stripe. Try again.");
    };
    w.wall.refused(refusal("free_used"), w.held);
    await w.wall.submitCard(100);
    expect(w.wall.getSnapshot().dialog).toMatchObject({
      card: { status: "idle", error: "Couldn't reach Stripe. Try again." },
    });
    expect(w.opened).toEqual([]);
  });

  test("Cancel while waiting stops asking; dismissing drops the held send and keeps nothing running", async () => {
    const w = world({ setup: ["waiting"] });
    w.wall.refused(refusal("free_used"), w.held);
    await w.wall.submitCard(100);
    w.wall.cancelCard();
    expect(w.wall.getSnapshot().dialog).toMatchObject({ card: { status: "idle", error: null } });
    await w.clock.advance(10_000);
    expect(w.calls.filter((c) => c === "poll")).toEqual([]);
    w.wall.dismiss();
    expect(w.wall.getSnapshot().open).toBe(false);
    expect(w.events.at(-1)).toEqual(["billing dialog dismissed", { reason: "free_used" }]);
    expect(w.runs()).toBe(0);
  });

  test("dismissed while waiting on the browser: a card added later sends nothing", async () => {
    const w = world({ setup: ["waiting", "added"] });
    w.wall.refused(refusal("free_used"), w.held);
    await w.wall.submitCard(100);
    w.wall.dismiss();
    await w.clock.advance(10_000);
    w.link({ kind: "card_setup", setupId: "ast_1", result: "added" });
    await flush();
    expect(w.runs()).toBe(0);
  });

  test("the cap: raised, then the held send runs once; refused, the reason shows", async () => {
    const w = world();
    w.wall.refused(refusal("cap_reached"), w.held);
    await w.wall.submitCap(200);
    expect(w.calls).toEqual(["cap ws_1 200"]);
    expect(w.runs()).toBe(1);
    expect(w.wall.getSnapshot().open).toBe(false);

    const low = world({
      capError: new ApiError(400, "cap_too_low", "The cap can't be below $150."),
    });
    low.wall.refused(refusal("cap_reached"), low.held);
    await low.wall.submitCap(120);
    expect(low.wall.getSnapshot().dialog).toEqual({
      kind: "cap_reached",
      status: "idle",
      error: "The cap can't be below $150.",
    });
    expect(low.runs()).toBe(0);
  });

  test("payment failed: Pay invoice opens Stripe's page, and the send goes once it is paid", async () => {
    const url = "https://invoice.stripe.com/i/acct_1/inv_1";
    const w = world({ gates: ["payment_failed", "ok"] });
    w.wall.refused(refusal("payment_failed", { invoiceUrl: url }), w.held);
    w.wall.payInvoice();
    expect(w.opened).toEqual([url]);
    await w.clock.advance(PAID_POLL_MS);
    expect(w.runs()).toBe(0);
    await w.clock.advance(PAID_POLL_MS);
    expect(w.runs()).toBe(1);
    expect(w.wall.getSnapshot().open).toBe(false);
    await w.clock.advance(PAID_POLL_MS * 3);
    expect(w.calls.filter((c) => c === "usage")).toHaveLength(2);
  });

  test("a member's dialogs hold the send but only say who can act", () => {
    const w = world();
    w.wall.refused(refusal("payment_failed", { canManage: false }), w.held);
    w.wall.payInvoice();
    expect(w.opened).toEqual([]);
  });

  test("Settings' Add a card holds nothing and says nothing of a prompt", async () => {
    const w = world({ setup: ["cancelled", "added"] });
    w.wall.addCard(DETAILS);
    expect(w.wall.getSnapshot().dialog?.kind).toBe("add_card");
    expect(w.events).toEqual([["billing dialog shown", { reason: "add_card" }]]);
    await w.wall.submitCard(50);
    expect(w.calls[0]).toBe("start ws_1 50 settings");
    await w.clock.advance(2_000);
    expect(w.wall.getSnapshot().dialog).toMatchObject({
      card: { error: "The card wasn't added." },
    });
    await w.wall.submitCard(50);
    await w.clock.advance(2_000);
    expect(w.wall.getSnapshot().open).toBe(false);
    expect(w.refreshed).toEqual(["ws_1"]);
  });
});

describe("a held send that comes to nothing", () => {
  test("dismissed: the sender is told it was dropped, once", () => {
    const w = world();
    let dropped = 0;
    w.wall.refused(refusal("free_used"), { ...w.held, dropped: () => void dropped++ });
    w.wall.dismiss();
    w.wall.dismiss();
    expect([dropped, w.runs()]).toEqual([1, 0]);
  });

  test("its run failing once the limit lifts is told as dropped, never left unhandled", async () => {
    const w = world();
    let dropped = 0;
    w.wall.refused(refusal("cap_reached"), {
      kind: "message",
      run: async () => {
        throw new ApiError(0, "network", "offline");
      },
      dropped: () => void dropped++,
    });
    await w.wall.submitCap(200);
    await flush();
    expect(dropped).toBe(1);
    expect(w.wall.getSnapshot().open).toBe(false);
  });

  test("payment failed with no invoice page: an admin's Pay invoice opens Stripe's portal", async () => {
    const w = world();
    w.wall.refused(refusal("payment_failed", { invoiceUrl: null }), w.held);
    await w.wall.payInvoice();
    expect(w.opened).toEqual(["https://billing.stripe.com/p/1"]);
  });
});
