#!/usr/bin/env bun
/**
 * Whether this push deploys the API at all (.github/workflows/deploy-api.yml, its `plan` job).
 *
 *   bun scripts/ci/deploy-plan.ts --commit <sha> [--production] [--always]
 *
 * `--always` is a dispatch by hand: it deploys even when nothing changed, never backwards.
 *
 * It asks each environment the deploy goes to which commit it serves (`/v1/health`, public),
 * and compares that commit with this one, not with the commit before this push:
 *
 * - Something the API is made from changed between the two (api-paths.ts): deploy.
 * - Nothing did: deploy nothing. A merge of docs, the studio or the phone leaves the API alone.
 * - The environment serves a commit newer than this one (someone deployed ahead of the queue):
 *   deploy nothing, so an older commit never replaces newer code.
 * - What it serves can't be read, or is not in main's history: deploy, since nothing proves
 *   the API is unchanged.
 *
 * Comparing with what is live is what makes skipping safe. GitHub keeps at most one run of this
 * workflow waiting: when a third merge arrives, the waiting run is cancelled and only the
 * newest is kept. Its diff runs from what is live, so it holds every change of the cancelled
 * commits, their migrations included, and `db:migrate` applies every migration in this
 * checkout's journal, which on main's linear history holds every older commit's.
 *
 * Production is compared only when `--production` says its job is on. With it off, production
 * is deployed by hand and lags, and comparing with it would deploy dev on every merge.
 *
 * Prints `deploy=true|false` (to $GITHUB_OUTPUT as well, in Actions) and the reason. Health
 * answers hold no secret.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { changesApi } from "./api-paths.ts";
import { apiUrlOf } from "./health.ts";

const ROOT = join(import.meta.dir, "../..");

export interface Git {
  /** Whether `ancestor` is `descendant` or one of its ancestors; false for an unknown commit. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** The files changed from one commit to the other. */
  changed(from: string, to: string): Promise<string[]>;
}

export interface Live {
  environment: string;
  /** The commit its health names, or null when it could not be read. */
  commit: string | null;
}

export interface Plan {
  deploy: boolean;
  /** One sentence per environment, for the run's summary. */
  reasons: string[];
  /** The files that change the API, from the oldest commit live to this one. */
  changes: string[];
}

/**
 * `always`: a dispatch by hand, which deploys whether or not anything changed (to try again
 * after a failure that was not the code's). It still never goes backwards.
 */
export async function plan(
  head: string,
  live: Live[],
  git: Git,
  { always = false }: { always?: boolean } = {},
): Promise<Plan> {
  const reasons: string[] = [];
  const changes = new Set<string>();
  let deploy = false;
  let ahead = false;
  for (const { environment, commit } of live) {
    if (!commit) {
      deploy = true;
      reasons.push(`${environment}: what it serves could not be read, so this deploys.`);
      continue;
    }
    if (commit === head) {
      reasons.push(`${environment}: already serves ${short(head)}.`);
      continue;
    }
    if (await git.isAncestor(head, commit)) {
      ahead = true;
      reasons.push(
        `${environment}: serves ${short(commit)}, which is newer than ${short(head)}; an older commit never replaces it.`,
      );
      continue;
    }
    if (!(await git.isAncestor(commit, head))) {
      deploy = true;
      reasons.push(
        `${environment}: serves ${short(commit)}, which is not in main's history before ${short(head)}, so this deploys.`,
      );
      continue;
    }
    const files = (await git.changed(commit, head)).filter(changesApi);
    for (const file of files) changes.add(file);
    if (files.length) {
      deploy = true;
      reasons.push(
        `${environment}: ${files.length} file${files.length === 1 ? "" : "s"} the API is made from changed since ${short(commit)}.`,
      );
    } else {
      reasons.push(`${environment}: nothing the API is made from changed since ${short(commit)}.`);
    }
  }
  if (ahead) return { deploy: false, reasons, changes: [...changes].sort() };
  if (always && !deploy) {
    deploy = true;
    reasons.push("Asked for by hand (a dispatch), so this deploys whatever changed.");
  }
  return { deploy, reasons, changes: [...changes].sort() };
}

const short = (sha: string) => sha.slice(0, 12);

/**
 * Why `head` must not go to an environment that serves `live`, or null when it may: the guard
 * the dev and production jobs run before they touch the database. The plan already refuses to
 * go backwards, but "Re-run failed jobs" on an older run reuses that run's plan and runs its dev
 * or production job again, by then behind a newer run. What is live can't be read, or is not in
 * main's history: it may go (the same rule as the plan).
 */
export async function behind(
  head: string,
  { environment, commit }: Live,
  git: Git,
): Promise<string | null> {
  if (!commit || commit === head) return null;
  if (!(await git.isAncestor(head, commit))) return null;
  return `${environment} serves ${short(commit)}, which is newer than ${short(head)}. This is an older run started again; it deploys nothing, so newer code is never replaced.`;
}

/** The commit an environment's public health names, or null. */
export async function liveCommit(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetcher(`${url.replace(/\/$/, "")}/v1/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => null)) as { commit?: unknown } | null;
    return typeof body?.commit === "string" && /^[0-9a-f]{40}$/.test(body.commit)
      ? body.commit
      : null;
  } catch {
    return null;
  }
}

async function run(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
}

/** git in a checkout with main's whole history (`fetch-depth: 0`). */
export function gitIn(cwd: string): Git {
  return {
    async isAncestor(ancestor, descendant) {
      return (await run(["merge-base", "--is-ancestor", ancestor, descendant], cwd)).code === 0;
    },
    async changed(from, to) {
      const out = await run(["diff", "--name-only", "--no-renames", from, to], cwd);
      if (out.code !== 0) throw new Error(`git diff ${from} ${to} failed.`);
      return out.stdout.split("\n").filter(Boolean);
    },
  };
}

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const commit = arg(argv, "--commit");
  if (!commit) {
    console.error(
      "usage: bun scripts/ci/deploy-plan.ts --commit <sha> [--production] [--always] | --commit <sha> --guard <dev|production>",
    );
    process.exit(2);
  }
  const guarded = arg(argv, "--guard");
  if (guarded) {
    const live = { environment: guarded, commit: await liveCommit(apiUrlOf(guarded)) };
    const problem = await behind(commit, live, gitIn(ROOT));
    if (problem) {
      console.log(`::error title=An older commit, not deployed::${problem}`);
      process.exit(1);
    }
    console.log(
      `${guarded} serves ${live.commit ? short(live.commit) : "a commit that could not be read"}; ${short(commit)} is not older.`,
    );
    process.exit(0);
  }
  const environments = argv.includes("--production") ? ["dev", "production"] : ["dev"];
  const live = await Promise.all(
    environments.map(async (environment) => ({
      environment,
      commit: await liveCommit(apiUrlOf(environment)),
    })),
  );
  const result = await plan(commit, live, gitIn(ROOT), { always: argv.includes("--always") });
  for (const reason of result.reasons) console.log(reason);
  for (const file of result.changes) console.log(`  ${file}`);
  console.log(`deploy=${result.deploy}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${result.deploy}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Plan\n\n${result.reasons.map((r) => `- ${r}`).join("\n")}\n\n${result.deploy ? "This commit deploys." : "This commit deploys nothing."}\n\n`,
    );
}
