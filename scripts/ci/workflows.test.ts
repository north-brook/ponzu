/**
 * The shape of the workflows that deploy, read from the YAML itself: which event runs which
 * job of deploy-api.yml, that neither job runs from any branch but `main` or for a pull request,
 * that production never runs from a dispatch, that dev deploys to its custom environment and only the production job uses `--prod`,
 * `promote` and production's own token, that both name the one Vercel project, and that only the
 * production job may reach the Neon default branch; that uptime.yml
 * checks only from main; and that release.yml's auto-merge step, run as it is written against a
 * fake gh, never auto-merges a release PR that scripts/release-hold.ts holds. actionlint (the
 * Workflows job in ci.yml) checks the rest of every file.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
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
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name: string;
  if?: string;
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
}

/**
 * Evaluates an Actions `if:` written with `==`, `!=`, `&&`, `||`, `!`, parentheses, string
 * literals and context paths, as GitHub does: an unset variable is null, which equals nothing.
 * Anything else in the expression throws, so a condition this can't read fails the test.
 */
function evaluate(expression: string, context: Context): boolean {
  const source = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const tokens = source.match(/'(?:[^']|'')*'|==|!=|&&|\|\||!|\(|\)|[A-Za-z_][\w.-]*|\S/g) ?? [];
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
    const [root, ...path] = token.split(".");
    if (root === "github" && path.length === 1) {
      const value = context.github[path[0] as keyof Context["github"]];
      if (value === undefined) throw new Error(`Unknown context: ${token}`);
      return value;
    }
    if (root === "vars" && path.length === 1) return context.vars[path[0] as string] ?? null;
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
  return truthy(value);
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

/** Every context in which `job` runs, as "event ref vars". */
function runsIn(job: Job): string[] {
  const out: string[] = [];
  for (const event_name of EVENTS)
    for (const ref of REFS)
      for (const vars of VARS)
        if (evaluate(job.if ?? "true", { github: { event_name, ref }, vars }))
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
});

