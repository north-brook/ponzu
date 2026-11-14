#!/usr/bin/env bun
/**
 * The deploy's last job (.github/workflows/deploy-api.yml, `report`): says in plain words what
 * happened and what is live where, in the run's summary, and keeps one GitHub issue labelled
 * `deploy-failed`:
 *
 * - A failed deploy opens it, or comments on the one already open, naming the commit, its pull
 *   request, the job and step that failed, the log, and whether production was put back.
 * - A deploy that does everything it was asked closes it, unless the issue records a production
 *   failure and this run left production out (a dispatch, or production switched off): that
 *   proves nothing about production. Each report on a production failure carries a hidden mark
 *   (PRODUCTION_MARK) so a later run can tell, whatever the variables say by then.
 * - A push that deployed nothing (deploy-plan.ts) leaves it as it is: it proved nothing.
 *
 *   bun scripts/ci/deploy-report.ts
 *
 * It reads the run's jobs from the environment the workflow gives it (`fromEnv`), the failed
 * step and the pull request from GitHub with gh, and what each environment serves from its
 * public `/v1/health`. Nothing it reads or writes is a secret.
 */
import { appendFileSync } from "node:fs";
import { $ } from "bun";
import { apiUrlOf } from "./health.ts";

export const LABEL = "deploy-failed";

/** Hidden in every report on a run whose production job failed, so a dev-only run leaves it open. */
export const PRODUCTION_MARK = "<!-- deploy-failed: production -->";

/** A job's result as `needs.<job>.result` gives it. */
export type Result = "success" | "failure" | "cancelled" | "skipped" | "";

export interface Run {
  commit: string;
  /** The run's address, for the log. */
  runUrl: string;
  plan: Result;
  /** The plan's answer: whether this commit deploys. */
  deploy: boolean;
  dev: Result;
  /** Whether this run was to deploy production (its variable on, and a push). */
  productionOn: boolean;
  /** Whether production deploys at all (its variable on), whatever this run's event. */
  productionEnabled: boolean;
  production: Result;
  /** How the promotion went, as `steps.promote.outcome` gives it. */
  promote: Result;
  /** Outcomes of the production job's way back, as `steps.<id>.outcome` gives them. */
  rollback: Result;
  restored: Result;
  rollbackMinute: Result;
  /** The commit that was serving production before the promotion, if it was recorded. */
  previousCommit: string;
}

export interface FailedStep {
  job: string;
  step: string;
  url: string;
}

export interface GitHub {
  /** The first failed step of this run, and its job's log. */
  failedStep(): Promise<FailedStep | null>;
  /** The pull request that merged as this commit. */
  pullRequest(commit: string): Promise<number | null>;
  openIssue(): Promise<number | null>;
  /** Whether the issue's body or a comment on it carries PRODUCTION_MARK. */
  recordsProductionFailure(number: number): Promise<boolean>;
  createIssue(title: string, body: string): Promise<number>;
  comment(number: number, body: string): Promise<void>;
  closeIssue(number: number, comment: string): Promise<void>;
}

export type Verdict = "deployed" | "nothing" | "failed";

export function verdictOf(run: Run): Verdict {
  if (run.plan !== "success") return "failed";
  if (!run.deploy) return "nothing";
  if (run.dev !== "success") return "failed";
  if (run.productionOn && run.production !== "success") return "failed";
  return "deployed";
}

/** What happened to production, in one sentence. */
export function productionSentence(run: Run): string {
  if (!run.productionOn)
    return run.productionEnabled
      ? "Production was not part of this run: a dispatch deploys dev alone, and production takes this commit at the next push that changes the API."
      : "Production was not part of this run.";
  if (run.production === "skipped" || run.production === "")
    return "Production was not touched: it deploys only after dev has passed.";
  if (run.production === "success") return "Production was deployed and promoted.";
  const promoted = run.promote !== "skipped" && run.promote !== "";
  if ((run.rollback === "skipped" || run.rollback === "") && !promoted)
    return "Production was not promoted, so it still serves what it served before.";
  if (run.rollback === "skipped" || run.rollback === "")
    return `PRODUCTION MAY BE SERVING THE FAILED DEPLOYMENT: the job stopped after the promotion had started, and nothing was put back. Act now (docs/production.md, "The production deploy, staged").`;
  if (run.rollback !== "success")
    return `PRODUCTION MAY BE SERVING THE FAILED DEPLOYMENT: putting back ${short(run.previousCommit)} failed. Act now (docs/production.md, "The production deploy, staged").`;
  if (run.restored !== "success")
    return `PRODUCTION DID NOT ANSWER AS ${short(run.previousCommit)} AFTER IT WAS PUT BACK. Act now (docs/production.md, "The production deploy, staged").`;
  if (run.rollbackMinute !== "success")
    return `Production was put back on ${short(run.previousCommit)}, BUT ITS MINUTE IS NOT ACTIVE: turn Disable Cron Jobs off (docs/production.md, "The minute").`;
  return `Production failed its checks after promotion and was put back on ${short(run.previousCommit)}; the database keeps the new migrations, which the old code runs on.`;
}

