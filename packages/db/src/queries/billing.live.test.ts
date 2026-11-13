// Billing's one-winner writes on a real Postgres, where statements truly run at once: first card
// setups racing to store a Stripe customer, admins opening card setups together, the return page,
// the poll and the webhook settling one setup together, and two refreshes of the gate. Runs only
// when PONZU_TEST_DATABASE_URL names a migrated database (see ../live.ts); CI gives it a Postgres 18.
import { afterAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { seedUser, seedWorkspace } from "../fixtures.ts";
import { randomString } from "../ids.ts";
import { describeLive } from "../live.ts";
import { getWorkspace } from "./accounts.ts";
import { beginCardSetup, setBillingGate, setCustomer, settleCardSetup } from "./billing.ts";
import { run } from "./run.ts";

const times = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

describeLive("billing's one-winner writes on a real Postgres", ({ db, close }) => {
  afterAll(close);

  // The fixtures find a workspace again by its GitHub id on a database an earlier run filled, so
  // each test names its own.
  const freshWorkspace = () => seedWorkspace(db, `billing-${randomString(8).toLowerCase()}`);

  test("eight first stores of a customer keep exactly one", async () => {
    const workspace = await freshWorkspace();
    await run(
      db.execute(sql`update workspaces set stripe_customer_id = null where id = ${workspace.id}`),
    );
    const answers = await Promise.all(
      times(8, (index) =>
        setCustomer(db, { workspaceId: workspace.id, customerId: `cus_${workspace.id}_${index}` }),
      ),
    );
    const winners = answers.filter((answer) => answer?.stored);
    expect(winners).toHaveLength(1);
    expect(new Set(answers.map((answer) => answer!.customerId))).toEqual(
      new Set([winners[0]!.customerId]),
    );
    expect((await getWorkspace(db, workspace.id))!.stripeCustomerId).toBe(winners[0]!.customerId);
  });

  test("eight card setups opened at once leave exactly one open", async () => {
    const workspace = await freshWorkspace();
    const admin = await seedUser(db, "maya");
    const now = new Date();
    const opened = await Promise.all(
      times(8, () =>
        beginCardSetup(db, {
          userId: admin.id,
          workspaceId: workspace.id,
          capCents: 10_000,
          scheme: "ponzu",
          now,
          expiresAt: new Date(now.getTime() + 35 * 60_000),
        }),
      ),
    );
    expect(opened.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const { rows } = (await run(
      db.execute(sql`
        select count(*)::int as open from auth_states
         where kind = 'card_setup' and payload ->> 'workspaceId' = ${workspace.id}
           and consumed_at is null`),
    )) as unknown as { rows: { open: number }[] };
    expect(rows[0]!.open).toBe(1);
  });

  test("a setup settled by three at once is settled by exactly one", async () => {
    const workspace = await freshWorkspace();
    const admin = await seedUser(db, "ines");
    const now = new Date();
    const setup = await beginCardSetup(db, {
      userId: admin.id,
      workspaceId: workspace.id,
      capCents: 10_000,
      scheme: "ponzu",
      now,
      expiresAt: new Date(now.getTime() + 35 * 60_000),
    });
    const settled = await Promise.all(
      (["added", "added", "cancelled"] as const).map((outcome) =>
        settleCardSetup(db, { id: setup!.id, outcome, at: new Date() }),
      ),
    );
    // `added` may replace a `cancelled` that committed first (the card Stripe has is the truth),
    // so the cancel can settle too, but only before an `added`, and `added` settles exactly once.
    const won = settled.filter((answer) => answer!.settled);
    const added = won.filter((answer) => answer!.setup.payload.outcome === "added");
    expect(added).toHaveLength(1);
    expect(won.length).toBeLessThanOrEqual(2);
    const { rows } = (await run(
      db.execute(
        sql`select payload ->> 'outcome' as outcome from auth_states where id = ${setup!.id}`,
      ),
    )) as unknown as { rows: { outcome: string }[] };
    expect(rows[0]!.outcome).toBe("added");
  });

  test("a setup settled the same way by three at once is settled by exactly one", async () => {
    for (const outcomes of [
      ["added", "added", "added"],
      ["cancelled", "cancelled", "expired"],
    ] as const) {
      const workspace = await freshWorkspace();
      const admin = await seedUser(db, "ines");
      const now = new Date();
      const setup = await beginCardSetup(db, {
        userId: admin.id,
        workspaceId: workspace.id,
        capCents: 10_000,
        scheme: "ponzu",
        now,
        expiresAt: new Date(now.getTime() + 35 * 60_000),
      });
      const settled = await Promise.all(
        outcomes.map((outcome) => settleCardSetup(db, { id: setup!.id, outcome, at: new Date() })),
      );
      expect(settled.filter((answer) => answer!.settled)).toHaveLength(1);
      const outcome = settled.find((answer) => answer!.settled)!.setup.payload.outcome;
      // Every later answer reports the first one's outcome.
      for (const answer of settled) expect(answer!.setup.payload.outcome).toBe(outcome);
    }
  });

  test("two gate refreshes at once each see the other's write", async () => {
    const workspace = await freshWorkspace();
    await setBillingGate(db, { workspaceId: workspace.id, gate: "ok", at: new Date() });
    const answers = await Promise.all(
      (["free_used", "free_used"] as const).map((gate) =>
        setBillingGate(db, { workspaceId: workspace.id, gate, at: new Date() }),
      ),
    );
    // Exactly one saw the change from ok; the other saw the gate already moved.
    expect(answers.map((answer) => answer!.before).sort()).toEqual(["free_used", "ok"]);
  });
});
