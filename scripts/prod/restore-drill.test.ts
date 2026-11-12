import { describe, expect, test } from "bun:test";
import {
  allowedDrift,
  type CountRows,
  compareCounts,
  type DrillBranch,
  type DrillIo,
  type DrillNeon,
  drillName,
  MIGRATIONS_TABLE,
  main,
  OPERATION_DEADLINE_MS,
} from "./restore-drill.ts";

const KEY = "neon-drill-test-key";
const PROJECT = "drill-project-id";
const START = new Date("2026-11-12T15:04:30.000Z");

/** A fake Neon project: branches, operations that finish after some polls, a log of every call. */
class FakeNeon implements DrillNeon {
  branches: DrillBranch[] = [
    { id: "br-prod", name: "production", default: true },
    { id: "br-dev", name: "dev", default: false },
  ];
  calls: string[] = [];
  /** Polls before each operation finishes; `"failed"` ends it badly. */
  pollsLeft = new Map<string, number | "failed">();
  createdWith: Parameters<DrillNeon["createBranch"]>[0] | null = null;
  failDelete = false;
  answerDefault = false;

  async listBranches() {
    this.calls.push("list");
    return this.branches.map((b) => ({ ...b }));
  }
  async createBranch(input: Parameters<DrillNeon["createBranch"]>[0]) {
    this.calls.push(`create ${input.name} from ${input.parentId} at ${input.parentTimestamp}`);
    this.createdWith = input;
    const branch = { id: "br-drill", name: input.name, default: this.answerDefault };
    this.branches.push(branch);
    this.pollsLeft.set("op-create", 2);
    return { branch, operationIds: ["op-create"] };
  }
  async operationStatus(id: string) {
    this.calls.push(`poll ${id}`);
    const left = this.pollsLeft.get(id) ?? 0;
    if (left === "failed") return "failed";
    if (left > 0) {
      this.pollsLeft.set(id, left - 1);
      return "running";
    }
    return "finished";
  }
  async deleteBranch(id: string) {
    this.calls.push(`delete ${id}`);
    if (this.failDelete) throw new Error("Neon answered 500");
    this.branches = this.branches.filter((b) => b.id !== id);
    this.pollsLeft.set("op-delete", 1);
    return { operationIds: ["op-delete"] };
  }
  async database(branchId: string) {
    this.calls.push(`database ${branchId}`);
    return { name: "neondb", owner: "neondb_owner" };
  }
  async connectionUri(branchId: string) {
    this.calls.push(`uri ${branchId}`);
    return `postgresql://neondb_owner:secret-password-${branchId}@${branchId}.example/neondb`;
  }
}

const LIVE = { "public.canvases": 1200, "public.accounts": 40, [MIGRATIONS_TABLE]: 30 };

function harness(over: { neon?: FakeNeon; counts?: Record<string, Record<string, number>> } = {}) {
  const neon = over.neon ?? new FakeNeon();
  const counts: Record<string, Record<string, number>> = over.counts ?? {
    "br-dev": LIVE,
    "br-drill": { "public.canvases": 1150, "public.accounts": 39, [MIGRATIONS_TABLE]: 30 },
  };
  const lines: string[] = [];
  let now = START.getTime();
  const counted: string[] = [];
  const count: CountRows = async (uri) => {
    const branch = /secret-password-([\w-]+)@/.exec(uri)?.[1] as string;
    counted.push(branch);
    return counts[branch] ?? {};
  };
  const io: DrillIo = {
    print: (line) => lines.push(line),
    env: { NEON_API_KEY: KEY, NEON_PROJECT_ID: PROJECT },
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
    neon,
    count,
  };
  return { neon, io, lines, counted };
}

describe("judging the counts", () => {
  test("an hour's writes: at least 100 rows, or a quarter of the live table", () => {
    expect(allowedDrift(0)).toBe(100);
    expect(allowedDrift(400)).toBe(100);
    expect(allowedDrift(1000)).toBe(250);
  });

  test("each table, exactly", () => {
    expect(
      compareCounts(
        { "public.a": 1000, "public.b": 10, "public.c": 5, [MIGRATIONS_TABLE]: 3 },
        { "public.a": 700, "public.b": 0, [MIGRATIONS_TABLE]: 3 },
      ),
    ).toEqual([
      { table: MIGRATIONS_TABLE, live: 3, restored: 3, ok: true, says: "3 restored, 3 live" },
      {
        table: "public.a",
        live: 1000,
        restored: 700,
        ok: false,
        says: "700 restored, 1000 live: 300 apart, more than the 250 an hour's writes explain",
      },
      { table: "public.b", live: 10, restored: 0, ok: true, says: "0 restored, 10 live" },
      {
        table: "public.c",
        live: 5,
        restored: null,
        ok: false,
        says: "only the live branch has it, and no migration in between explains that",
      },
    ]);
  });

  test("a table only one side has is explained by a migration in between", () => {
    const [, line] = compareCounts(
      { "public.new": 0, [MIGRATIONS_TABLE]: 31 },
      { [MIGRATIONS_TABLE]: 30 },
    );
    expect(line).toEqual({
      table: "public.new",
      live: 0,
      restored: null,
      ok: true,
      says: "only the live branch has it, which a migration in between explains",
    });
  });

  test("the drill branch's name", () => {
    expect(drillName("dev", START)).toBe("restore-drill-dev-20261112t1504");
  });
});

