/**
 * The shape of the workflows that deploy, read from the YAML itself: which event runs which
 * job of deploy-api.yml, that no job runs from any branch but `main` or for a pull request,
 * that production never runs from a dispatch or before dev has passed, that the whole chain is
 * one run at a time, that dev deploys to its custom environment and only the production job
 * uses `--prod`, `promote` and production's own token, that both name the one Vercel project,
 * that only the production job may reach the Neon default branch, and when production is put
 * back; deploy-api.yml's own shell, run as it is written against fakes on PATH; that uptime.yml
 * checks only from main; and that release.yml's auto-merge step, run as it is written against a
 * fake gh, never auto-merges a release PR that scripts/release-hold.ts holds. actionlint (the
 * Workflows job in ci.yml) checks the rest of every file.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInfraFile } from "../prod/desired.ts";
import { apiUrlOf } from "./health.ts";
import { VERCEL_CLI } from "./schedules.ts";

const DIR = join(import.meta.dir, "../../.github/workflows");

/**
 * Runs a command to its end and gives back its output and exit code. Awaited, never spawnSync:
 * Bun 1.4.2's spawnSync can lose a child's exit in a `bun test --parallel` worker and wait on it
 * forever (oven-sh/bun#47257), which is what emptied this file's step output on CI.
 */
async function spawn(cmd: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn(cmd, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name: string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  environment?: string | { name: string };
  concurrency?: { group: string; "cancel-in-progress": boolean };
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  concurrency?: unknown;
  jobs: Record<string, Job>;
}

/** An Actions expression as a workflow writes it. */
const expr = (inner: string) => `$\{{ ${inner} }}`;

function load(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(DIR, name), "utf8")) as Workflow;
}

/** The parts of an Actions context these conditions read. */
interface Context {
  github: { event_name: string; ref: string };
  vars: Record<string, string>;
  /** `needs.<job>.result` and `.outputs.<name>`, for a job's condition. */
  needs?: Record<string, { result: string; outputs?: Record<string, string> }>;
  /** `steps.<id>.outcome` and `.outputs.<name>`, for a step's condition. */
  steps?: Record<string, { outcome: string; outputs?: Record<string, string> }>;
  /** What `success()` and `failure()` answer: how the job (or its needs) stands so far. */
  status?: "success" | "failure" | "cancelled";
}

const STATUS_FUNCTIONS = ["always", "success", "failure", "cancelled"];

/**
 * Evaluates an Actions `if:` written with `==`, `!=`, `&&`, `||`, `!`, parentheses, string
 * literals, the four status functions and context paths, as GitHub does: an unset variable is
 * null, which equals nothing, and a condition with no status function is read as
 * `success() && (…)`. Anything else in the expression throws, so a condition this can't read
 * fails the test.
 */