describe("deploy-api.yml", () => {
  test("is started by a push to main, or a dispatch; never a pull request or another branch", () => {
    expect(Object.keys(deploy.on).sort()).toEqual(["push", "workflow_dispatch"]);
    // `cloud` is retired: main is the branch everything merges into.
    expect(deploy.on.push).toEqual({ branches: ["main"] });
    // A dispatch takes no inputs, so it cannot ask for a target.
    expect(deploy.on.workflow_dispatch).toBeNull();
    expect(Object.keys(deploy.jobs).sort()).toEqual(["dev", "production"]);
  });

  test("production runs only on a push to main with API_DEPLOY_PRODUCTION on", () => {
    expect(runsIn(deploy.jobs.production as Job)).toEqual([
      'push refs/heads/main {"API_DEPLOY_PRODUCTION":"true"}',
      'push refs/heads/main {"API_DEPLOY":"true","API_DEPLOY_PRODUCTION":"true"}',
    ]);
  });

  test("dev runs only on main, by a push or a dispatch, with API_DEPLOY on", () => {
    expect(runsIn(deploy.jobs.dev as Job)).toEqual([
      'push refs/heads/main {"API_DEPLOY":"true"}',
      'push refs/heads/main {"API_DEPLOY":"true","API_DEPLOY_PRODUCTION":"true"}',
      'workflow_dispatch refs/heads/main {"API_DEPLOY":"true"}',
      'workflow_dispatch refs/heads/main {"API_DEPLOY":"true","API_DEPLOY_PRODUCTION":"true"}',
    ]);
  });

  test("each job is switched on by its own variable alone", () => {
    // API_DEPLOY never deploys production, and API_DEPLOY_PRODUCTION never deploys dev.
    const push = { event_name: "push", ref: "refs/heads/main" };
    const dev = deploy.jobs.dev as Job;
    const production = deploy.jobs.production as Job;
    expect(evaluate(dev.if ?? "true", { github: push, vars: { API_DEPLOY: "true" } })).toBe(true);
    expect(evaluate(production.if ?? "true", { github: push, vars: { API_DEPLOY: "true" } })).toBe(
      false,
    );
    expect(
      evaluate(dev.if ?? "true", { github: push, vars: { API_DEPLOY_PRODUCTION: "true" } }),
    ).toBe(false);
    expect(
      evaluate(production.if ?? "true", { github: push, vars: { API_DEPLOY_PRODUCTION: "true" } }),
    ).toBe(true);
  });

  test("with today's variables (neither set) nothing deploys", () => {
    for (const job of Object.values(deploy.jobs))
      for (const event_name of EVENTS)
        for (const ref of REFS)
          expect(evaluate(job.if ?? "true", { github: { event_name, ref }, vars: {} })).toBe(false);
  });

  test("each job runs in its own GitHub environment, one run at a time, on the one project", () => {
    const production = deploy.jobs.production as Job;
    expect(production.environment).toBe("production");
    expect(production.concurrency).toEqual({
      group: "deploy-api-production",
      "cancel-in-progress": false,
    });
    const dev = deploy.jobs.dev as Job;
    expect(dev.environment).toBe("dev");
    expect(dev.concurrency).toEqual({ group: "deploy-api-dev", "cancel-in-progress": false });
    // One Vercel project: both jobs name the same one, and the team.
    for (const job of [dev, production])
      expect(job.env).toEqual({
        VERCEL_ORG_ID: expr("vars.VERCEL_TEAM_ID"),
        VERCEL_PROJECT_ID: expr("vars.VERCEL_API_PROJECT_ID"),
      });
    expect(deploy.concurrency).toBeUndefined();
  });

  test("repo.json's environments are limited to their branch, and hold each job's secrets", () => {
    const repo = loadInfraFile("github/repo.json");
    expect(repo.environments.dev).toEqual({
      branches: ["main"],
      requiredReviewers: false,
      secrets: ["VERCEL_TOKEN"],
    });
    expect(repo.environments.production).toEqual({
      branches: ["main"],
      requiredReviewers: true,
      secrets: ["NEON_API_KEY", "VERCEL_AUTOMATION_BYPASS_SECRET", "VERCEL_TOKEN_PRODUCTION"],
    });
    // Only the production environment holds production's token and the bypass, never the
    // repository, so no other workflow or job can read them.
    for (const name of ["VERCEL_TOKEN_PRODUCTION", "VERCEL_AUTOMATION_BYPASS_SECRET"]) {
      expect(repo.secrets).not.toContain(name);
      expect(repo.environments.dev?.secrets).not.toContain(name);
    }
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
    expect(uses).toEqual(["deploy-api.yml production prod", "deploy-api.yml production promote"]);
    // Every step of production that runs the CLI holds VERCEL_TOKEN_PRODUCTION, never the
    // repository-wide VERCEL_TOKEN (an environment secret only overrides one of the same name).
    for (const step of (deploy.jobs.production as Job).steps) {
      if (step.env?.VERCEL_TOKEN !== undefined)
        expect(step.env.VERCEL_TOKEN).toBe(expr("secrets.VERCEL_TOKEN_PRODUCTION"));
      if (/\bvercel@|schedules\.ts/.test(step.run ?? ""))
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

  test("production checks its token first, then snapshots, migrates, stages, checks, promotes", () => {
    const steps = (deploy.jobs.production as Job).steps;
    const index = (match: (s: Step) => boolean, what: string) => {
      const i = steps.findIndex(match);
      if (i < 0) throw new Error(`No step: ${what}`);
      return i;
    };
    const token = index((s) => !!s.run?.includes('[ -n "$VERCEL_TOKEN" ]'), "token");
    const snapshot = index((s) => !!s.run?.includes("neon.ts --default --snapshot"), "snapshot");
    const migrate = index((s) => !!s.run?.includes("bun run db:migrate"), "migrate");
    const stage = index(
      (s) => !!s.run?.includes("bunx vercel@65.14.0 deploy --prod --skip-domain --yes"),
      "stage",
    );
    const staged = index((s) => !!s.run?.includes('--url "$URL" --bypass'), "staged health");
    const promote = index(
      (s) => s.run === 'bunx vercel@65.14.0 promote "$URL" --json --timeout 5m',
      "promote",
    );
    const health = index(
      (s) => s.run === 'bun scripts/ci/health.ts --env production --commit "$GITHUB_SHA"',
      "health",
    );
    const minute = index(
      (s) =>
        s.run ===
        "bun scripts/ci/schedules.ts --environment production --name minute --path /v1/cron/minute",
      "minute",
    );
    const order = [token, snapshot, migrate, stage, staged, promote, health, minute];
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(steps[migrate]?.run).toContain("neon.ts --default --direct");
    // The deploy never takes the domain itself: every --prod is staged.
    const prod = steps.filter((s) => /--prod\b/.test(s.run ?? ""));
    expect(prod.length).toBe(1);
    expect(prod[0]?.run).toContain("--skip-domain");
    // Promote never confirms itself: with no --yes, it refuses a deployment that is not a
    // production build instead of rebuilding it with production's variables.
    expect(steps[promote]?.run).not.toContain("--yes");
    // The staged check and the promotion read the deployment the staged deploy printed.
    expect(steps[staged]?.env).toEqual({
      URL: expr("steps.deploy.outputs.url"),
      VERCEL_AUTOMATION_BYPASS_SECRET: expr("secrets.VERCEL_AUTOMATION_BYPASS_SECRET"),
    });
    expect(steps[promote]?.env?.URL).toBe(expr("steps.deploy.outputs.url"));
    expect((steps[stage] as Step & { id?: string }).id).toBe("deploy");
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
