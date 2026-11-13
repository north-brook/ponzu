import { describe, expect, test } from "bun:test";
import { listArgs, type Run, scheduleProblems, waitForSchedule } from "./schedules.ts";

const WANT = { name: "minute", path: "/v1/cron/minute" };

/** A schedule object as https://vercel.com/docs/schedules/http-api shows one. */
const MINUTE = {
  scheduleId: "sch_01",
  ownerId: "team_1",
  projectId: "prj_1",
  name: "minute",
  namespace: "default",
  timezone: "UTC",
  expression: { type: "cron", cron: "* * * * *" },
  jitter: 1,
  target: { type: "path", path: "/v1/cron/minute", requestMethod: "GET" },
  state: "active",
  source: "static",
  createdAt: 1793750400000,
  updatedAt: 1793750400000,
};
/** The CLI's two JSON shapes: a person's, and an agent's (non-interactive). */
const page = (data: unknown[], cursor: string | null = null) => ({
  data,
  cursor,
  pagination: { next: cursor },
});
const agentPage = (data: unknown[]) => ({
  status: "ok",
  data,
  cursor: null,
  pagination: { next: null },
  message: `Found ${data.length} schedules in namespace default.`,
});

describe("the minute's schedule", () => {
  test("an active minute on GET /v1/cron/minute passes, in either of the CLI's shapes", () => {
    expect(scheduleProblems(page([MINUTE]), WANT)).toEqual([]);
    expect(scheduleProblems(agentPage([{ ...MINUTE, name: "other" }, MINUTE]), WANT)).toEqual([]);
  });

  test("inactive, temporary, missing, or aimed elsewhere fails, naming why", () => {
    expect(scheduleProblems(page([{ ...MINUTE, state: "inactive" }]), WANT)).toEqual([
      'minute is "inactive"',
    ]);
    expect(scheduleProblems(page([{ ...MINUTE, activeUntil: 1793750460000 }]), WANT)).toEqual([
      "minute is active only until 1793750460000",
    ]);
    expect(scheduleProblems(page([]), WANT)).toEqual(["no schedule named minute"]);
    expect(scheduleProblems(page([], "next"), WANT)).toEqual([
      "no schedule named minute on the first page, and more pages follow",
    ]);
    expect(
      scheduleProblems(page([{ ...MINUTE, target: { type: "path", path: "/v1/x" } }]), WANT),
    ).toEqual(['minute targets {"type":"path","path":"/v1/x"}, not the path /v1/cron/minute']);
    // A path target sends POST unless it says GET.
    expect(
      scheduleProblems(
        page([{ ...MINUTE, target: { type: "path", path: "/v1/cron/minute" } }]),
        WANT,
      ),
    ).toEqual(["minute sends POST, not GET"]);
    expect(scheduleProblems({ status: "error", message: "Not authorized" }, WANT)).toEqual([
      "the CLI answered error: Not authorized",
    ]);
    expect(scheduleProblems("nope", WANT)).toEqual(["the CLI's answer is not JSON"]);
    expect(scheduleProblems({}, WANT)).toEqual(["the CLI's answer has no data list"]);
  });

  test("production is the CLI's default; another environment is named", () => {
    expect(listArgs("production")).toEqual([
      "bunx",
      "vercel@65.14.0",
      "schedules",
      "list",
      "--json",
      "--limit",
      "100",
    ]);
    expect(listArgs("dev").slice(-2)).toEqual(["--environment", "dev"]);
  });

  test("it polls until the schedule syncs after promotion, with no real waiting", async () => {
    const answers = [page([]), page([{ ...MINUTE, state: "inactive" }]), page([MINUTE])];
    const seen: string[][] = [];
    let t = 0;
    const run: Run = async (argv) => {
      seen.push(argv);
      return { code: 0, stdout: JSON.stringify(answers.shift()) };
    };
    const result = await waitForSchedule("production", WANT, {
      run,
      now: () => t,
      wait: async (ms) => {
        t += ms;
      },
    });
    expect(result.ok).toBe(true);
    expect(seen.length).toBe(3);
    expect(t).toBe(20_000);
  });

  test("it gives up at the deadline, and a CLI that fails never passes", async () => {
    let t = 0;
    const result = await waitForSchedule("production", WANT, {
      run: async () => ({ code: 1, stdout: "Error: not linked" }),
      now: () => t,
      wait: async (ms) => {
        t += ms;
      },
      intervalMs: 10_000,
      deadlineMs: 30_000,
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["the CLI exited 1 without JSON"]);
    expect(t).toBe(30_000);
    // Right JSON with a failing exit code still fails.
    const odd = await waitForSchedule("production", WANT, {
      run: async () => ({ code: 1, stdout: JSON.stringify(page([MINUTE])) }),
      now: () => 0,
      wait: async () => {},
      deadlineMs: 0,
    });
    expect(odd).toMatchObject({ ok: false, problems: ["the CLI exited 1"] });
  });
});
