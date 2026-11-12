import { describe, expect, test } from "bun:test";
import {
  check,
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
const UP = { status: "ok", database: true, environment: "production", commit: "abc" };

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
    expect(problemOf(200, UP)).toBeNull();
    expect(problemOf(200, { ...UP, status: "degraded" })).toBe('status is "degraded"');
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

describe("the probe", () => {
  test("retries, and is up when a later attempt is", async () => {
    const waits: number[] = [];
    const { fetcher, asked } = fakeFetch([new Error("reset"), [200, UP]]);
    const result = await probe(`${URL}/`, {
      fetch: fetcher,
      wait: async (ms) => void waits.push(ms),
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
        "api repos/o/r/actions/workflows/uptime.yml/runs?branch=main&status=completed&per_page=5":
          JSON.stringify(list),
      });
    const failed = runs([
      { id: 9, conclusion: "failure", run_started_at: "t9" },
      { id: 8, conclusion: "failure", run_started_at: "t8" },
    ]);
    expect(await ghGitHub(failed.gh, "o/r", "9").previousFailure()).toBe("t8");
    expect(failed.calls[0]?.args).toEqual([
      "api",
      "repos/o/r/actions/workflows/uptime.yml/runs?branch=main&status=completed&per_page=5",
      "--jq",
      "[.workflow_runs[] | {id, conclusion, run_started_at}]",
    ]);
    const passed = runs([{ id: 8, conclusion: "success", run_started_at: "t8" }]);
    expect(await ghGitHub(passed.gh, "o/r", "9").previousFailure()).toBeNull();
    expect(await ghGitHub(runs([]).gh, "o/r", "9").previousFailure()).toBeNull();
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
