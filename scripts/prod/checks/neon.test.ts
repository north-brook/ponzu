import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvironments } from "../desired.ts";
import { infraBeforeLaunch } from "../fixtures/infra.ts";
import type { CheckContext, Finding } from "./finding.ts";
import {
  evaluateNeon,
  fetchNeon,
  type NeonAnswers,
  type NeonDesired,
  neonDesired,
  observeNeon,
} from "./neon.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const fixture = (name: string): NeonAnswers =>
  JSON.parse(readFileSync(join(FIXTURES, "neon", name), "utf8"));
const infra = infraBeforeLaunch();
const desired = (env: "dev" | "production") => neonDesired({ env, infra });
const statuses = (findings: Finding[]) => findings.map((f) => `${f.status} ${f.id}`);
const byId = (findings: Finding[]) => Object.fromEntries(findings.map((f) => [f.id, f]));
const NOW = "2026-11-12T15:00:00.000Z";

/** Production with its Realtime URL in infra, as after founder step D3 (a filled fixture). */
function filledProduction(): NeonDesired {
  const filled = loadEnvironments(join(FIXTURES, "environments-filled.json"));
  return {
    ...desired("production"),
    realtimeUrl: filled.environments.production.realtimeUrl,
  };
}

/** The default branch as `apply.ts neon --env production --yes` leaves it, a day in. */
function appliedDefault(realtimeUrl: string): NeonAnswers {
  const answers = fixture("dev-default-branch.json");
  return {
    ...answers,
    project: { history_retention_seconds: 604800 },
    branches: answers.branches.map((b) => (b.default ? { ...b, protected: true } : b)),
    endpoints: answers.endpoints.map((e) => ({
      ...e,
      suspend_timeout_seconds: -1,
      autoscaling_limit_min_cu: 0.5,
      autoscaling_limit_max_cu: 2,
    })),
    schedule: { schedule: [{ frequency: "daily", hour: 7, retention_seconds: 3024000 }] },
    snapshots: [{ name: "daily", created_at: "2026-11-12T07:00:12Z", manual: false }],
    realtime: { enabled: true, invocation_url: `${realtimeUrl}/` },
  };
}

describe("evaluate on dev's recorded branch", () => {
  test("every line, exactly", () => {
    const observed = observeNeon(fixture("dev-branch.json"), "dev", NOW);
    expect(evaluateNeon(desired("dev"), observed)).toEqual([
      { id: "neon.branch", area: "neon", status: "ok", says: 'the branch "dev" (dev) exists' },
      {
        id: "neon.realtime",
        area: "neon",
        status: "ok",
        says: "Realtime is on for dev, at https://ep-quiet-butterfly-bc2zsmia.rt.c-16.us-east-1.aws.neon.tech",
      },
    ]);
  });

  test("dev's recorded Realtime URL is the one infra and the desktop app name", () => {
    const observed = observeNeon(fixture("dev-branch.json"), "dev", NOW);
    expect(new URL(observed.realtime?.url ?? "").origin).toBe(
      infra["environments.json"].environments.dev.realtimeUrl as string,
    );
  });

  test("a dev branch name that turns out to be the default branch fails", () => {
    const answers = fixture("dev-branch.json");
    answers.branches = answers.branches.map((b) => ({ ...b, default: b.name === "dev" }));
    const f = byId(evaluateNeon(desired("dev"), observeNeon(answers, "dev", NOW)));
    expect(f["neon.branch"]?.status).toBe("fail");
    expect(f["neon.branch"]?.says).toBe(
      "the branch \"dev\" is the project's default branch, which is production's",
    );
  });

  test("Realtime off fails", () => {
    const answers = fixture("dev-branch.json");
    answers.realtime = { enabled: false, invocation_url: null };
    const f = byId(evaluateNeon(desired("dev"), observeNeon(answers, "dev", NOW)));
    expect(f["neon.realtime"]?.status).toBe("fail");
  });
});

describe("production, on the recorded default branch before founder step D3", () => {
  test("nothing passes", () => {
    const observed = observeNeon(fixture("dev-default-branch.json"), "@default", NOW);
    const findings = evaluateNeon(desired("production"), observed);
    expect(statuses(findings)).toEqual([
      "ok neon.branch",
      "pending neon.realtime",
      "fail neon.compute",
      "fail neon.history",
      "pending neon.backups",
      "pending neon.snapshot",
      "fail neon.protected",
    ]);
    const f = byId(findings);
    expect(f["neon.branch"]?.says).toBe("the project's default branch (production) exists");
    expect(f["neon.compute"]?.says).toBe(
      "production's compute: it sleeps after Neon's default five minutes, not never sleeps and it scales 0.25 to 8 CU, not 0.5 to 2",
    );
    expect(f["neon.compute"]?.fix).toBe(
      "bun scripts/prod/apply.ts neon --env production --yes (founder step D3)",
    );
    expect(f["neon.history"]?.says).toBe("point-in-time history keeps 1 day, not 7 days");
    expect(f["neon.backups"]?.says).toBe("production has no backup schedule");
  });
});

