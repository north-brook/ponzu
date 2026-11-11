import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { getUserByWorkosId, listWorkspaceRepoAccess, type User } from "@ponzu/db";
import { createGithub } from "../deps/github.ts";
import { designIn, type Workspace, workspaceWithRepo } from "../testing/designs.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { requireDesign } from "./authorize.ts";
import { refreshWorkspaceRepoAccess } from "./repo-access.ts";

// Answers about access are kept in Postgres, where every function instance finds them.

let t: TestApp;
let ws: Workspace;
let designId: string;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", ines: "read", omar: "none" });
  designId = (await designIn(t, ws, "maya", emptyDoc("Shared"))).id;
});
afterAll(() => t.close());

const userOf = async (login: string): Promise<User> =>
  (await getUserByWorkosId(t.db, ws.people[login]!.workos.id))!;

/** A function instance of its own: it shares the database with the others, and nothing else. */
function instance() {
  const calls: string[] = [];
  const github = createGithub({
    ...t.github.credentials,
    fetch: (url, init) => {
      calls.push(new URL(url).pathname);
      return t.github.fetch(url, init);
    },
    clock: t.clock,
  });
  return { deps: { ...t.deps, github }, calls };
}

const open = async (deps: typeof t.deps, login: string) =>
  requireDesign(
    { var: { deps, actor: { kind: "user", user: await userOf(login), sessionId: "s" } } },
    designId,
    "read",
  );

const asked = (calls: string[]) => calls.filter((path) => path.endsWith("/permission")).length;

describe("opening a design", () => {
  test("one instance's answer serves every instance for a minute; then GitHub is asked again", async () => {
    const [a, b, c] = [instance(), instance(), instance()];

    expect((await open(a.deps, "ines")).access).toBe("read");
    expect((await open(b.deps, "ines")).access).toBe("read");
    expect([asked(a.calls), asked(b.calls)]).toEqual([1, 0]);

    ws.grant("ines", "none");
    t.clock.advance(60_000);
    await expect(open(c.deps, "ines")).rejects.toMatchObject({ status: 404 });
    expect(asked(c.calls)).toBe(1);
    ws.grant("ines", "read");
  });

  test("while GitHub fails, the last answer stands for ten minutes and no longer", async () => {
    const path = `/repos/${ws.repo.fullName}/collaborators/maya/permission`;
    const { deps } = instance();
    expect((await open(deps, "maya")).access).toBe("write");

    t.clock.advance(2 * 60_000);
    t.github.failNext(path, 403);
    expect((await open(deps, "maya")).access).toBe("write");

    t.clock.advance(9 * 60_000);
    t.github.failNext(path, 502);
    await expect(open(deps, "maya")).rejects.toMatchObject({ name: "UpstreamError" });
    // GitHub back: asked again, and kept again.
    expect((await open(deps, "maya")).access).toBe("write");
  });
});

describe("the workspace's design list", () => {
  const listed = (calls: string[]) => calls.filter((path) => path.endsWith("/repositories")).length;
  const refresh = async (deps: typeof t.deps, login: string) =>
    refreshWorkspaceRepoAccess(deps, {
      user: await userOf(login),
      workspace: { id: ws.id, installationId: ws.installationId, suspendedAt: null },
    });
  const kept = async (login: string) =>
    (
      await listWorkspaceRepoAccess(t.db, {
        workspaceId: ws.id,
        userId: ws.people[login]!.userId,
      })
    ).map(({ permission }) => permission);

  test("is checked with the person's own token, once for every repo, at most once a minute", async () => {
    const { deps, calls } = instance();
    t.clock.advance(60_000);

    await refresh(deps, "omar");
    await refresh(deps, "ines");
    expect([await kept("omar"), await kept("ines")]).toEqual([["none"], ["read"]]);
    expect([listed(calls), asked(calls)]).toEqual([2, 0]);

    await refresh(deps, "ines");
    expect(listed(calls)).toBe(2);
    t.clock.advance(60_000);
    await refresh(deps, "ines");
    expect(listed(calls)).toBe(3);
  });

  test("while GitHub fails, the answers kept stand for ten minutes, and then nothing is listed", async () => {
    const { deps } = instance();
    const path = `/user/installations/${ws.installationId}/repositories`;
    t.clock.advance(60_000);
    await refresh(deps, "ines");

    t.clock.advance(5 * 60_000);
    t.github.failNext(path, 502);
    await refresh(deps, "ines");
    expect(await kept("ines")).toEqual(["read"]);

    t.clock.advance(6 * 60_000);
    t.github.failNext(path, 502);
    await expect(refresh(deps, "ines")).rejects.toMatchObject({ name: "UpstreamError" });
  });
});
