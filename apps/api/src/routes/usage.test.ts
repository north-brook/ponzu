import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { beginSandbox, moveSandbox, recordUsage } from "@ponzu/db";
import { call, designIn, type Workspace, workspaceWithRepo } from "../testing/designs.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";

/*
 * Plan and usage through the routes: usage events and an awake sandbox in the database, the
 * period from the workspace's anchor, and who may see and change what.
 */

let t: TestApp;
let ws: Workspace;
const HOUR = 3600;
let n = 0;

beforeAll(async () => {
  t = await createTestApp();
  // The test clock starts on 2026-01-01: this period runs from December 9 to January 9.
  ws = await workspaceWithRepo(t, { bryce: "admin", maya: "write", omar: "read" });
  await t.db.execute(
    `update workspaces set billing_period_anchor = '2025-10-09T14:00:00Z' where id = '${ws.id}'`,
  );
  // Members of the organization, as GitHub says: they see one another.
  ws.github.installation.account.members = Object.values(ws.people).map((p) => p.github.id);
  await t.db.execute(
    `update memberships set github_access = 'member' where workspace_id = '${ws.id}'`,
  );
});
afterAll(() => t.close());

const as = async (login: string) => (await t.signInAs({ login })).headers;

async function awake(login: string, designId: string, hours: number, at: string) {
  await recordUsage(t.db, {
    id: `test-${n++}`,
    workspaceId: ws.id,
    designId,
    userId: ws.people[login]!.userId,
    kind: "sandbox",
    seconds: hours * HOUR,
    credits: 0,
    costMicrousd: 0,
    payer: "ponzu",
    rateCardVersion: 1,
    occurredAt: new Date(at),
    periodStart: new Date("2025-12-09T00:00:00Z"),
  });
}

describe("usage this period", () => {
  let bryces: string;
  let mayas: string;

  beforeAll(async () => {
    bryces = (await designIn(t, ws, "bryce", sampleDoc())).id;
    mayas = (await designIn(t, ws, "maya", sampleDoc())).id;
    await awake("bryce", bryces, 30, "2025-12-10T10:00:00Z");
    await awake("maya", mayas, 34, "2025-12-28T10:00:00Z");
    // The period before: not this one's.
    await awake("bryce", bryces, 100, "2025-12-08T23:00:00Z");
  });

  test("an admin sees the totals, the free credits pooled, and who used what", async () => {
    const got = await call(t, await as("bryce"), "GET", `/v1/workspaces/${ws.id}/usage`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      period: { start: "2025-12-09T00:00:00.000Z", end: "2026-01-09T00:00:00.000Z" },
      creditCents: 10,
      usedCredits: 320,
      freeCredits: 300,
      billedCredits: 20,
      billedCents: 200,
      people: 3,
      cap: { usd: 100, isDefault: true, lowestUsd: 2 },
      billing: { status: "not_set_up", card: null, invoices: "not_set_up" },
      canManage: true,
      mine: { admin: true, usedCredits: 150, person: { login: "bryce" } },
      unattributedCredits: 0,
    });
    expect(
      got.body.byPerson.map((row: { person: { login: string }; usedCredits: number }) => [
        row.person.login,
        row.usedCredits,
      ]),
    ).toEqual([
      ["maya", 170],
      ["bryce", 150],
      ["omar", 0],
    ]);
    expect(got.body.byDesign.map((row: { usedCredits: number }) => row.usedCredits)).toEqual([
      170, 150,
    ]);
  });

  test("a member sees the same totals, read-only, and only their own use", async () => {
    const got = await call(t, await as("omar"), "GET", `/v1/workspaces/${ws.id}/usage`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      usedCredits: 320,
      billedCents: 200,
      canManage: false,
      mine: { admin: false, usedCredits: 0 },
      byPerson: null,
      byDesign: null,
      unattributedCredits: null,
    });
  });

  test("counts the stretch awake right now, to the minute", async () => {
    const before = await call(t, await as("maya"), "GET", `/v1/workspaces/${ws.id}/usage`);
    const designId = (await designIn(t, ws, "maya", sampleDoc())).id;
    const now = new Date(t.clock.now());
    const limits = { perWorkspace: 10, perOwner: 10 };
    const begun = await beginSandbox(t.db, { designId, provider: "boat", now, by: "test", limits });
    if (!begun || !("sandbox" in begun)) throw new Error("no sandbox");
    await moveSandbox(t.db, {
      id: begun.sandbox.id,
      from: ["waking"],
      to: "awake",
      now,
      by: "test",
    });
    t.clock.advance(HOUR * 1000);
    const after = await call(t, await as("maya"), "GET", `/v1/workspaces/${ws.id}/usage`);
    expect(after.body.usedCredits).toBe(before.body.usedCredits + 5);
  });

  test("is nobody's business outside the workspace", async () => {
    const other = await workspaceWithRepo(t, { ines: "admin" });
    const got = await call(t, await as("ines"), "GET", `/v1/workspaces/${ws.id}/usage`);
    expect(got.status).toBe(404);
    expect(got.body.error.code).toBe("not_found");
    const theirs = await call(t, await as("ines"), "GET", `/v1/workspaces/${other.id}/usage`);
    expect(theirs.body).toMatchObject({ usedCredits: 0, freeCredits: 100, people: 1 });
  });
});

describe("the monthly cap", () => {
  test("only an admin changes it", async () => {
    const refused = await call(t, await as("maya"), "PATCH", `/v1/workspaces/${ws.id}/billing`, {
      capUsd: 500,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("forbidden");

    const set = await call(t, await as("bryce"), "PATCH", `/v1/workspaces/${ws.id}/billing`, {
      capUsd: 50,
    });
    expect(set.status).toBe(200);
    expect(set.body.cap).toMatchObject({ usd: 50, isDefault: false });
    const seen = await call(t, await as("omar"), "GET", `/v1/workspaces/${ws.id}/usage`);
    expect(seen.body.cap.usd).toBe(50);
  });

  test("is whole dollars, and never below what the period has billed", async () => {
    const bryce = await as("bryce");
    for (const capUsd of [0, 12.5, -3, "50"]) {
      const bad = await call(t, bryce, "PATCH", `/v1/workspaces/${ws.id}/billing`, { capUsd });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("invalid_request");
    }
    const { body } = await call(t, bryce, "GET", `/v1/workspaces/${ws.id}/usage`);
    const tooLow = await call(t, bryce, "PATCH", `/v1/workspaces/${ws.id}/billing`, {
      capUsd: body.cap.lowestUsd - 1,
    });
    expect(tooLow.status).toBe(400);
    expect(tooLow.body.error).toMatchObject({
      code: "cap_too_low",
      details: { lowestUsd: body.cap.lowestUsd },
    });
  });
});
