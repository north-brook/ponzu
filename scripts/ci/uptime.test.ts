import { describe, expect, test } from "bun:test";
import { CRON_FRESH_MS } from "../../apps/api/src/cron/heartbeat.ts";
import {
  CRON_STALE_MS,
  check,
  cronProblemOf,
  type Gh,
  type GitHub,
  ghGitHub,
  type Issue,
  issueBody,
  probe,
  problemOf,
  stateOf,
} from "./uptime";

const URL = "https://api.example.test";
/** The clock every answer below is judged by. */
const NOW = Date.parse("2026-11-12T16:00:00.000Z");
/** Up: the minute ran 30 seconds before `NOW`. */
const UP = {
  status: "ok",
  database: true,
  environment: "production",
  commit: "abc",
  cron: { lastRanAt: new Date(NOW - 30_000).toISOString() },
};

/** A fake fetch answering `answers` in turn (the last one again once they run out). */
function fakeFetch(answers: (readonly [number, unknown] | Error)[]) {
  const asked: string[] = [];
  let at = 0;
  const fetcher = (async (input: string | URL | Request) => {
    asked.push(String(input));
    const answer = answers[Math.min(at++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    const [status, body] = answer as readonly [number, unknown];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, asked };
}

describe("one health answer", () => {
  test("is up only as a 200 from production with its database", () => {
    expect(problemOf(200, UP, NOW)).toBeNull();
    expect(problemOf(200, { ...UP, status: "degraded" }, NOW)).toBe('status is "degraded"');
    expect(problemOf(503, { ...UP, status: "degraded", database: false })).toBe(
      'HTTP 503; status is "degraded"; the database cannot be reached',
    );
    expect(problemOf(200, { ...UP, environment: "dev" })).toBe(
      'environment is "dev", not production',
    );
    expect(problemOf(502, null)).toBe(
      "HTTP 502; status is null; the database cannot be reached; environment is null, not production",
    );
  });
});

describe("the minute, from health's cron.lastRanAt", () => {
  const ago = (ms: number) => ({ ...UP, cron: { lastRanAt: new Date(NOW - ms).toISOString() } });

  test("is stale at the API's own five minutes", () => {
    expect(CRON_STALE_MS).toBe(CRON_FRESH_MS);
    expect(CRON_STALE_MS).toBe(5 * 60_000);
  });

  test("is up under five minutes old, and down at five", () => {
    expect(problemOf(200, ago(0), NOW)).toBeNull();
    expect(problemOf(200, ago(CRON_STALE_MS - 1), NOW)).toBeNull();
    expect(problemOf(200, ago(CRON_STALE_MS), NOW)).toBe(
      "the minute last ran 5 minutes ago (2026-11-12T15:55:00.000Z)",
    );
    // A schedule turned off a day ago, or a scheduler that stopped: down, though every
    // request answers.
    expect(problemOf(200, ago(24 * 3_600_000), NOW)).toBe(
      "the minute last ran 1440 minutes ago (2026-11-11T16:00:00.000Z)",
    );
    // A time a little ahead of the runner's clock is fresh.
    expect(problemOf(200, ago(-30_000), NOW)).toBeNull();
  });

  test("null, an empty cron and an unreadable one are all down", () => {
    // Null: the minute has never run on production's database. Right after the first deploy
    // that lasts a minute or two, and one failing run opens no issue (`check`), so that is the
    // grace; past it, a schedule whose every run is refused would otherwise pass for ever.
    expect(problemOf(200, { ...UP, cron: { lastRanAt: null } }, NOW)).toBe(
      "cron.lastRanAt is null: the minute has never run on production's database",
    );
    expect(problemOf(200, { ...UP, cron: {} }, NOW)).toBe("the answer has no cron.lastRanAt");
    expect(problemOf(200, { ...UP, cron: { lastRanAt: "soon" } }, NOW)).toBe(
      'cron.lastRanAt is "soon"',
    );
    expect(cronProblemOf({ cron: { lastRanAt: 12 } }, NOW)).toBe("cron.lastRanAt is 12");
  });

  test("an answer with no cron at all is up: the API deployed before the field existed", () => {
    // uptime.yml runs from main as soon as this merges, while production still serves an API
    // built before `cron` was in its health. Counting that as down would open a false
    // production-down issue within ten minutes. Once production serves the field, a minute that
    // stops is judged by the rules above.
    const { cron: _, ...without } = UP;
    expect(problemOf(200, without, NOW)).toBeNull();
    expect(cronProblemOf(without, NOW)).toBeNull();
  });

  test("is judged only on an answer that is otherwise production's", () => {
    expect(problemOf(200, { ...ago(3_600_000), environment: "dev" }, NOW)).toBe(
      'environment is "dev", not production',
    );
  });

  test("the probe judges it by its own clock, and a stale minute fails every attempt", async () => {
    const { fetcher, asked } = fakeFetch([[200, ago(10 * 60_000)]]);
    const result = await probe(URL, { fetch: fetcher, wait: async () => {}, now: () => NOW });
    expect(result).toEqual({
      up: false,
      problem: "the minute last ran 10 minutes ago (2026-11-12T15:50:00.000Z)",
    });
    expect(asked.length).toBe(3);
  });
});

describe("the probe", () => {
  test("retries, and is up when a later attempt is", async () => {
    const waits: number[] = [];
    const { fetcher, asked } = fakeFetch([new Error("reset"), [200, UP]]);
    const result = await probe(`${URL}/`, {
      fetch: fetcher,
      wait: async (ms) => void waits.push(ms),
      now: () => NOW,
    });
    expect(result).toEqual({ up: true, problem: null });
    expect(asked).toEqual([`${URL}/v1/health`, `${URL}/v1/health`]);
    expect(waits).toEqual([15_000]);
  });

  test("is down after three failing attempts, with the last problem", async () => {
    const waits: number[] = [];
    const { fetcher, asked } = fakeFetch([[500, "oops"], new Error("timed out")]);
    const result = await probe(URL, { fetch: fetcher, wait: async (ms) => void waits.push(ms) });
    expect(result).toEqual({ up: false, problem: "no answer: timed out" });
    expect(asked.length).toBe(3);
    expect(waits).toEqual([15_000, 15_000]);
  });
});

/** A fake GitHub: issues in memory, and the previous run's conclusion set by the test. */
function fakeGitHub(previous: string | null = null) {
  const issues: (Issue & { open: boolean; comments: string[] })[] = [];
  const calls: string[] = [];
  const github: GitHub & { previous: string | null } = {
    previous,
    async previousFailure() {
      calls.push("previousFailure");
      return this.previous;
    },
    async openIssue() {
      const issue = issues.find((i) => i.open);
      return issue ? { number: issue.number, body: issue.body } : null;
    },
    async createIssue(title, body) {
      calls.push(`create ${title}`);
      const number = issues.length + 1;
      issues.push({ number, body, open: true, comments: [] });
      return number;
    },
    async editIssue(number, body) {
      calls.push(`edit #${number}`);
      const issue = issues.find((i) => i.number === number);
      if (issue) issue.body = body;
    },
    async closeIssue(number, comment) {
      calls.push(`close #${number}`);
      const issue = issues.find((i) => i.number === number);
      if (issue) Object.assign(issue, { open: false, comments: [...issue.comments, comment] });
    },
  };
  return { github, issues, calls };
}

describe("a run", () => {
  let clock = Date.parse("2026-11-12T10:00:00Z");
  const now = () => new Date(clock);
  type Probed = () => Promise<{ up: boolean; problem: string | null }>;
  const down: Probed = async () => ({ up: false, problem: "HTTP 503" });
  const up: Probed = async () => ({ up: true, problem: null });

  test("two failures open one issue, the third updates it, an ok closes it", async () => {
    const { github, issues, calls } = fakeGitHub();
    const run = (p: Probed) => check({ url: URL, github, now, probe: p });

    // The first failure opens nothing; the run fails, and the next run reads that back.
    expect(await run(down)).toEqual({ outcome: "first_failure", up: false, problem: "HTTP 503" });
    expect(issues).toEqual([]);
    github.previous = "2026-11-12T10:00:00Z";

    clock += 5 * 60_000;
    expect(await run(down)).toEqual({
      outcome: "opened",
      up: false,
      problem: "HTTP 503",
      issue: 1,
    });
    expect(issues.length).toBe(1);
    expect(stateOf(issues[0]?.body ?? "")).toEqual({
      failures: 2,
      since: "2026-11-12T10:00:00Z",
    });
    expect(issues[0]?.body).toBe(
      issueBody(URL, { failures: 2, since: "2026-11-12T10:00:00Z" }, "HTTP 503", now()),
    );

    clock += 5 * 60_000;
    expect((await run(down)).outcome).toBe("updated");
    expect(issues.length).toBe(1);
    expect(stateOf(issues[0]?.body ?? "")).toEqual({
      failures: 3,
      since: "2026-11-12T10:00:00Z",
    });
    expect(issues[0]?.body).toContain("Last checked 2026-11-12T10:10:00.000Z: HTTP 503.");

    clock += 5 * 60_000;
    expect(await run(up)).toEqual({ outcome: "recovered", up: true, problem: null, issue: 1 });
    expect(issues[0]?.open).toBe(false);
    expect(issues[0]?.comments).toEqual([
      "Production answered `/v1/health` ok at 2026-11-12T10:15:00.000Z. It had been down since 2026-11-12T10:00:00Z.",
    ]);

    clock += 5 * 60_000;
    expect((await run(up)).outcome).toBe("up");
    expect(calls).toEqual([
      "previousFailure",
      "previousFailure",
      "create Production is down",
      "edit #1",
      "close #1",
    ]);
  });

  test("a failure after a run that did not fail opens nothing", async () => {
    const { github, issues } = fakeGitHub(null);
    expect((await check({ url: URL, github, now, probe: down })).outcome).toBe("first_failure");
    expect(issues).toEqual([]);
  });

  test("an issue a person opened with the label, without the marker, is updated, not doubled", async () => {
    const { github, issues } = fakeGitHub("2026-11-12T09:55:00Z");
    issues.push({ number: 7, body: "Is the API down?", open: true, comments: [] });
    expect(await check({ url: URL, github, now, probe: down })).toMatchObject({
      outcome: "updated",
      issue: 7,
    });
    expect(issues.length).toBe(1);
    expect(stateOf(issues[0]?.body ?? "")?.failures).toBe(2);
  });

  test("the marker holds only what it should", () => {
    expect(stateOf("")).toBeNull();
    expect(stateOf("<!-- uptime {nope} -->")).toBeNull();
    expect(stateOf('<!-- uptime {"failures":"2","since":"x"} -->')).toBeNull();
  });
});

describe("the gh calls", () => {
  /** A fake gh answering by its first two arguments. */
  function fakeGh(answers: Record<string, string>) {
    const calls: { args: string[]; input?: string }[] = [];
    const gh: Gh = async (args, input) => {
      calls.push(input === undefined ? { args } : { args, input });
      return answers[`${args[0]} ${args[1]}`] ?? "";
    };
    return { gh, calls };
  }

  test("the previous run is the latest completed one that is not this run", async () => {
    const runs = (list: unknown) =>
      fakeGh({
        "api repos/o/r/actions/workflows/uptime.yml/runs?branch=main&status=completed&per_page=20":
          JSON.stringify(list),
      });
    const failed = runs([
      { id: 9, status: "completed", conclusion: "failure", run_started_at: "t9" },
      { id: 8, status: "completed", conclusion: "failure", run_started_at: "t8" },
    ]);
    expect(await ghGitHub(failed.gh, "o/r", "9").previousFailure()).toBe("t8");
    expect(failed.calls[0]?.args).toEqual([
      "api",
      "repos/o/r/actions/workflows/uptime.yml/runs?branch=main&status=completed&per_page=20",
      "--jq",
      "[.workflow_runs[] | {id, status, conclusion, run_started_at}]",
    ]);
    const passed = runs([
      { id: 8, status: "completed", conclusion: "success", run_started_at: "t8" },
    ]);
    expect(await ghGitHub(passed.gh, "o/r", "9").previousFailure()).toBeNull();
    const timedOut = runs([
      { id: 8, status: "completed", conclusion: "timed_out", run_started_at: "t8" },
    ]);
    expect(await ghGitHub(timedOut.gh, "o/r", "9").previousFailure()).toBe("t8");
    const cancelled = runs([
      { id: 8, status: "completed", conclusion: "cancelled", run_started_at: "t8" },
    ]);
    expect(await ghGitHub(cancelled.gh, "o/r", "9").previousFailure()).toBeNull();
    expect(await ghGitHub(runs([]).gh, "o/r", "9").previousFailure()).toBeNull();
  });

  test("a cancelled, skipped or still-running run is passed over for the one before it", async () => {
    const runs = (list: unknown) =>
      fakeGh({
        "api repos/o/r/actions/workflows/uptime.yml/runs?branch=main&status=completed&per_page=20":
          JSON.stringify(list),
      });
    const behindCancelled = runs([
      { id: 8, status: "completed", conclusion: "cancelled", run_started_at: "t8" },
      { id: 7, status: "in_progress", conclusion: null, run_started_at: "t7" },
      { id: 6, status: "completed", conclusion: "skipped", run_started_at: "t6" },
      { id: 5, status: "completed", conclusion: "failure", run_started_at: "t5" },
    ]);
    expect(await ghGitHub(behindCancelled.gh, "o/r", "9").previousFailure()).toBe("t5");
    const healthyBefore = runs([
      { id: 8, status: "completed", conclusion: "cancelled", run_started_at: "t8" },
      { id: 7, status: "completed", conclusion: "success", run_started_at: "t7" },
      { id: 6, status: "completed", conclusion: "failure", run_started_at: "t6" },
    ]);
    expect(await ghGitHub(healthyBefore.gh, "o/r", "9").previousFailure()).toBeNull();
  });

  test("open, create, edit and close", async () => {
    const { gh, calls } = fakeGh({
      "issue list": JSON.stringify([
        { number: 12, body: "b" },
        { number: 4, body: "a" },
      ]),
      "issue create": "https://github.com/o/r/issues/13\n",
    });
    const github = ghGitHub(gh, "o/r", "1");
    expect(await github.openIssue()).toEqual({ number: 4, body: "a" });
    expect(await github.createIssue("Production is down", "body")).toBe(13);
    await github.editIssue(13, "new body");
    await github.closeIssue(13, "ok again");
    expect(calls).toEqual([
      {
        args: [
          "issue",
          "list",
          "--repo",
          "o/r",
          "--label",
          "production-down",
          "--state",
          "open",
          "--json",
          "number,body",
          "--limit",
          "20",
        ],
      },
      {
        args: [
          "label",
          "create",
          "production-down",
          "--repo",
          "o/r",
          "--color",
          "B60205",
          "--description",
          "Production's /v1/health failed twice in a row (uptime.yml)",
          "--force",
        ],
      },
      {
        args: [
          "issue",
          "create",
          "--repo",
          "o/r",
          "--title",
          "Production is down",
          "--label",
          "production-down",
          "--body-file",
          "-",
        ],
        input: "body",
      },
      {
        args: ["issue", "edit", "13", "--repo", "o/r", "--body-file", "-"],
        input: "new body",
      },
      { args: ["issue", "close", "13", "--repo", "o/r", "--comment", "ok again"] },
    ]);
  });

  test("an issue create that answers no issue fails the run", async () => {
    const { gh } = fakeGh({ "issue create": "something went wrong" });
    await expect(ghGitHub(gh, "o/r", "1").createIssue("t", "b")).rejects.toThrow(
      "gh issue create answered",
    );
  });
});
