#!/usr/bin/env bun
/**
 * Production's uptime check, run every five minutes by .github/workflows/uptime.yml:
 *
 *   bun scripts/ci/uptime.ts [--url <origin>]
 *
 * It asks production's `/v1/health` up to three times, 15 seconds apart. Production is up when
 * one answer is a 200 with `status` ok, `database` true and `environment` production (so a
 * domain pointing at the wrong project is down). It does not compare the commit, the image or
 * the migration count with this checkout, because a merged commit waits for the founder's
 * approval before it deploys; the deploy's own health check (scripts/ci/health.ts) does that.
 *
 * Production is down after two failing runs in a row, and then one open issue labelled
 * `production-down` says so:
 *
 * - The first failing run opens nothing and fails, so a single blip pages nobody. The next run
 *   reads that run's conclusion back from the Actions API: that is the only state kept outside
 *   the issue.
 * - The second failing run in a row opens the issue.
 * - Each later failing run updates the issue's body (how many runs in a row, the last
 *   problem, when it was seen) rather than commenting, so a long outage is one notification.
 *   The count lives in the issue, in a marker comment in its body.
 * - The first run that finds production up comments on the issue and closes it.
 *
 * Every run that finds production down fails, which is also what the next run reads. The
 * origin defaults to production's `apiUrl` in infra/environments.json. Health answers hold no
 * secret, and the token gh uses is never printed.
 */
import { $ } from "bun";
import { apiUrlOf } from "./health";

export const LABEL = "production-down";
/** Conclusions that say nothing about production: the run never judged it. */
const NO_VERDICT = new Set(["cancelled", "skipped", "neutral", "stale", "action_required"]);
const MARKER = /<!-- uptime (\{[^\n]*?\}) -->/;

export interface Probe {
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

/** Why one health answer is not production being up, or null when it is. */
export function problemOf(status: number, body: unknown): string | null {
  const health = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (status !== 200) problems.push(`HTTP ${status}`);
  if (health.status !== "ok") problems.push(`status is ${JSON.stringify(health.status ?? null)}`);
  if (health.database !== true) problems.push("the database cannot be reached");
  if (health.environment !== "production")
    problems.push(`environment is ${JSON.stringify(health.environment ?? null)}, not production`);
  return problems.length ? problems.join("; ") : null;
}

/** Asks `/v1/health` until one answer is up, or the attempts run out. */
export async function probe(
  url: string,
  {
    fetch: fetcher = fetch,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = 3,
    intervalMs = 15_000,
    timeoutMs = 10_000,
  }: Probe = {},
): Promise<{ up: boolean; problem: string | null }> {
  let problem: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetcher(`${url.replace(/\/$/, "")}/v1/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.json().catch(() => null);
      problem = problemOf(response.status, body);
    } catch (error) {
      problem = `no answer: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!problem) return { up: true, problem: null };
    if (attempt < attempts) await wait(intervalMs);
  }
  return { up: false, problem };
}

export interface Issue {
  number: number;
  body: string;
}

/** The GitHub calls the check makes; gh in the workflow, a fake in tests. */
export interface GitHub {
  /**
   * When the uptime workflow's latest completed run before this one started, if it failed;
   * null when it did not fail or there is none.
   */
  previousFailure(): Promise<string | null>;
  /** The open issue labelled production-down, if there is one (the oldest, if several). */
  openIssue(): Promise<Issue | null>;
  createIssue(title: string, body: string): Promise<number>;
  editIssue(number: number, body: string): Promise<void>;
  closeIssue(number: number, comment: string): Promise<void>;
}

export interface State {
  failures: number;
  since: string;
}

export function stateOf(body: string): State | null {
  const match = MARKER.exec(body);
  if (!match) return null;
  try {
    const state = JSON.parse(match[1] as string) as Partial<State>;
    if (typeof state.failures !== "number" || typeof state.since !== "string") return null;
    return { failures: state.failures, since: state.since };
  } catch {
    return null;
  }
}

export function issueBody(url: string, state: State, problem: string, now: Date): string {
  return [
    `\`${url}/v1/health\` has failed ${state.failures} uptime runs in a row, since ${state.since}.`,
    "",
    `Last checked ${now.toISOString()}: ${problem}.`,
    "",
    'The uptime workflow (.github/workflows/uptime.yml) updates this issue while production is down and closes it when production answers again. See docs/production.md, "Uptime".',
    "",
    `<!-- uptime ${JSON.stringify(state)} -->`,
  ].join("\n");
}

export type Outcome = "up" | "recovered" | "first_failure" | "opened" | "updated";