const short = (sha: string) => (sha ? sha.slice(0, 12) : "the deployment that was serving");

export interface Live {
  dev: string;
  production: string;
}

export function summary(
  run: Run,
  verdict: Verdict,
  live: Live,
  step: FailedStep | null,
  pr: number | null,
): string {
  const head =
    verdict === "deployed"
      ? `Deployed ${short(run.commit)}.`
      : verdict === "nothing"
        ? `${short(run.commit)} changes nothing the API is made from, so nothing was deployed.`
        : `The deploy of ${short(run.commit)} failed${step ? ` at "${step.job}" › "${step.step}"` : ""}.`;
  const productionFailed =
    run.productionOn &&
    run.production !== "success" &&
    run.production !== "skipped" &&
    run.production !== "";
  return [
    `## API deploy`,
    "",
    head,
    "",
    `- Commit: ${run.commit}${pr ? ` (#${pr})` : ""}`,
    `- ${productionSentence(run)}`,
    `- Dev serves ${live.dev}.`,
    `- Production serves ${live.production}.`,
    `- Log: ${step?.url ?? run.runUrl}`,
    "",
    ...(productionFailed ? [PRODUCTION_MARK, ""] : []),
  ].join("\n");
}

/** One run's report: the summary, and the issue opened, added to or closed. */
export async function report(deps: {
  run: Run;
  github: GitHub;
  live: () => Promise<Live>;
}): Promise<{ verdict: Verdict; text: string; issue: number | null; action: string }> {
  const { run, github } = deps;
  const verdict = verdictOf(run);
  const live = await deps.live();
  const step = verdict === "failed" ? await github.failedStep() : null;
  const pr = await github.pullRequest(run.commit);
  const text = summary(run, verdict, live, step, pr);
  if (verdict === "nothing") return { verdict, text, issue: null, action: "none" };
  const open = await github.openIssue();
  if (verdict === "deployed") {
    if (open === null) return { verdict, text, issue: open, action: "none" };
    if (!run.productionOn && (await github.recordsProductionFailure(open)))
      return { verdict, text, issue: open, action: "left open" };
    await github.closeIssue(open, text);
    return { verdict, text, issue: open, action: "closed" };
  }
  if (open !== null) {
    await github.comment(open, text);
    return { verdict, text, issue: open, action: "commented" };
  }
  const number = await github.createIssue(`The API deploy of ${short(run.commit)} failed`, text);
  return { verdict, text, issue: number, action: "opened" };
}

const RESULTS = new Set(["success", "failure", "cancelled", "skipped", ""]);
const result = (value: string | undefined): Result =>
  (RESULTS.has(value ?? "") ? (value ?? "") : "failure") as Result;

/** The run as the workflow passes it in. */
export function fromEnv(env: Record<string, string | undefined>): Run {
  return {
    commit: env.GITHUB_SHA ?? "",
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    plan: result(env.PLAN),
    deploy: env.DEPLOY === "true",
    dev: result(env.DEV),
    productionOn: env.PRODUCTION_ON === "true",
    productionEnabled: env.PRODUCTION_ENABLED === "true",
    production: result(env.PRODUCTION),
    promote: result(env.PROMOTE),
    rollback: result(env.ROLLBACK),
    restored: result(env.RESTORED),
    rollbackMinute: result(env.ROLLBACK_MINUTE),
    previousCommit: /^[0-9a-f]{40}$/.test(env.PREVIOUS_COMMIT ?? "")
      ? (env.PREVIOUS_COMMIT as string)
      : "",
  };
}

/** What an environment's public health says it serves. */
export async function serves(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  try {
    const response = await fetcher(`${url.replace(/\/$/, "")}/v1/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return `nothing readable (HTTP ${response.status})`;
    const commit = typeof body.commit === "string" ? body.commit.slice(0, 12) : "an unknown commit";
    return `${commit} (status ${String(body.status)}, ${String(body.environment)})`;
  } catch (error) {
    return `no answer (${error instanceof Error ? error.message : String(error)})`;
  }
}

export type Gh = (args: string[], input?: string) => Promise<string>;

export function ghGitHub(gh: Gh, repository: string, runId: string): GitHub {
  return {
    async failedStep() {
      const jobs = JSON.parse(
        await gh([
          "api",
          `repos/${repository}/actions/runs/${runId}/jobs?per_page=50`,
          "--jq",
          "[.jobs[] | {name, html_url, conclusion, steps: [.steps[]? | {name, conclusion}]}]",
        ]),
      ) as {
        name: string;
        html_url: string;
        conclusion: string | null;
        steps: { name: string; conclusion: string | null }[];
      }[];
      const stopped = new Set(["failure", "cancelled", "timed_out"]);
      for (const job of jobs) {
        const step = job.steps.find((s) => s.conclusion === "failure");
        if (step) return { job: job.name, step: step.name, url: job.html_url };
      }
      // Nothing failed outright: a job cancelled or out of time names the step it stopped in.
      for (const job of jobs) {
        if (!stopped.has(job.conclusion ?? "")) continue;
        const how =
          job.conclusion === "timed_out" ? "the job ran out of time" : "the job was cancelled";
        const step = job.steps.find((s) => s.conclusion === "cancelled");
        return { job: job.name, step: step ? `${step.name} (${how})` : how, url: job.html_url };
      }
      return null;
    },
    async pullRequest(commit) {
      const out = await gh([
        "api",
        `repos/${repository}/commits/${commit}/pulls`,
        "--jq",
        "[.[] | select(.merged_at != null) | .number][0] // empty",
      ]).catch(() => "");
      const number = Number(out.trim());
      return Number.isInteger(number) && number > 0 ? number : null;
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
          "number",
          "--limit",
          "20",
        ]),
      ) as { number: number }[];
      return issues.map((i) => i.number).sort((a, b) => a - b)[0] ?? null;
    },
    async recordsProductionFailure(number) {
      // If the issue can't be read, it is left open: closing it would claim too much.
      const out = await gh([
        "issue",
        "view",
        String(number),
        "--repo",
        repository,
        "--json",
        "body,comments",
        "--jq",
        '[.body, .comments[].body] | map(select(. != null)) | join("\\n")',
      ]).catch(() => PRODUCTION_MARK);
      return out.includes(PRODUCTION_MARK);
    },
    async createIssue(title, body) {
      await gh([
        "label",
        "create",
        LABEL,
        "--repo",
        repository,
        "--color",
        "B60205",
        "--description",
        "The API deploy failed (deploy-api.yml)",
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
    async comment(number, body) {
      await gh(
        ["issue", "comment", String(number), "--repo", repository, "--body-file", "-"],
        body,
      );
    },
    async closeIssue(number, comment) {
      await gh(
        ["issue", "comment", String(number), "--repo", repository, "--body-file", "-"],
        comment,
      );
      await gh(["issue", "close", String(number), "--repo", repository]);
    },
  };
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repository || !runId) {
    console.error(
      "deploy-report.ts runs in GitHub Actions: GITHUB_REPOSITORY and GITHUB_RUN_ID are unset.",
    );
    process.exit(2);
  }
  const gh: Gh = async (args, input) => {
    const command = input === undefined ? $`gh ${args}` : $`gh ${args} < ${Buffer.from(input)}`;
    return (await command.quiet()).stdout.toString();
  };
  const run = fromEnv(process.env);
  const outcome = await report({
    run,
    github: ghGitHub(gh, repository, runId),
    live: async () => ({
      dev: await serves(apiUrlOf("dev")),
      production: await serves(apiUrlOf("production")),
    }),
  });
  console.log(outcome.text);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${outcome.text}\n`);
  if (outcome.issue) console.log(`Issue #${outcome.issue}: ${outcome.action}.`);
  if (outcome.verdict === "failed") {
    console.log(
      `::error title=The API deploy failed::${productionSentence(run).replace(/[\r\n%]/g, " ")}`,
    );
    process.exit(1);
  }
}