describe("production, as the founder's steps leave it", () => {
  const good = () => {
    const want = filledProduction();
    return { want, answers: appliedDefault(want.realtimeUrl as string) };
  };

  test("every line is ok; scale-to-zero off (-1) passes", () => {
    const { want, answers } = good();
    const findings = evaluateNeon(want, observeNeon(answers, "@default", NOW));
    expect(findings.filter((f) => f.status !== "ok")).toEqual([]);
    const f = byId(findings);
    expect(f["neon.compute"]?.says).toBe(
      "production's compute never sleeps and scales 0.5 to 2 CU",
    );
    expect(f["neon.backups"]?.says).toBe(
      "production is backed up daily at 07:00 UTC, kept 35 days",
    );
    expect(f["neon.snapshot"]?.says).toBe(
      "the latest snapshot of production was taken 7 hours ago",
    );
  });

  test("suspend 0 fails", () => {
    const { want, answers } = good();
    answers.endpoints = answers.endpoints.map((e) => ({ ...e, suspend_timeout_seconds: 0 }));
    const f = byId(evaluateNeon(want, observeNeon(answers, "@default", NOW)));
    expect(f["neon.compute"]?.status).toBe("fail");
    expect(f["neon.compute"]?.says).toBe(
      "production's compute: it sleeps after Neon's default five minutes, not never sleeps",
    );
  });

  test("no backup schedule is pending, never ok", () => {
    const { want, answers } = good();
    answers.schedule = { schedule: [] };
    const f = byId(evaluateNeon(want, observeNeon(answers, "@default", NOW)));
    expect(f["neon.backups"]?.status).toBe("pending");
    expect(f["neon.snapshot"]?.status).toBe("pending");
    answers.schedule = null;
    const g = byId(evaluateNeon(want, observeNeon(answers, "@default", NOW)));
    expect(g["neon.backups"]?.says).toBe(
      "Neon shows no backup schedule for production (the plan may not offer one)",
    );
  });

  test("a snapshot older than 26 hours fails, and a schedule with none fails", () => {
    const { want, answers } = good();
    answers.snapshots = [{ name: "daily", created_at: "2026-11-11T12:00:00Z", manual: false }];
    const f = byId(evaluateNeon(want, observeNeon(answers, "@default", NOW)));
    expect(f["neon.snapshot"]?.says).toBe(
      "the latest snapshot of production is 27 hours old, more than 26",
    );
    answers.snapshots = [];
    const g = byId(evaluateNeon(want, observeNeon(answers, "@default", NOW)));
    expect(g["neon.snapshot"]?.says).toBe("production has a schedule but no snapshot");
  });

  test("a deploy's own snapshot does not stand in for a schedule that stopped", () => {
    const { want, answers } = good();
    answers.snapshots = [
      { name: "daily", created_at: "2026-11-10T07:00:00Z", manual: false },
      { name: "pre-0123456789ab", created_at: "2026-11-12T14:00:00Z", manual: true },
    ];
    const f = byId(evaluateNeon(want, observeNeon(answers, "@default", NOW)));
    expect(f["neon.snapshot"]?.status).toBe("fail");
  });

  test("Realtime off before infra names its URL is pending, after it fails", () => {
    const { want, answers } = good();
    answers.realtime = { enabled: false, invocation_url: null };
    const before = byId(
      evaluateNeon({ ...want, realtimeUrl: null }, observeNeon(answers, "@default", NOW)),
    );
    expect(before["neon.realtime"]?.status).toBe("pending");
    const after = byId(evaluateNeon(want, observeNeon(answers, "@default", NOW)));
    expect(after["neon.realtime"]?.status).toBe("fail");
  });

  test("Realtime at another URL than infra's fails", () => {
    const { want, answers } = good();
    answers.realtime = { enabled: true, invocation_url: "https://ep-other.rt.example.neon.tech/" };
    const f = byId(evaluateNeon(want, observeNeon(answers, "@default", NOW)));
    expect(f["neon.realtime"]?.status).toBe("fail");
  });
});

describe("fetchNeon", () => {
  const PROJECT = "project-id-not-public";
  const ctx = (fetch: typeof globalThis.fetch): CheckContext => ({
    env: "dev",
    infra,
    credentials: { NEON_API_KEY: "neon-test-key", NEON_PROJECT_ID: PROJECT },
    fetch,
    now: () => new Date(NOW),
    deep: false,
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("reads with GETs only, never a secret or a connection string", async () => {
    const dev = fixture("dev-branch.json");
    const seen: string[] = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname}`);
      const path = url.pathname.replace(`/api/v2/projects/${PROJECT}`, "");
      if (path === "") return json({ project: { id: PROJECT, ...dev.project } });
      if (path === "/branches") {
        return json({
          branches: dev.branches.map((b, i) => ({ ...b, id: `br-${i}` })),
          pagination: {},
        });
      }
      if (path === "/branches/br-0/endpoints") return json({ endpoints: dev.endpoints });
      if (path === "/branches/br-0/backup_schedule") return json(dev.schedule);
      if (path === "/snapshots") return json({ snapshots: [] });
      if (path === "/branches/br-0/realtime") return json(dev.realtime);
      return json({ message: "unexpected" }, 500);
    }) as typeof globalThis.fetch;
    const observed = await fetchNeon(ctx(fake), desired("dev"));
    expect(seen.every((line) => line.startsWith("GET "))).toBe(true);
    expect(seen.some((line) => /secret|connection_uri|password/.test(line))).toBe(false);
    expect(observed).toEqual(observeNeon(dev, "dev", NOW));
  });

  test("an error says Neon's status, never the request or its key", async () => {
    const fake = (async () =>
      json(
        { message: "key neon-test-key is not allowed" },
        403,
      )) as unknown as typeof globalThis.fetch;
    const error = await fetchNeon(ctx(fake), desired("dev")).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Neon answered 403");
  });
});
