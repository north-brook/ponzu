import { describe, expect, test } from "bun:test";
import {
  branchDatabaseUrl,
  DEFAULT_BRANCH_GUARD,
  parseArgs,
  SNAPSHOT_DAYS,
  snapshotDefaultBranch,
} from "./neon.ts";

const BRANCHES = {
  branches: [
    { id: "br-main", name: "main", default: true },
    { id: "br-dev", name: "dev", default: false },
  ],
};

/** A Neon that answers from a table and records every request it was asked. */
function fakeNeon(answers: Record<string, unknown | ((call: number) => unknown)>) {
  const requests: { method: string; path: string }[] = [];
  const counts = new Map<string, number>();
  // A plain fetch call passes a URL and its init; Neon's client (axios's fetch adapter) passes
  // a Request, whose headers must carry the key.
  const fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const path = url.replace("https://console.neon.tech/api/v2/projects/prj", "");
    const method = typeof input === "string" ? (init?.method ?? "GET") : input.method;
    const headers = new Headers(typeof input === "string" ? init?.headers : input.headers);
    if (headers.get("authorization") !== "Bearer k") return new Response("{}", { status: 401 });
    requests.push({ method, path });
    const key = `${method} ${path.split("?")[0]}`;
    const call = counts.get(key) ?? 0;
    counts.set(key, call + 1);
    const answer = answers[key];
    if (answer === undefined) return new Response("{}", { status: 404 });
    const body = typeof answer === "function" ? answer(call) : answer;
    return Response.json(body);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

const URLS = {
  "GET /branches": BRANCHES,
  "GET /branches/br-main/databases": { databases: [{ name: "neondb", owner_name: "owner" }] },
  "GET /branches/br-dev/databases": { databases: [{ name: "neondb", owner_name: "owner" }] },
  "GET /connection_uri": { uri: "postgres://owner:pw@ep-x-pooler.neon.tech/neondb" },
};

describe("the default branch", () => {
  test("asked for by name, it is refused", async () => {
    const neon = fakeNeon(URLS);
    await expect(
      branchDatabaseUrl("main", { apiKey: "k", projectId: "prj", fetch: neon.fetch }),
    ).rejects.toThrow('"main" is the project\'s default branch. Not that one.');
  });

  for (const guard of [undefined, "", "Production", "dev", "production "]) {
    test(`--default with the guard ${JSON.stringify(guard)} is refused before Neon is asked`, async () => {
      const neon = fakeNeon(URLS);
      await expect(
        branchDatabaseUrl(
          { default: true, guard },
          { apiKey: "k", projectId: "prj", fetch: neon.fetch },
        ),
      ).rejects.toThrow("PONZU_ALLOW_DEFAULT_BRANCH=production");
      expect(neon.requests).toEqual([]);
    });
  }

  test("--default with the guard answers the default branch's direct URL", async () => {
    const neon = fakeNeon(URLS);
    const url = await branchDatabaseUrl(
      { default: true, guard: DEFAULT_BRANCH_GUARD },
      { apiKey: "k", projectId: "prj", fetch: neon.fetch, direct: true },
    );
    expect(url).toBe("postgres://owner:pw@ep-x.neon.tech/neondb");
    expect(neon.requests.map((r) => r.path.split("?")[0])).toEqual([
      "/branches",
      "/branches/br-main/databases",
      "/connection_uri",
    ]);
    expect(neon.requests[2]?.path).toContain("branch_id=br-main");
  });

  test("a branch by name is unchanged", async () => {
    const neon = fakeNeon(URLS);
    const url = await branchDatabaseUrl("dev", {
      apiKey: "k",
      projectId: "prj",
      fetch: neon.fetch,
    });
    expect(url).toBe("postgres://owner:pw@ep-x-pooler.neon.tech/neondb");
    expect(neon.requests[2]?.path).toContain("branch_id=br-dev");
  });
});

describe("the pre-migration snapshot", () => {
  const now = new Date("2026-11-12T10:00:00.000Z");

  test("is refused without the guard, before Neon is asked", async () => {
    const neon = fakeNeon(URLS);
    await expect(
      snapshotDefaultBranch("pre-abcdef012345", {
        apiKey: "k",
        projectId: "prj",
        fetch: neon.fetch,
        guard: undefined,
      }),
    ).rejects.toThrow("PONZU_ALLOW_DEFAULT_BRANCH=production");
    expect(neon.requests).toEqual([]);
  });

  test("snapshots the default branch, kept 14 days, and waits for its operation", async () => {
    const statuses = ["running", "running", "finished"];
    const neon = fakeNeon({
      ...URLS,
      "POST /branches/br-main/snapshot": {
        snapshot: { id: "snap-1" },
        operations: [{ id: "op-1" }],
      },
      "GET /operations/op-1": (call: number) => ({ operation: { status: statuses[call] } }),
    });
    const waits: number[] = [];
    const id = await snapshotDefaultBranch("pre-abcdef012345", {
      apiKey: "k",
      projectId: "prj",
      fetch: neon.fetch,
      guard: "production",
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(id).toBe("snap-1");
    expect(waits).toEqual([2_000, 2_000]);
    const post = neon.requests.find((r) => r.method === "POST");
    const query = new URLSearchParams(post?.path.split("?")[1]);
    expect(post?.path.split("?")[0]).toBe("/branches/br-main/snapshot");
    expect(query.get("name")).toBe("pre-abcdef012345");
    expect(query.get("expires_at")).toBe(
      new Date(now.getTime() + SNAPSHOT_DAYS * 86_400_000).toISOString(),
    );
    expect(query.get("expires_at")).toBe("2026-11-26T10:00:00.000Z");
  });

  test("an operation that fails fails the snapshot", async () => {
    const neon = fakeNeon({
      ...URLS,
      "POST /branches/br-main/snapshot": { snapshot: { id: "s" }, operations: [{ id: "op" }] },
      "GET /operations/op": { operation: { status: "failed" } },
    });
    await expect(
      snapshotDefaultBranch("pre-x", {
        apiKey: "k",
        projectId: "prj",
        fetch: neon.fetch,
        guard: "production",
        wait: async () => {},
      }),
    ).rejects.toThrow("ended failed");
  });

  test("an operation that never finishes times out", async () => {
    let t = 0;
    const neon = fakeNeon({
      ...URLS,
      "POST /branches/br-main/snapshot": { snapshot: { id: "s" }, operations: [{ id: "op" }] },
      "GET /operations/op": { operation: { status: "running" } },
    });
    await expect(
      snapshotDefaultBranch("pre-x", {
        apiKey: "k",
        projectId: "prj",
        fetch: neon.fetch,
        guard: "production",
        now: () => new Date(t),
        wait: async (ms) => {
          t += ms;
        },
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("still running after 10000 ms");
  });

  test("a name that is not a plain word is refused", async () => {
    await expect(
      snapshotDefaultBranch("pre x&y", { apiKey: "k", projectId: "prj", guard: "production" }),
    ).rejects.toThrow("Not a snapshot name");
  });
});

describe("the arguments", () => {
  test("each use, and what is not one", () => {
    expect(parseArgs(["dev"], undefined)).toEqual({ branch: { name: "dev" }, direct: false });
    expect(parseArgs(["dev", "--direct"], "production")).toEqual({
      branch: { name: "dev" },
      direct: true,
    });
    expect(parseArgs(["--default", "--direct"], "production")).toEqual({
      branch: { default: true, guard: "production" },
      direct: true,
      snapshot: undefined,
    });
    expect(parseArgs(["--default", "--snapshot", "pre-1"], undefined)).toEqual({
      branch: { default: true, guard: undefined },
      direct: false,
      snapshot: "pre-1",
    });
    expect(parseArgs([], undefined)).toBeNull();
    expect(parseArgs(["dev", "--snapshot", "pre-1"], "production")).toBeNull();
    expect(parseArgs(["--default", "dev"], "production")).toBeNull();
    expect(parseArgs(["--default", "--snapshot"], "production")).toBeNull();
    expect(parseArgs(["dev", "--force"], "production")).toBeNull();
  });
});