/** One run: probe, then open, update or close the issue. */
export async function check(deps: {
  url: string;
  github: GitHub;
  now: () => Date;
  probe: (url: string) => Promise<{ up: boolean; problem: string | null }>;
}): Promise<{ outcome: Outcome; up: boolean; problem: string | null; issue?: number }> {
  const { url, github, now } = deps;
  const result = await deps.probe(url);
  const issue = await github.openIssue();
  if (result.up) {
    if (!issue) return { outcome: "up", up: true, problem: null };
    const state = stateOf(issue.body);
    const since = state ? ` It had been down since ${state.since}.` : "";
    await github.closeIssue(
      issue.number,
      `Production answered \`/v1/health\` ok at ${now().toISOString()}.${since}`,
    );
    return { outcome: "recovered", up: true, problem: null, issue: issue.number };
  }
  const problem = result.problem ?? "no answer";
  if (issue) {
    const before = stateOf(issue.body);
    const state = {
      failures: (before?.failures ?? 1) + 1,
      since: before?.since ?? now().toISOString(),
    };
    await github.editIssue(issue.number, issueBody(url, state, problem, now()));
    return { outcome: "updated", up: false, problem, issue: issue.number };
  }
  const previous = await github.previousFailure();
  if (!previous) return { outcome: "first_failure", up: false, problem };
  const state = { failures: 2, since: previous };
  const number = await github.createIssue(
    "Production is down",
    issueBody(url, state, problem, now()),
  );
  return { outcome: "opened", up: false, problem, issue: number };
}

/** Runs gh with arguments and optional standard input, answering its standard output. */
export type Gh = (args: string[], input?: string) => Promise<string>;

/** The GitHub calls through gh, on `repository`, from the workflow run `runId`. */
export function ghGitHub(gh: Gh, repository: string, runId: string): GitHub {
  return {
    async previousFailure() {
      const runs = JSON.parse(
        await gh([
          "api",
          `repos/${repository}/actions/workflows/uptime.yml/runs?branch=main&status=completed&per_page=20`,
          "--jq",
          "[.workflow_runs[] | {id, status, conclusion, run_started_at}]",
        ]),
      ) as { id: number; status: string; conclusion: string | null; run_started_at: string }[];
      // A cancelled, skipped or still-running run said nothing about production, so the
      // previous result is the newest other run that finished with a verdict.
      const previous = runs.find(
        (run) =>
          String(run.id) !== runId &&
          run.status === "completed" &&
          run.conclusion !== null &&
          !NO_VERDICT.has(run.conclusion),
      );
      // A run that hit its timeout waited on production too long, so it counts as failing.
      return previous?.conclusion === "failure" || previous?.conclusion === "timed_out"
        ? previous.run_started_at
        : null;
    },
    async openIssue() {
      const issues = JSON.parse(
        await gh([
          "issue",
          "list",
          "--repo",
          repository,
          "--label",
          LABEL,
          "--state",
          "open",
          "--json",
          "number,body",
          "--limit",
          "20",
        ]),
      ) as Issue[];
      return issues.toSorted((a, b) => a.number - b.number)[0] ?? null;
    },
    async createIssue(title, body) {
      // The label is made the first time it is needed; --force leaves an existing one as is
      // apart from its colour and description.
      await gh([
        "label",
        "create",
        LABEL,
        "--repo",
        repository,
        "--color",
        "B60205",
        "--description",
        "Production's /v1/health failed twice in a row (uptime.yml)",
        "--force",
      ]);
      const url = await gh(
        [
          "issue",
          "create",
          "--repo",
          repository,
          "--title",
          title,
          "--label",
          LABEL,
          "--body-file",
          "-",
        ],
        body,
      );
      const number = Number(/\/issues\/(\d+)\s*$/.exec(url.trim())?.[1]);
      if (!Number.isInteger(number)) throw new Error(`gh issue create answered: ${url.trim()}`);
      return number;
    },
    async editIssue(number, body) {
      await gh(["issue", "edit", String(number), "--repo", repository, "--body-file", "-"], body);
    },
    async closeIssue(number, comment) {
      await gh(["issue", "close", String(number), "--repo", repository, "--comment", comment]);
    },
  };
}

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repository || !runId) {
    console.error(
      "uptime.ts runs in GitHub Actions: GITHUB_REPOSITORY and GITHUB_RUN_ID are unset.",
    );
    process.exit(2);
  }
  const gh: Gh = async (args, input) => {
    const command = input === undefined ? $`gh ${args}` : $`gh ${args} < ${Buffer.from(input)}`;
    return (await command.quiet()).stdout.toString();
  };
  const url = (arg(process.argv.slice(2), "--url") ?? apiUrlOf("production")).replace(/\/$/, "");
  const result = await check({
    url,
    github: ghGitHub(gh, repository, runId),
    now: () => new Date(),
    probe: (at) => probe(at),
  });
  const where = result.issue ? ` (#${result.issue})` : "";
  if (result.up) {
    console.log(`${url} is up: ${result.outcome}${where}.`);
  } else {
    const problem = (result.problem ?? "").replace(/[\r\n%]/g, " ");
    console.log(`::error title=${url} is down (${result.outcome}${where})::${problem}`);
    process.exit(1);
  }
}