function evaluate(expression: string, context: Context): boolean {
  const source = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const tokens = source.match(/'(?:[^']|'')*'|==|!=|&&|\|\||!|\(|\)|[A-Za-z_][\w.-]*|\S/g) ?? [];
  const status = context.status ?? "success";
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  type Value = string | boolean | null;
  const truthy = (v: Value) => v !== null && v !== false && v !== "";
  const primary = (): Value => {
    const token = next();
    if (token === undefined) throw new Error(`Unexpected end of: ${source}`);
    if (token === "(") {
      const value = or();
      if (next() !== ")") throw new Error(`Unbalanced: ${source}`);
      return value;
    }
    if (token === "!") return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === "true" || token === "false") return token === "true";
    if (STATUS_FUNCTIONS.includes(token) && peek() === "(") {
      next();
      if (next() !== ")") throw new Error(`A status function takes nothing: ${source}`);
      if (token === "always") return true;
      return status === token;
    }
    const [root, ...path] = token.split(".");
    if (root === "github" && path.length === 1) {
      const value = context.github[path[0] as keyof Context["github"]];
      if (value === undefined) throw new Error(`Unknown context: ${token}`);
      return value;
    }
    if (root === "vars" && path.length === 1) return context.vars[path[0] as string] ?? null;
    if ((root === "needs" || root === "steps") && path.length >= 2) {
      const entry = (root === "needs" ? context.needs : context.steps)?.[path[0] as string];
      if (!entry) throw new Error(`Unknown ${root}: ${token}`);
      if (path[1] === "outputs" && path.length === 3) return entry.outputs?.[path[2]!] ?? "";
      if (path.length === 2 && path[1] === (root === "needs" ? "result" : "outcome"))
        return root === "needs"
          ? (entry as { result: string }).result
          : (entry as { outcome: string }).outcome;
    }
    throw new Error(`Not readable here: ${token}`);
  };
  const comparison = (): Value => {
    const left = primary();
    const op = peek();
    if (op !== "==" && op !== "!=") return left;
    next();
    const right = primary();
    return op === "==" ? left === right : left !== right;
  };
  const and = (): Value => {
    let value = comparison();
    while (peek() === "&&") {
      next();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  function or(): Value {
    let value = and();
    while (peek() === "||") {
      next();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  }
  const value = or();
  if (at !== tokens.length) throw new Error(`Left over in: ${source}`);
  const explicit = tokens.some((t, i) => STATUS_FUNCTIONS.includes(t) && tokens[i + 1] === "(");
  return truthy(value) && (explicit || status === "success");
}

const deploy = load("deploy-api.yml");
const EVENTS = ["push", "workflow_dispatch", "pull_request", "schedule"];
const REFS = ["refs/heads/cloud", "refs/heads/main", "refs/heads/feature", "refs/pull/1/merge"];
const VARS: Record<string, string>[] = [
  {},
  { API_DEPLOY: "true" },
  { API_DEPLOY_PRODUCTION: "true" },
  { API_DEPLOY: "true", API_DEPLOY_PRODUCTION: "true" },
  { API_DEPLOY: "false", API_DEPLOY_PRODUCTION: "yes" },
];
const JOBS = ["plan", "dev", "production", "report"] as const;
type JobId = (typeof JOBS)[number];

/**
 * Which jobs of deploy-api.yml run, in order, as GitHub would decide them: each job's `if`, with
 * `needs` holding what the jobs before it did. `plan` answers `deploy`; `failed` names jobs that
 * fail when they run.
 */
function chain(
  github: Context["github"],
  vars: Record<string, string>,
  { deploy = "true", failed = [] as JobId[] } = {},
): Record<JobId, string> {
  const results = {} as Record<JobId, string>;
  const needs: NonNullable<Context["needs"]> = {};
  for (const id of JOBS) {
    const job = deploy_job(id);
    const wanted = [job.needs ?? []].flat();
    const mine = Object.fromEntries(wanted.map((n) => [n, needs[n]!]));
    const status = wanted.every((n) => needs[n]?.result === "success")
      ? "success"
      : wanted.some((n) => needs[n]?.result === "cancelled")
        ? "cancelled"
        : "failure";
    // A job whose needs did not all succeed is skipped unless its condition says otherwise.
    const runs = evaluate(job.if ?? "true", { github, vars, needs: mine, status });
    const result = runs ? (failed.includes(id) ? "failure" : "success") : "skipped";
    results[id] = result;
    needs[id] = { result, outputs: id === "plan" && runs ? { deploy } : {} };
  }
  return results;
}
const deploy_job = (id: string) => deploy.jobs[id] as Job;
const productionSteps = deploy_job("production").steps;

/** Every context in which `job` runs, as "event ref vars", when every job before it passed. */
function runsIn(id: JobId): string[] {
  const out: string[] = [];
  for (const event_name of EVENTS)
    for (const ref of REFS)
      for (const vars of VARS)
        if (chain({ event_name, ref }, vars)[id] !== "skipped")
          out.push(`${event_name} ${ref} ${JSON.stringify(vars)}`);
  return out;
}

describe("the expression reader", () => {
  const ctx: Context = {
    github: { event_name: "push", ref: "refs/heads/main" },
    vars: { A: "true" },
  };
  test("reads what GitHub would", () => {
    expect(evaluate(expr("vars.A == 'true'"), ctx)).toBe(true);
    expect(evaluate("vars.B == 'true'", ctx)).toBe(false);
    expect(evaluate("vars.B != 'true'", ctx)).toBe(true);
    expect(evaluate("!(github.event_name == 'push') || vars.A == 'true'", ctx)).toBe(true);
    expect(evaluate("github.ref == 'refs/heads/cloud' && vars.A == 'true'", ctx)).toBe(false);
    expect(() => evaluate("startsWith(github.ref, 'x')", ctx)).toThrow();
    expect(() => evaluate("secrets.X == ''", ctx)).toThrow("Not readable here");
  });

  test("reads the status functions, needs and steps, with success() implied", () => {
    const failed: Context = { ...ctx, status: "failure", steps: { a: { outcome: "success" } } };
    expect(evaluate("vars.A == 'true'", failed)).toBe(false);
    expect(evaluate("failure() && steps.a.outcome == 'success'", failed)).toBe(true);
    expect(evaluate("always()", failed)).toBe(true);
    expect(evaluate("success()", failed)).toBe(false);
    const needs: Context = { ...ctx, needs: { p: { result: "success", outputs: { d: "x" } } } };
    expect(evaluate("needs.p.outputs.d == 'x' && needs.p.result == 'success'", needs)).toBe(true);
    expect(evaluate("needs.p.outputs.missing == ''", needs)).toBe(true);
    expect(() => evaluate("needs.q.result == 'success'", needs)).toThrow("Unknown needs");
  });
});

describe("deploy-api.yml", () => {
  test("is started by a push to main, or a dispatch; never a pull request or another branch", () => {
    expect(Object.keys(deploy.on).sort()).toEqual(["push", "workflow_dispatch"]);
    // `cloud` is retired: main is the branch everything merges into.
    expect(deploy.on.push).toEqual({ branches: ["main"] });
    // A dispatch takes no inputs, so it cannot ask for a target.
    expect(deploy.on.workflow_dispatch).toBeNull();
    expect(Object.keys(deploy.jobs)).toEqual([...JOBS]);
  });

  test("the whole chain is one run at a time, never cancelled", () => {
    // Workflow-wide: a second merge waits for the first run's dev, production, rollback and
    // report, and GitHub keeps only the newest waiting run.
    expect(deploy.concurrency).toEqual({ group: "deploy-api", "cancel-in-progress": false });
    for (const job of Object.values(deploy.jobs)) expect(job.concurrency).toBeUndefined();
  });

  test("the plan runs only on main, by a push or a dispatch, with API_DEPLOY on", () => {
    expect(runsIn("plan")).toEqual([
      'push refs/heads/main {"API_DEPLOY":"true"}',
      'push refs/heads/main {"API_DEPLOY":"true","API_DEPLOY_PRODUCTION":"true"}',
      'workflow_dispatch refs/heads/main {"API_DEPLOY":"true"}',
      'workflow_dispatch refs/heads/main {"API_DEPLOY":"true","API_DEPLOY_PRODUCTION":"true"}',
    ]);
    expect(runsIn("dev")).toEqual(runsIn("plan"));
  });

  test("production runs only on a push to main with both variables on, after dev", () => {
    expect(runsIn("production")).toEqual([
      'push refs/heads/main {"API_DEPLOY":"true","API_DEPLOY_PRODUCTION":"true"}',
    ]);
  });

  test("with today's variables (neither set) nothing runs, not even the plan", () => {
    for (const event_name of EVENTS)
      for (const ref of REFS)
        expect(chain({ event_name, ref }, {})).toEqual({
          plan: "skipped",
          dev: "skipped",
          production: "skipped",
          report: "skipped",
        });
  });

  test("a failure anywhere stops what follows it, and the report always runs", () => {
    const push = { event_name: "push", ref: "refs/heads/main" };
    const on = { API_DEPLOY: "true", API_DEPLOY_PRODUCTION: "true" };
    expect(chain(push, on)).toEqual({
      plan: "success",
      dev: "success",
      production: "success",
      report: "success",
    });
    // Nothing the API is made from changed: nothing deploys, and the report says so.
    expect(chain(push, on, { deploy: "false" })).toEqual({
      plan: "success",
      dev: "skipped",
      production: "skipped",
      report: "success",
    });
    // A dev failure of any kind (migration, deploy, health, selfcheck, canary) is the job's.
    expect(chain(push, on, { failed: ["dev"] })).toEqual({
      plan: "success",
      dev: "failure",
      production: "skipped",
      report: "success",
    });
    expect(chain(push, on, { failed: ["plan"] })).toEqual({
      plan: "failure",
      dev: "skipped",
      production: "skipped",
      report: "success",
    });
    expect(chain(push, on, { failed: ["production"] }).report).toBe("success");
    // A dispatch deploys dev and never production.
    const dispatch = { event_name: "workflow_dispatch", ref: "refs/heads/main" };
    expect(chain(dispatch, on).production).toBe("skipped");
  });

  test("each job runs in its own GitHub environment, on the one project", () => {
    const production = deploy.jobs.production as Job;
    expect(production.environment).toBe("production");
    const dev = deploy.jobs.dev as Job;
    expect(dev.environment).toBe("dev");
    // One Vercel project: both jobs name the same one, and the team.
    for (const job of [dev, production])
      expect(job.env).toEqual({
        VERCEL_ORG_ID: expr("vars.VERCEL_TEAM_ID"),
        VERCEL_PROJECT_ID: expr("vars.VERCEL_API_PROJECT_ID"),
      });
    // The plan and the report touch neither environment, and hold no secret.
    for (const id of ["plan", "report"]) {
      const job = deploy.jobs[id] as Job;
      expect(job.environment).toBeUndefined();
      expect(JSON.stringify(job)).not.toContain("secrets.");
    }
  });

  test("repo.json's environments are limited to their branch, and hold each job's secrets", () => {
    const repo = loadInfraFile("github/repo.json");
    expect(repo.environments.dev).toEqual({
      branches: ["main"],
      requiredReviewers: false,
      secrets: ["CANARY_SESSION_WRITER", "CRON_SECRET", "VERCEL_TOKEN"],
    });
    expect(repo.environments.production).toEqual({
      branches: ["main"],
      requiredReviewers: false,
      secrets: ["NEON_API_KEY", "VERCEL_AUTOMATION_BYPASS_SECRET", "VERCEL_TOKEN_PRODUCTION"],
    });
    // Only the production environment holds production's token and the bypass, never the
    // repository, so no other workflow or job can read them.
    for (const name of ["VERCEL_TOKEN_PRODUCTION", "VERCEL_AUTOMATION_BYPASS_SECRET"]) {
      expect(repo.secrets).not.toContain(name);
      expect(repo.environments.dev?.secrets).not.toContain(name);
    }
    // The canary's session is a repository secret, so its writer needs no right over any
    // environment; the writer lives in dev's environment alone.
    expect(repo.secrets).toContain("CANARY_SESSION");
    expect(repo.secrets).not.toContain("CANARY_SESSION_WRITER");
    expect(repo.secrets).not.toContain("CRON_SECRET");
  });

  /** Every `run:` of a job, and every expression its steps' env reads, as text. */
  const text = (job: string) =>
    (deploy.jobs[job] as Job).steps
      .flatMap((s) => [s.run ?? "", ...Object.values(s.env ?? {})])
      .join("\n");

  test("dev deploys to its custom environment and never with --prod or a production tool", () => {
    const dev = text("dev");
    expect(dev).toContain(
      'bunx vercel@65.14.0 deploy --environment dev --yes --env VERCEL_GIT_COMMIT_SHA="$GITHUB_SHA"',
    );
    expect(dev).not.toContain("--prod");
    expect(dev).not.toMatch(/(--environment|--target|-e)[ =]production/);
    for (const tool of ["promote", "rollback", "alias", "redeploy", "--skip-domain"])
      expect(dev).not.toContain(tool);
    expect(dev).toContain(expr("secrets.VERCEL_TOKEN"));
    expect(dev).not.toContain("VERCEL_TOKEN_PRODUCTION");
    expect(dev).not.toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(dev).not.toContain("production.ts");
  });

  test("dev checks health, then the selfcheck, then the canary, after its deploy", () => {
    const steps = (deploy.jobs.dev as Job).steps;
    const at = (needle: string) => steps.findIndex((s) => s.run?.includes(needle));
    const order = [
      at('[ -n "$CRON_SECRET" ]'),
      at('deploy-plan.ts --commit "$GITHUB_SHA" --guard dev'),
      at("db:migrate"),
      at("deploy --environment dev"),
      at("health.ts --env dev"),
      at("selfcheck.ts --env dev"),
      at("canary.ts --session-file"),
      at("gh secret set CANARY_SESSION"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    const canary = steps.find((s) => s.id === "canary") as Step;
    expect(canary.env).toEqual({
      CANARY_SESSION: expr("secrets.CANARY_SESSION"),
      CANARY_CAN_SAVE: expr("secrets.CANARY_SESSION_WRITER != ''"),
      CRON_SECRET: expr("secrets.CRON_SECRET"),
    });
    // The canary never sees the writer, and never the Anthropic key: the check account holds it.
    expect(JSON.stringify(steps)).not.toContain("ANTHROPIC");
    const keep = steps.find((s) => s.run?.includes("gh secret set")) as Step;
    expect(keep.env).toEqual({ GH_TOKEN: expr("secrets.CANARY_SESSION_WRITER") });
    // Kept whether the canary passed or not, once it has run.
    expect(keep.if).toBe(expr("always() && steps.canary.outputs.ran == 'true'"));
    for (const outcome of ["success", "failure"] as const)
      expect(
        evaluate(keep.if as string, {
          github: { event_name: "push", ref: "refs/heads/main" },
          vars: {},
          status: outcome,
          steps: { canary: { outcome, outputs: { ran: "true" } } },
        }),
      ).toBe(true);
    expect(
      evaluate(keep.if as string, {
        github: { event_name: "push", ref: "refs/heads/main" },
        vars: {},
        status: "success",
        steps: { canary: { outcome: "success", outputs: { ran: "false" } } },
      }),
    ).toBe(false);
  });

  test("only the production job uses --prod and promote, with production's own token", () => {
    const uses: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
      for (const [id, job] of Object.entries(load(file).jobs ?? {}))
        for (const step of job.steps ?? []) {
          const run = step.run ?? "";
          // `--target` is the CLI's deprecated spelling of `--environment`, and `-e` its
          // shorthand on redeploy.
          if (/\bvercel\b[^\n]*(--prod\b|(--environment|--target|-e)[ =]production\b)/.test(run))
            uses.push(`${file} ${id} prod`);
          if (/\bvercel\b[^\n]* (promote|rollback|alias|redeploy)\b/.test(run))
            uses.push(`${file} ${id} ${/ (promote|rollback|alias|redeploy)\b/.exec(run)?.[1]}`);
          // `vercel curl`, `vercel httpstat` and `deploy --verify` make a project-wide
          // Protection Bypass for Automation secret when the project has none (read from the
          // CLI 65.14.0's code; docs/production.md, "The production deploy, staged").
          expect(run).not.toMatch(/\bvercel\b[^\n]*( curl\b| httpstat\b|--verify\b)/);
        }
    }
    // The promotion, and the promotion back. Never `rollback`.
    expect(uses).toEqual([
      "deploy-api.yml production prod",
      "deploy-api.yml production promote",
      "deploy-api.yml production promote",
    ]);
    // Every step of production that runs the CLI or reads Vercel holds VERCEL_TOKEN_PRODUCTION,
    // never the repository-wide VERCEL_TOKEN (an environment secret only overrides one of the
    // same name).
    for (const step of (deploy.jobs.production as Job).steps) {
      if (step.env?.VERCEL_TOKEN !== undefined)
        expect(step.env.VERCEL_TOKEN).toBe(expr("secrets.VERCEL_TOKEN_PRODUCTION"));
      if (/\bvercel@|schedules\.ts|production\.ts serving/.test(step.run ?? ""))
        expect(step.env?.VERCEL_TOKEN).toBe(expr("secrets.VERCEL_TOKEN_PRODUCTION"));
    }
    expect(text("production")).not.toContain(expr("secrets.VERCEL_TOKEN"));
    // No other workflow reads production's token or the bypass.
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
      const yml = readFileSync(join(DIR, file), "utf8");
      const mentions =
        yml.split("secrets.VERCEL_TOKEN_PRODUCTION").length -
        1 +
        yml.split("secrets.VERCEL_AUTOMATION_BYPASS_SECRET").length -
        1;
      if (file !== "deploy-api.yml") expect(mentions).toBe(0);
    }
  });

  const indexOf = (match: (s: Step) => boolean, what: string) => {
    const i = productionSteps.findIndex(match);
    if (i < 0) throw new Error(`No step: ${what}`);
    return i;
  };

  test("production checks its token, records the way back, snapshots, migrates, stages, checks, promotes", () => {
    const steps = productionSteps;
    const token = indexOf((s) => !!s.run?.includes('[ -n "$VERCEL_TOKEN" ]'), "token");
    const guard = indexOf(
      (s) => s.run === 'bun scripts/ci/deploy-plan.ts --commit "$GITHUB_SHA" --guard production',
      "guard",
    );
    const serving = indexOf((s) => s.run === "bun scripts/ci/production.ts serving", "serving");
    const snapshot = indexOf((s) => !!s.run?.includes("neon.ts --default --snapshot"), "snapshot");
    const migrate = indexOf((s) => !!s.run?.includes("bun run db:migrate"), "migrate");
    const stage = indexOf(
      (s) => !!s.run?.includes("bunx vercel@65.14.0 deploy --prod --skip-domain --yes"),
      "stage",
    );
    const staged = indexOf((s) => !!s.run?.includes('--url "$URL" --bypass'), "staged health");
    const promote = indexOf(
      (s) => s.run === 'bunx vercel@65.14.0 promote "$URL" --json --timeout 5m',
      "promote",
    );
    const health = indexOf(
      (s) => s.run === 'bun scripts/ci/health.ts --env production --commit "$GITHUB_SHA"',
      "health",
    );
    const minute = indexOf(
      (s) =>
        s.run ===
          "bun scripts/ci/schedules.ts --environment production --name minute --path /v1/cron/minute" &&
        !s.if,
      "minute",
    );
    const rollback = indexOf((s) => s.id === "rollback", "rollback");
    const restored = indexOf((s) => s.id === "restored", "restored");
    const rollbackMinute = indexOf((s) => s.id === "rollback_minute", "rollback minute");
    const order = [
      token,
      guard,
      serving,
      snapshot,
      migrate,
      stage,
      staged,
      promote,
      health,
      minute,
      rollback,
      restored,
      rollbackMinute,
    ];
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(steps[serving]?.id).toBe("serving");
    expect(steps[promote]?.id).toBe("promote");
    expect(steps[migrate]?.run).toContain("neon.ts --default --direct");
    // The deploy never takes the domain itself: every --prod is staged.
    const prod = steps.filter((s) => /--prod\b/.test(s.run ?? ""));
    expect(prod.length).toBe(1);
    expect(prod[0]?.run).toContain("--skip-domain");
    // Neither promotion confirms itself: with no --yes, it refuses a deployment that is not a
    // production build instead of rebuilding it with production's variables.
    for (const step of steps)
      if (step.run?.includes(" promote ")) expect(step.run).not.toContain("--yes");
    // The staged check and the promotion read the deployment the staged deploy printed.
    expect(steps[staged]?.env).toEqual({
      URL: expr("steps.deploy.outputs.url"),
      VERCEL_AUTOMATION_BYPASS_SECRET: expr("secrets.VERCEL_AUTOMATION_BYPASS_SECRET"),
    });
    expect(steps[promote]?.env?.URL).toBe(expr("steps.deploy.outputs.url"));
    expect(steps[stage]?.id).toBe("deploy");
    // The way back promotes the URL recorded before anything changed, and checks its commit.
    expect(steps[rollback]?.run).toContain(
      'bunx vercel@65.14.0 promote "$PREVIOUS_URL" --json --timeout 5m',
    );
    expect(steps[rollback]?.env?.PREVIOUS_URL).toBe(expr("steps.serving.outputs.url"));
    expect(steps[restored]?.run).toBe(
      'bun scripts/ci/production.ts restored --commit "$PREVIOUS_COMMIT"',
    );
    expect(steps[restored]?.env?.PREVIOUS_COMMIT).toBe(expr("steps.serving.outputs.commit"));
    expect(steps[rollbackMinute]?.run).toBe(steps[minute]?.run);
    // The report hears how the way back went.
    expect((deploy.jobs.production as Job).outputs).toEqual({
      previous_commit: expr("steps.serving.outputs.commit"),
      promote: expr("steps.promote.outcome"),
      rollback: expr("steps.rollback.outcome"),
      restored: expr("steps.restored.outcome"),
      rollback_minute: expr("steps.rollback_minute.outcome"),
    });
  });

  test("production is put back only when a step failed once the promotion had started", () => {
    const rollback = productionSteps.find((s) => s.id === "rollback") as Step;
    const restored = productionSteps.find((s) => s.id === "restored") as Step;
    const github = { event_name: "push", ref: "refs/heads/main" };
    // Which step failed, and what the steps before it did.
    const ids = [
      "serving",
      "snapshot",
      "migrate",
      "deploy",
      "staged",
      "promote",
      "health",
      "minute",
    ];
    const putBack: string[] = [];
    for (const [i, failed] of ids.entries()) {
      const steps = Object.fromEntries(
        ids.map((id, j) => [
          id,
          { outcome: j < i ? "success" : j === i ? "failure" : "skipped", outputs: {} },
        ]),
      );
      if (evaluate(rollback.if as string, { github, vars: {}, status: "failure", steps }))
        putBack.push(failed);
    }
    // A failure before the promotion leaves the domain where it was: nothing to put back.
    expect(putBack).toEqual(["promote", "health", "minute"]);
    // Cancelled, or out of time, while a step ran: put back once the promotion had started.
    const cancelledAt: string[] = [];
    for (const [i, stopped] of ids.entries()) {
      const steps = Object.fromEntries(
        ids.map((id, j) => [
          id,
          { outcome: j < i ? "success" : j === i ? "cancelled" : "skipped", outputs: {} },
        ]),
      );
      if (evaluate(rollback.if as string, { github, vars: {}, status: "cancelled", steps }))
        cancelledAt.push(stopped);
    }
    expect(cancelledAt).toEqual(["promote", "health", "minute"]);
    // Nothing is put back when every step passed.
    const passed = Object.fromEntries(ids.map((id) => [id, { outcome: "success" }]));
    expect(
      evaluate(rollback.if as string, { github, vars: {}, status: "success", steps: passed }),
    ).toBe(false);
    // The check after it runs only when the promotion back went through.
    for (const status of ["failure", "cancelled"] as const)
      for (const [outcome, runs] of [
        ["success", true],
        ["failure", false],
        ["skipped", false],
      ] as const)
        expect(
          evaluate(restored.if as string, {
            github,
            vars: {},
            status,
            steps: { rollback: { outcome } },
          }),
        ).toBe(runs);
  });

  test("one project, one registry: no image copy, no registry login, no OIDC token", () => {
    for (const job of Object.values(deploy.jobs)) {
      expect(job.permissions?.["id-token"]).toBeUndefined();
      for (const step of job.steps) {
        expect(step.uses ?? "").not.toContain("vcr-action");
        expect(step.uses ?? "").not.toContain("setup-buildx");
        expect(step.run ?? "").not.toContain("imagetools");
      }
    }
    expect(JSON.stringify(deploy)).not.toContain("id-token");
  });

  test("only the report writes anything to GitHub, and only issues", () => {
    expect((deploy as Workflow & { permissions?: unknown }).permissions).toEqual({
      contents: "read",
    });
    for (const id of ["plan", "dev", "production"])
      expect((deploy.jobs[id] as Job).permissions).toBeUndefined();
    expect((deploy.jobs.report as Job).permissions).toEqual({
      contents: "read",
      issues: "write",
      actions: "read",
      "pull-requests": "read",
    });
    expect(deploy.jobs.report?.if).toBe(expr("always() && needs.plan.result != 'skipped'"));
  });

  test("VERCEL_API_PROD_PROJECT_ID appears nowhere", async () => {
    const hits = await spawn(
      [
        "git",
        "grep",
        "-l",
        "VERCEL_API_PROD_PROJECT_ID",
        "--",
        ".",
        ":!scripts/ci/workflows.test.ts",
      ],
      { cwd: join(import.meta.dir, "../..") },
    );
    // git grep exits 1 when nothing matches.
    expect(hits.stdout).toBe("");
    expect(hits.code).toBe(1);
  });

  test("only the production job's Neon steps set the default branch's guard", () => {
    const guarded: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
      const text = readFileSync(join(DIR, file), "utf8");
      const workflow = load(file);
      for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
        expect(job.env?.PONZU_ALLOW_DEFAULT_BRANCH).toBeUndefined();
        for (const step of job.steps ?? [])
          if (step.env?.PONZU_ALLOW_DEFAULT_BRANCH !== undefined)
            guarded.push(`${file} ${id} ${step.env.PONZU_ALLOW_DEFAULT_BRANCH} ${step.name}`);
      }
      const mentions = text.split("PONZU_ALLOW_DEFAULT_BRANCH:").length - 1;
      expect(mentions).toBe(file === "deploy-api.yml" ? 2 : 0);
      if (file !== "deploy-api.yml") expect(text).not.toContain("--default");
    }
    expect(guarded).toEqual([
      "deploy-api.yml production production Snapshot the Neon default branch",
      "deploy-api.yml production production Apply pending migrations to the Neon default branch",
    ]);
    // The dev job's migration names its branch, which neon.ts never resolves to the default.
    const devMigrate = (deploy.jobs.dev as Job).steps.find((s) => s.run?.includes("db:migrate"));
    expect(devMigrate?.run).toContain("neon.ts dev --direct");
    expect(devMigrate?.run).not.toContain("--default");
  });

  test("the health checks assert their own environment, dev's at api-dev.ponzu.design", () => {
    const run = (job: string) => (deploy.jobs[job] as Job).steps.map((s) => s.run ?? "").join("\n");
    // Dev's address comes from infra/environments.json, which names api-dev; the frozen
    // deployment at api.ponzu.design would otherwise answer an older commit.
    expect(run("dev")).toContain('bun scripts/ci/health.ts --env dev --commit "$GITHUB_SHA"');
    expect(run("dev")).not.toContain("--url");
    expect(apiUrlOf("dev")).toBe("https://api-dev.ponzu.design");
    expect(run("production")).toContain(
      'bun scripts/ci/health.ts --env production --commit "$GITHUB_SHA"',
    );
  });

  test("every deploy step pins the CLI that schedules.ts runs", () => {
    const versions = new Set<string>();
    for (const job of Object.values(deploy.jobs))
      for (const step of job.steps)
        for (const m of (step.run ?? "").matchAll(/\bvercel@([\d.]+)/g))
          versions.add(m[1] as string);
    expect([...versions]).toEqual([VERCEL_CLI.split("@")[1] as string]);
  });
});

