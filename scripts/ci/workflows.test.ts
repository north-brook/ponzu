/**
 * The shape of the workflows that deploy, read from the YAML itself: which event runs which
 * job of deploy-api.yml, that production can never run from `cloud`, a dispatch or a pull
 * request, and that only the production job may reach the Neon default branch; that uptime.yml
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

const DIR = join(import.meta.dir, "../../.github/workflows");

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
  test("is started by a push to cloud or main, or a dispatch; never a pull request", () => {
    expect(Object.keys(deploy.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(deploy.on.push).toEqual({ branches: ["cloud", "main"] });
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

  test("dev runs only on cloud, by a push or a dispatch, with API_DEPLOY on", () => {
    expect(runsIn(deploy.jobs.dev as Job)).toEqual([
      'push refs/heads/cloud {"API_DEPLOY":"true"}',
      'push refs/heads/cloud {"API_DEPLOY":"true","API_DEPLOY_PRODUCTION":"true"}',
      'workflow_dispatch refs/heads/cloud {"API_DEPLOY":"true"}',
      'workflow_dispatch refs/heads/cloud {"API_DEPLOY":"true","API_DEPLOY_PRODUCTION":"true"}',
    ]);
  });

  test("with today's variables (neither set) nothing deploys", () => {
    for (const job of Object.values(deploy.jobs))
      for (const event_name of EVENTS)
        for (const ref of REFS)
          expect(evaluate(job.if ?? "true", { github: { event_name, ref }, vars: {} })).toBe(false);
  });

  test("production waits for the founder in the production environment, one run at a time", () => {
    const production = deploy.jobs.production as Job;
    expect(production.environment).toBe("production");
    expect(production.concurrency).toEqual({
      group: "deploy-api-production",
      "cancel-in-progress": false,
    });
    expect(production.env?.VERCEL_PROJECT_ID).toBe(expr("vars.VERCEL_API_PROD_PROJECT_ID"));
    const dev = deploy.jobs.dev as Job;
    expect(dev.environment).toBeUndefined();
    expect(dev.concurrency).toEqual({ group: "deploy-api-dev", "cancel-in-progress": false });
    expect(dev.env?.VERCEL_PROJECT_ID).toBe(expr("vars.VERCEL_API_PROJECT_ID"));
    expect(deploy.concurrency).toBeUndefined();
  });

  test("production copies the image, snapshots, migrates, deploys and checks, in that order", () => {
    const steps = (deploy.jobs.production as Job).steps;
    const index = (match: (s: Step) => boolean, what: string) => {
      const i = steps.findIndex(match);
      if (i < 0) throw new Error(`No step: ${what}`);
      return i;
    };
    const copy = index((s) => !!s.run?.includes("docker buildx imagetools create"), "copy");
    const ready = index(
      (s) => !!s.uses?.startsWith("vercel/vcr-action/wait-for-optimized-image@"),
      "ready",
    );
    const snapshot = index((s) => !!s.run?.includes("neon.ts --default --snapshot"), "snapshot");
    const migrate = index((s) => !!s.run?.includes("bun run db:migrate"), "migrate");
    const vercel = index((s) => !!s.run?.includes("vercel@65.14.0 deploy --prod"), "deploy");
    const health = index(
      (s) => !!s.run?.includes("scripts/ci/health.ts --env production"),
      "health",
    );
    expect([copy, ready, snapshot, migrate, vercel, health]).toEqual(
      [copy, ready, snapshot, migrate, vercel, health].toSorted((a, b) => a - b),
    );
    expect(steps[migrate]?.run).toContain("neon.ts --default --direct");
    // The copy is by digest, from current.json, never a rebuild.
    expect(steps.some((s) => /docker (buildx )?build\b(?! imagetools)/.test(s.run ?? ""))).toBe(
      false,
    );
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

  test("the health checks assert their own environment", () => {
    const run = (job: string) => (deploy.jobs[job] as Job).steps.map((s) => s.run ?? "").join("\n");
    expect(run("dev")).toContain('bun scripts/ci/health.ts --env dev --commit "$GITHUB_SHA"');
    expect(run("production")).toContain(
      'bun scripts/ci/health.ts --env production --commit "$GITHUB_SHA"',
    );
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
  function runStep(options: {
    pr: unknown;
    proposed?: Record<string, string>;
    held?: string;
    apiFails?: boolean;
  }) {
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
    const result = Bun.spawnSync(["bash", "-e", "-c", step.run as string], {
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
    const out = result.stdout.toString();
    rmSync(dir, { recursive: true });
    return { code: result.exitCode, calls, out };
  }
  const pr = (title: string, autoMerge = false) => ({
    number: 5,
    title,
    headRefOid: "abc123",
    autoMergeRequest: autoMerge ? { mergeMethod: "SQUASH" } : null,
  });
  const merges = (calls: string[]) => calls.filter((c) => c.startsWith("pr merge"));

  test("a minor release PR gets squash auto-merge", () => {
    const run = runStep({ pr: pr(`chore(main): release ${MINOR}`), proposed: { ".": MINOR } });
    expect(run.code).toBe(0);
    expect(run.calls).toContain(
      "api -H Accept: application/vnd.github.raw+json repos/o/r/contents/.release-please-manifest.json?ref=abc123",
    );
    expect(merges(run.calls)).toEqual(["pr merge 5 --repo o/r --squash --auto"]);
  });

  test("a major release PR is never auto-merged, and loses auto-merge it had", () => {
    const fresh = runStep({ pr: pr(`chore(main): release ${MAJOR}`), proposed: { ".": MAJOR } });
    expect(fresh.code).toBe(0);
    expect(merges(fresh.calls)).toEqual([]);
    expect(fresh.out).toContain(
      `::notice title=Release PR #5 is held for a person to merge::${MAJOR} is a major release`,
    );
    const had = runStep({
      pr: pr(`chore(main): release ${MAJOR}`, true),
      proposed: { ".": MAJOR },
    });
    expect(had.code).toBe(0);
    expect(merges(had.calls)).toEqual(["pr merge 5 --repo o/r --disable-auto"]);
  });

  test("RELEASES_HELD, a malformed title or a manifest that disagrees holds", () => {
    for (const run of [
      runStep({ pr: pr(`chore(main): release ${MINOR}`), proposed: { ".": MINOR }, held: "ponzu" }),
      runStep({ pr: pr(`chore(main): release v${MINOR}`), proposed: { ".": MINOR } }),
      runStep({ pr: pr(`chore(main): release ${MINOR}`), proposed: { ".": MAJOR } }),
      runStep({ pr: pr("chore(main): release 1.0\n::error::x %"), proposed: {} }),
    ]) {
      expect(run.code).toBe(0);
      expect(merges(run.calls)).toEqual([]);
      expect(run.out).toContain("is held for a person to merge");
      expect(run.out).not.toContain("\n::error");
    }
  });

  test("an unreadable PR manifest fails the step and merges nothing", () => {
    const run = runStep({
      pr: pr(`chore(main): release ${MINOR}`),
      proposed: { ".": MINOR },
      apiFails: true,
    });
    expect(run.code).not.toBe(0);
    expect(merges(run.calls)).toEqual([]);
  });

  test("no open release PR does nothing", () => {
    const run = runStep({ pr: null });
    expect(run.code).toBe(0);
    expect(run.calls.length).toBe(1);
  });
});