describe("the drill on dev, against a fake Neon", () => {
  test("branches from an hour ago, counts, deletes only its branch, and the list is back", async () => {
    const { neon, io, lines, counted } = harness();
    expect(await main(["--env", "dev"], io)).toBe(0);
    expect(neon.createdWith).toEqual({
      parentId: "br-dev",
      name: "restore-drill-dev-20261112t1504",
      parentTimestamp: "2026-11-12T14:04:30.000Z",
      expiresAt: "2026-11-13T15:04:30.000Z",
    });
    expect(neon.calls.filter((c) => c.startsWith("delete"))).toEqual(["delete br-drill"]);
    expect(counted.sort()).toEqual(["br-dev", "br-drill"]);
    expect(lines).toEqual([
      "Ponzu dev: restore drill of dev as it was at 2026-11-12T14:04:30.000Z",
      `ok      ${MIGRATIONS_TABLE}: 30 restored, 30 live`,
      "ok      public.accounts: 39 restored, 40 live",
      "ok      public.canvases: 1150 restored, 1200 live",
      "ok      the branch list is as it was (2 branches)",
      "restored 3 tables from 1 hour ago, each within an hour's writes",
    ]);
    // Neither the key, the project id nor a connection string is ever printed.
    expect(lines.join("\n")).not.toMatch(/neon-drill-test-key|drill-project-id|secret-password/);
  });

  test("it waits for Neon's operations by polling, and gives up at its deadline", async () => {
    const { neon, io, lines } = harness();
    neon.createBranch = async function (input) {
      this.createdWith = input;
      const branch = { id: "br-drill", name: input.name, default: false };
      this.branches.push(branch);
      this.pollsLeft.set("op-create", Number.MAX_SAFE_INTEGER);
      return { branch, operationIds: ["op-create"] };
    };
    expect(await main(["--env", "dev"], io)).toBe(1);
    expect(lines).toContain(
      `fail    the drill could not finish: Neon's operation to create the drill branch did not finish in ${OPERATION_DEADLINE_MS / 60_000} minutes`,
    );
    // The branch it made is still deleted, and the list is back.
    expect(neon.calls).toContain("delete br-drill");
    expect(lines).toContain("ok      the branch list is as it was (2 branches)");
  });

  test("counts too far apart fail the drill", async () => {
    const { io, lines } = harness({
      counts: {
        "br-dev": LIVE,
        "br-drill": { "public.canvases": 2, "public.accounts": 40, [MIGRATIONS_TABLE]: 30 },
      },
    });
    expect(await main(["--env", "dev"], io)).toBe(1);
    expect(lines).toContain(
      "fail    public.canvases: 2 restored, 1200 live: 1198 apart, more than the 300 an hour's writes explain",
    );
    expect(lines.at(-1)).toBe("the drill failed");
  });

  test("a branch it cannot delete fails, and the list differs", async () => {
    const neon = new FakeNeon();
    neon.failDelete = true;
    const { io, lines } = harness({ neon });
    expect(await main(["--env", "dev"], io)).toBe(1);
    expect(lines).toContain(
      "fail: the drill branch restore-drill-dev-20261112t1504 could not be deleted (Neon answered 500); it expires by itself within a day",
    );
    expect(lines.some((l) => l.startsWith("fail    the branch list differs"))).toBe(true);
  });

  test("it never deletes a branch Neon answered as the default", async () => {
    const neon = new FakeNeon();
    neon.answerDefault = true;
    neon.deleteBranch = async () => {
      throw new Error("must not be called");
    };
    const { io, lines } = harness({ neon });
    // The drill deletes only the branch it made; one answered as default is refused before use.
    expect(await main(["--env", "dev"], io)).toBe(1);
    expect(lines).toContain(
      "fail    the drill could not finish: Neon answered a branch that is not the drill's (restore-drill-dev-20261112t1504)",
    );
  });

  test("production drills the default branch", async () => {
    const { neon, io } = harness({
      counts: { "br-prod": LIVE, "br-drill": LIVE },
    });
    expect(await main(["--env", "production"], io)).toBe(0);
    expect(neon.createdWith?.parentId).toBe("br-prod");
  });

  test("without credentials it is skipped, and bad arguments print usage", async () => {
    const { io, lines } = harness();
    expect(await main(["--env", "dev"], { ...io, env: {} })).toBe(1);
    expect(lines).toEqual(["skipped: the drill needs NEON_API_KEY and NEON_PROJECT_ID"]);
    expect(await main(["--env", "staging"], io)).toBe(2);
    expect(await main(["--env", "dev", "--hours-ago", "0"], io)).toBe(2);
  });
});
