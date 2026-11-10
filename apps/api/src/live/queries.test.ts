import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import {
  call,
  designIn,
  runnerHeaders,
  type Workspace,
  workspaceWithRepo,
} from "../testing/designs.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { LIVE_QUERIES, type LiveQueryName } from "./queries.ts";

let t: TestApp;
let ws: Workspace;
let designId: string;
let scratchId: string;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", ines: "read", omar: "none" });
  designId = (await designIn(t, ws, "maya", emptyDoc("Live"))).id;
  scratchId = (await designIn(t, ws, "maya", emptyDoc("Mine"), "scratch")).id;
});
afterAll(() => t.close());

const as = (login: string) => ws.people[login]!.headers;
const live = (headers: Record<string, string>, queries: { name: string; args?: unknown }[]) =>
  call(t, headers, "POST", "/v1/live", { queries });

/** The arguments each query takes, for a workspace and a design in it. */
const ARGS: Record<LiveQueryName, (ids: { workspaceId: string; designId: string }) => object> = {
  me: () => ({}),
  "workspace.designs": ({ workspaceId }) => ({ workspaceId }),
  "design.head": ({ designId }) => ({ designId }),
  "design.thread": ({ designId }) => ({ designId }),
  "design.questions": ({ designId }) => ({ designId }),
  "design.presence": ({ designId }) => ({ designId }),
};
const NAMES = Object.keys(ARGS) as LiveQueryName[];
/** Every query, for the workspace and design above unless told otherwise. */
const every = (ids = { workspaceId: ws.id, designId }) =>
  NAMES.map((name) => ({ name, args: ARGS[name](ids) }));

test("the registry is the six queries the clients watch", () => {
  expect(Object.keys(LIVE_QUERIES).sort()).toEqual([...NAMES].sort());
});

/** What the fake sealer sealed for one result: it writes the query into the capability. */
const unsealed = (result: { sealed: { capability: string } }): { sql: string; params: string[] } =>
  JSON.parse(result.sealed.capability.slice("sealed:".length));

test("seals every query for someone who may watch it, in one call, with where to subscribe", async () => {
  const { status, body } = await live(as("ines"), every());

  expect(status).toBe(200);
  expect(body.url).toBe(t.realtime.url);
  expect(body.results.map((result: any) => result.name)).toEqual(NAMES);
  for (const result of body.results) {
    expect(result.sealed).toEqual({
      capability: expect.stringMatching(/^sealed:/),
      queryFingerprint: expect.any(String),
      expiresAt: t.clock.now() + 60_000,
    });
  }
  const ines = ws.people.ines!.userId;
  expect(body.results.map((result: any) => unsealed(result).params)).toEqual([
    [ines],
    [ines, ws.id],
    [designId],
    [designId],
    [designId],
    [designId],
  ]);
});

describe("refusals", () => {
  test("someone who cannot open a design is refused each of its queries, one by one", async () => {
    const queries = every().filter(({ name }) => name.startsWith("design."));

    const { status, body } = await live(as("omar"), [...queries, { name: "me" }]);

    expect(status).toBe(200);
    expect(
      body.results.map((result: any) => [result.name, result.error?.code ?? "sealed"]),
    ).toEqual([
      ["design.head", "not_found"],
      ["design.thread", "not_found"],
      ["design.questions", "not_found"],
      ["design.presence", "not_found"],
      ["me", "sealed"],
    ]);
  });

  test("a Scratch design is its owner's alone, and a workspace its members'", async () => {
    const outsider = await t.signInAs({ login: "outsider" });
    const scratch = (login: string) =>
      live(as(login), [{ name: "design.head", args: { designId: scratchId } }]);

    expect((await scratch("maya")).body.results[0].sealed).toBeDefined();
    expect((await scratch("ines")).body.results[0].error.code).toBe("not_found");
    const workspace = await live(outsider.headers, [
      { name: "workspace.designs", args: { workspaceId: ws.id } },
    ]);
    expect(workspace.body.results[0].error.code).toBe("not_found");
  });

  test("a runner watches its own design only, and nothing about people or workspaces", async () => {
    const other = await designIn(t, ws, "maya", emptyDoc("Other"));
    const runner = await runnerHeaders(t, designId);

    const { body } = await live(runner, [
      { name: "design.thread", args: { designId } },
      { name: "design.thread", args: { designId: other.id } },
      { name: "me" },
      { name: "workspace.designs", args: { workspaceId: ws.id } },
    ]);

    expect(body.results.map((result: any) => result.error?.code ?? "sealed")).toEqual([
      "sealed",
      "not_found",
      "forbidden",
      "forbidden",
    ]);
  });

  test("an unknown name or arguments the query does not take are refused on their own", async () => {
    const { body } = await live(as("maya"), [
      { name: "design.everything", args: { designId } },
      { name: "toString" },
      { name: "design.head", args: { designId: 7 } },
      { name: "design.head", args: { designId } },
    ]);

    expect(body.results.map((result: any) => result.error?.code ?? "sealed")).toEqual([
      "not_found",
      "not_found",
      "invalid_request",
      "sealed",
    ]);
  });

  test("the request itself must name between one and 32 queries", async () => {
    const tooMany = Array.from({ length: 33 }, () => ({ name: "me" }));

    expect((await live(as("maya"), [])).status).toBe(400);
    expect((await live(as("maya"), tooMany)).status).toBe(400);
    expect((await call(t, {}, "POST", "/v1/live", { queries: [{ name: "me" }] })).status).toBe(401);
  });
});

describe("the SQL that is sealed", () => {
  test("never carries an argument in its text: the same text for anyone, the values bound", async () => {
    const other = await workspaceWithRepo(t, { maya: "write" });
    const otherDesign = await designIn(t, other, "maya", emptyDoc("Elsewhere"));
    const here = await live(as("maya"), every());
    const there = await live(
      as("maya"),
      every({ workspaceId: other.id, designId: otherDesign.id }),
    );

    for (const [i, name] of NAMES.entries()) {
      const [one, two] = [unsealed(here.body.results[i]), unsealed(there.body.results[i])];
      expect(one.sql).toBe(LIVE_QUERIES[name].sql);
      expect(two.sql).toBe(one.sql);
      for (const value of [...one.params, ...two.params]) expect(one.sql).not.toContain(value);
    }
  });

  test.each(NAMES)("%s is a plain filter or join over small rows, as Realtime needs", (name) => {
    const { sql } = LIVE_QUERIES[name];
    // Re-sent whole on every change, or refused.
    expect(sql).not.toMatch(/\b(order by|limit|offset|distinct|group by|exists|with)\b|now\(\)/i);
    expect(sql).not.toMatch(/\bin\s*\(\s*select/i);
    // Secrets, and design content, never travel through Realtime.
    expect(sql).not.toMatch(
      /encrypted_|asset_key|token|design_ops|design_checkpoints|\bselect \*/i,
    );
    expect(sql).not.toMatch(/\.\*/);
  });
});