/**
 * Runs one step's own shell under bash -e, as Actions does, with fake commands on PATH that
 * record how they were called (one line of arguments each, and what they read on stdin).
 */
async function runStepShell(
  step: Step,
  opts: {
    env?: Record<string, string>;
    /** Each fake command's script body, run with bash. */
    fakes: Record<string, string>;
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-step-"));
  try {
    mkdirSync(join(dir, "bin"));
    for (const [name, body] of Object.entries(opts.fakes)) {
      const path = join(dir, "bin", name);
      writeFileSync(path, `#!/bin/bash\nprintf '%s %s\\n' "${name}" "$*" >>"$FAKE_LOG"\n${body}\n`);
      chmodSync(path, 0o755);
    }
    const log = join(dir, "calls.log");
    const output = join(dir, "output");
    writeFileSync(log, "");
    writeFileSync(output, "");
    const result = await spawn(["bash", "-e", "-c", step.run as string], {
      cwd: dir,
      env: {
        PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
        FAKE_LOG: log,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        GITHUB_SHA: "a".repeat(40),
        GITHUB_REPOSITORY: "o/r",
        ...opts.env,
      },
    });
    return {
      ...result,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      output: readFileSync(output, "utf8"),
      dir,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("deploy-api.yml's shell, against fakes", () => {
  const planStep = (deploy.jobs.plan as Job).steps.find((s) => s.id === "plan") as Step;

  test("the plan compares with production only for a push with production on, and forces a dispatch", async () => {
    const cases: [string, string, string][] = [
      ["false", "false", `--commit ${"a".repeat(40)}`],
      ["true", "false", `--commit ${"a".repeat(40)} --production`],
      ["false", "true", `--commit ${"a".repeat(40)} --always`],
    ];
    for (const [production, dispatch, args] of cases) {
      const run = await runStepShell(planStep, {
        env: { PRODUCTION_ON: production, DISPATCH: dispatch },
        fakes: { bun: "" },
      });
      expect(run.code).toBe(0);
      expect(run.calls).toEqual([`bun scripts/ci/deploy-plan.ts ${args}`]);
    }
    expect(planStep.env).toEqual({
      PRODUCTION_ON: expr("vars.API_DEPLOY_PRODUCTION == 'true' && github.event_name == 'push'"),
      DISPATCH: expr("github.event_name == 'workflow_dispatch'"),
    });
  });

  test("the staged deploy hands on the URL the CLI printed, and fails on anything else", async () => {
    const stage = productionSteps.find((s) => s.id === "deploy") as Step;
    const ok = await runStepShell(stage, {
      fakes: { bunx: "echo 'Vercel CLI 65.14.0' >&2; echo https://ponzu-api-abc123.vercel.app" },
    });
    expect(ok.code).toBe(0);
    expect(ok.output).toBe("url=https://ponzu-api-abc123.vercel.app\n");
    expect(ok.calls).toEqual([
      `bunx vercel@65.14.0 deploy --prod --skip-domain --yes --env VERCEL_GIT_COMMIT_SHA=${"a".repeat(40)}`,
    ]);
    for (const printed of ["", "Error: something", "https://api.ponzu.design"]) {
      const bad = await runStepShell(stage, { fakes: { bunx: `echo '${printed}'` } });
      expect(bad.code).not.toBe(0);
      expect(bad.output).toBe("");
    }
  });

  test("the way back promotes the recorded URL, says so loudly, and fails when the CLI does", async () => {
    const rollback = productionSteps.find((s) => s.id === "rollback") as Step;
    const env = { PREVIOUS_URL: "https://ponzu-api-old.vercel.app" };
    const ok = await runStepShell(rollback, { env, fakes: { bunx: "" } });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("::error title=Rolling production back::");
    expect(ok.calls).toEqual([
      "bunx vercel@65.14.0 promote https://ponzu-api-old.vercel.app --json --timeout 5m",
    ]);
    const refused = await runStepShell(rollback, { env, fakes: { bunx: "exit 1" } });
    expect(refused.code).not.toBe(0);
  });

  test("the canary's rotated session is stored back from its file, which is then removed", async () => {
    const keep = (deploy.jobs.dev as Job).steps.find((s) =>
      s.run?.includes("gh secret set"),
    ) as Step;
    const dir = mkdtempSync(join(tmpdir(), "deploy-keep-"));
    try {
      const file = join(dir, "canary-session.json");
      writeFileSync(file, '{"refresh_token":"rotated"}');
      const run = await runStepShell(keep, {
        env: { RUNNER_TEMP: dir },
        fakes: { gh: 'cat >>"$FAKE_LOG"; echo >>"$FAKE_LOG"' },
      });
      expect(run.code).toBe(0);
      expect(run.calls).toEqual([
        "gh secret set CANARY_SESSION --repo o/r",
        '{"refresh_token":"rotated"}',
      ]);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dev and production stop before the database when a secret is missing", async () => {
    const devGuard = (deploy.jobs.dev as Job).steps.find((s) =>
      s.run?.includes('[ -n "$CRON_SECRET" ]'),
    ) as Step;
    expect((await runStepShell(devGuard, { env: { CRON_SECRET: "" }, fakes: {} })).code).toBe(1);
    expect((await runStepShell(devGuard, { env: { CRON_SECRET: "x" }, fakes: {} })).code).toBe(0);
    const prodGuard = productionSteps.find((s) =>
      s.run?.includes('[ -n "$VERCEL_TOKEN" ]'),
    ) as Step;
    for (const [token, bypass, code] of [
      ["", "b", 1],
      ["t", "", 1],
      ["t", "b", 0],
    ] as const)
      expect(
        (await runStepShell(prodGuard, { env: { VERCEL_TOKEN: token, BYPASS: bypass }, fakes: {} }))
          .code,
      ).toBe(code);
  });
});

describe("every workflow", () => {
  test("pins each action to a full commit", () => {
    const loose: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
      for (const [id, job] of Object.entries(load(file).jobs ?? {}))
        for (const step of job.steps ?? [])
          if (step.uses && !step.uses.startsWith("./") && !/@[0-9a-f]{40}$/.test(step.uses))
            loose.push(`${file} ${id} ${step.uses}`);
    }
    expect(loose).toEqual([]);
  });

  test("ci.yml lints the workflows with a pinned actionlint, and the migrations", () => {
    const ci = load("ci.yml");
    const workflows = ci.jobs.workflows as Job & { env: Record<string, string> };
    expect(workflows.name).toBe("Workflows");
    expect(workflows.env.ACTIONLINT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(workflows.env.ACTIONLINT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const script = workflows.steps.map((s) => s.run ?? "").join("\n");
    expect(script).toContain("sha256sum --check --strict");
    expect(script).toContain('"$RUNNER_TEMP/actionlint"');
    const checks = (ci.jobs.checks as Job).steps.map((s) => s.run ?? "").join("\n");
    expect(checks).toContain("check migrations bun scripts/ci/migrations.ts");
    expect(checks).toMatch(/for name in [^;]*\bmigrations;/);
    // Main's required check passes only when the workflows' lint did.
    const required = ci.jobs.test as Job & { needs: string[] };
    expect(required.name).toBe("Check, typecheck, test");
    expect(required.needs).toContain("workflows");
    expect(required.steps.map((s) => s.run ?? "").join("\n")).toContain(
      '[ "$WORKFLOWS" = success ]',
    );
  });

  test("ci.yml's tests run under the watchdog, cut off a minute before the job's own limit", () => {
    const tests = load("ci.yml").jobs.tests as Job & { "timeout-minutes": number };
    // The deadline counts from the job's first step.
    expect(tests.steps[0]?.run).toBe('echo "JOB_STARTED=$(date +%s)" >> "$GITHUB_ENV"');
    const run = tests.steps.find((s) => s.name === "Tests")?.run ?? "";
    expect(run).toContain(`deadline=$((JOB_STARTED + ${tests["timeout-minutes"]} * 60 - 60))`);
    expect(run).toMatch(
      /bun scripts\/ci\/test-watchdog\.ts --deadline "\$deadline" --trace "\$results\/running" -- \\\n\s*bun test --parallel /,
    );
    // The trace the watchdog reads is kept by the first preload.
    const bunfig = Bun.TOML.parse(
      readFileSync(join(import.meta.dir, "../../bunfig.toml"), "utf8"),
    ) as {
      test: { preload: string[] };
    };
    expect(bunfig.test.preload[0]).toBe("./scripts/ci/test-trace.ts");
  });
});

describe("uptime.yml", () => {
  const uptime = load("uptime.yml");

  test("runs every five minutes, or by hand, and only on main", () => {
    expect(Object.keys(uptime.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(uptime.on.schedule).toEqual([{ cron: "*/5 * * * *" }]);
    expect(Object.keys(uptime.jobs)).toEqual(["health"]);
    const job = uptime.jobs.health as Job;
    const ran: string[] = [];
    for (const event_name of ["schedule", "workflow_dispatch"])
      for (const ref of REFS)
        if (evaluate(job.if ?? "true", { github: { event_name, ref }, vars: {} }))
          ran.push(`${event_name} ${ref}`);
    expect(ran).toEqual(["schedule refs/heads/main", "workflow_dispatch refs/heads/main"]);
  });

  test("one check at a time, writing only issues, through uptime.ts", () => {
    const job = uptime.jobs.health as Job;
    expect(job.concurrency).toEqual({ group: "uptime", "cancel-in-progress": false });
    expect(job.permissions).toEqual({ contents: "read", issues: "write", actions: "read" });
    const step = job.steps.find((s) => s.run?.includes("uptime.ts"));
    expect(step?.run).toBe("bun scripts/ci/uptime.ts");
    expect(step?.env).toEqual({ GH_TOKEN: expr("github.token") });
  });
});

describe("release.yml's auto-merge", () => {
  const release = load("release.yml");
  const job = release.jobs["auto-merge"] as Job;
  const step = job.steps.find((s) => s.run?.includes("gh pr merge")) as Step;
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "../../.release-please-manifest.json"), "utf8"),
  ) as Record<string, string>;
  const [major, minor] = (manifest["."] as string).split(".").map(Number) as [number, number];
  const MINOR = `${major}.${minor + 1}.0`;
  const MAJOR = `${major + 1}.0.0`;

  test("asks release-hold.ts with RELEASES_HELD, as the release token", () => {
    expect(step.env).toEqual({
      APP: expr("matrix.app"),
      RELEASES_HELD: expr("vars.RELEASES_HELD"),
      GH_TOKEN: expr("secrets.RELEASE_TOKEN"),
    });
    expect(step.run).toContain("bun scripts/release-hold.ts");
  });

  /**
   * Runs the step's own script under bash -e, as Actions does, with a fake gh on PATH that
   * answers the open PR and its manifest and records every call.
   */
  interface StepOptions {
    pr: unknown;
    proposed?: Record<string, string>;
    held?: string;
    apiFails?: boolean;
  }
  async function runStep(options: StepOptions) {
    const dir = mkdtempSync(join(tmpdir(), "auto-merge-"));
    mkdirSync(join(dir, "bin"));
    const gh = join(dir, "bin", "gh");
    writeFileSync(
      gh,
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >>"$FAKE_LOG"',
        'case "$1 $2" in',
        '  "pr list") printf "%s\\n" "$FAKE_PR" ;;',
        '  "api -H") [ -z "$FAKE_API_FAILS" ] || exit 1; printf "%s" "$FAKE_MANIFEST" ;;',
        "esac",
      ].join("\n"),
    );
    chmodSync(gh, 0o755);
    const log = join(dir, "gh.log");
    writeFileSync(log, "");
    const result = await spawn(["bash", "-e", "-c", step.run as string], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: process.env.HOME ?? dir,
        APP: "ponzu",
        RELEASES_HELD: options.held ?? "",
        GITHUB_REPOSITORY: "o/r",
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        FAKE_LOG: log,
        FAKE_PR: options.pr === null ? "null" : JSON.stringify(options.pr),
        FAKE_MANIFEST: JSON.stringify(options.proposed ?? {}),
        ...(options.apiFails ? { FAKE_API_FAILS: "1" } : {}),
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    rmSync(dir, { recursive: true });
    return { code: result.code, calls, out: result.stdout };
  }
  const pr = (title: string, autoMerge = false) => ({
    number: 5,
    title,
    headRefOid: "abc123",
    autoMergeRequest: autoMerge ? { mergeMethod: "SQUASH" } : null,
  });
  const merges = (calls: string[]) => calls.filter((c) => c.startsWith("pr merge"));

  test("a minor release PR gets squash auto-merge", async () => {
    const run = await runStep({
      pr: pr(`chore(main): release ${MINOR}`),
      proposed: { ".": MINOR },
    });
    expect(run.code).toBe(0);
    expect(run.calls).toContain(
      "api -H Accept: application/vnd.github.raw+json repos/o/r/contents/.release-please-manifest.json?ref=abc123",
    );
    expect(merges(run.calls)).toEqual(["pr merge 5 --repo o/r --squash --auto"]);
  });

  test("a major release PR is never auto-merged, and loses auto-merge it had", async () => {
    const fresh = await runStep({
      pr: pr(`chore(main): release ${MAJOR}`),
      proposed: { ".": MAJOR },
    });
    expect(fresh.code).toBe(0);
    expect(merges(fresh.calls)).toEqual([]);
    expect(fresh.out).toContain(
      `::notice title=Release PR #5 is held for a person to merge::${MAJOR} is a major release`,
    );
    const had = await runStep({
      pr: pr(`chore(main): release ${MAJOR}`, true),
      proposed: { ".": MAJOR },
    });
    expect(had.code).toBe(0);
    expect(merges(had.calls)).toEqual(["pr merge 5 --repo o/r --disable-auto"]);
  });

  test("RELEASES_HELD, a malformed title or a manifest that disagrees holds", async () => {
    const held: StepOptions[] = [
      { pr: pr(`chore(main): release ${MINOR}`), proposed: { ".": MINOR }, held: "ponzu" },
      { pr: pr(`chore(main): release v${MINOR}`), proposed: { ".": MINOR } },
      { pr: pr(`chore(main): release ${MINOR}`), proposed: { ".": MAJOR } },
      { pr: pr("chore(main): release 1.0\n::error::x %"), proposed: {} },
    ];
    for (const options of held) {
      const run = await runStep(options);
      expect(run.code).toBe(0);
      expect(merges(run.calls)).toEqual([]);
      expect(run.out).toContain("is held for a person to merge");
      expect(run.out).not.toContain("\n::error");
    }
  });

  test("an unreadable PR manifest fails the step and merges nothing", async () => {
    const run = await runStep({
      pr: pr(`chore(main): release ${MINOR}`),
      proposed: { ".": MINOR },
      apiFails: true,
    });
    expect(run.code).not.toBe(0);
    expect(merges(run.calls)).toEqual([]);
  });

  test("no open release PR does nothing", async () => {
    const run = await runStep({ pr: null });
    expect(run.code).toBe(0);
    expect(run.calls.length).toBe(1);
  });

  test("fails closed: runs after a failed Release Please, and one app never cancels the other", () => {
    // A push only, but also when Release Please failed part way through its two PRs.
    expect(job.if).toBe(expr("!cancelled() && github.event_name == 'push'"));
    expect((job as Job & { strategy?: { "fail-fast"?: boolean } }).strategy?.["fail-fast"]).toBe(
      false,
    );
    // The fail-closed step is last, so a failure in any step before it runs it.
    expect(job.steps.at(-1)?.name).toBe("Turn off auto-merge when the hold could not be decided");
  });

  test("when the hold could not be decided, auto-merge the PR already had is turned off", async () => {
    const last = job.steps.at(-1) as Step & { if?: string };
    expect(last.if).toBe("failure()");
    expect(last.env).toEqual({ APP: expr("matrix.app"), GH_TOKEN: expr("secrets.RELEASE_TOKEN") });
    const dir = mkdtempSync(join(tmpdir(), "auto-merge-off-"));
    mkdirSync(join(dir, "bin"));
    const gh = join(dir, "bin", "gh");
    // gh answers its --jq filter's output: the PRs that have auto-merge.
    writeFileSync(
      gh,
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >>"$FAKE_LOG"',
        'case "$1 $2" in',
        '  "pr list") printf "%s\\n" $FAKE_NUMBERS ;;',
        "esac",
      ].join("\n"),
    );
    chmodSync(gh, 0o755);
    const run = async (numbers: string) => {
      const log = join(dir, `gh-${numbers || "none"}.log`);
      writeFileSync(log, "");
      const result = await spawn(["bash", "-e", "-c", last.run as string], {
        env: {
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          APP: "ponzu",
          GITHUB_REPOSITORY: "o/r",
          FAKE_LOG: log,
          FAKE_NUMBERS: numbers,
        },
      });
      const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      return { code: result.code, calls, out: result.stdout };
    };
    const had = await run("5");
    expect(had.code).toBe(0);
    expect(had.calls[0]).toContain("--jq .[] | select(.autoMergeRequest != null) | .number");
    expect(merges(had.calls)).toEqual(["pr merge 5 --repo o/r --disable-auto"]);
    expect(had.out).toContain("::warning title=Auto-merge turned off on release PR #5::");
    const none = await run("");
    expect(none.code).toBe(0);
    expect(merges(none.calls)).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});
