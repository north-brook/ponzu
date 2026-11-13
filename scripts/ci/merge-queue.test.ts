/**
 * Main merges through GitHub's merge queue: ci.yml, read from the YAML itself, runs every check
 * main requires on a queue entry, keys an entry's run by its own commit, scopes an entry by what
 * it adds to the entry ahead of it, and runs the migration guard and contract against that
 * entry; release.yml's hold, run as it is written against a fake gh, takes a held release PR out
 * of the queue. Real git, in a temporary repository, answers the "what this change lands on"
 * step.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInfraFile } from "../prod/desired.ts";

const ROOT = join(import.meta.dir, "../..");
const expr = (inner: string) => `$\{{ ${inner} }}`;

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  if?: string;
  needs?: string[] | string;
  services?: Record<string, unknown>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, Job>;
}

const load = (name: string) =>
  Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows", name), "utf8")) as Workflow;
const ci = load("ci.yml");

async function spawn(cmd: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn(cmd, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("ci.yml in the merge queue", () => {
  const rule = loadInfraFile("github/ruleset-main.json").rules.find(
    (r) => r.type === "required_status_checks",
  );
  if (!rule?.parameters) throw new Error("main's ruleset requires no checks");
  const required = (
    rule.parameters as { required_status_checks: { context: string }[] }
  ).required_status_checks.map((c) => c.context);

  test("runs for every queue entry", () => {
    expect(ci.on.merge_group).toEqual({ types: ["checks_requested"] });
  });

  test("every job main requires reports on a queue entry, as on a pull request", () => {
    const byName = Object.values(ci.jobs).filter((job) => required.includes(job.name ?? ""));
    expect(byName.map((job) => job.name).sort()).toEqual([...required].sort());
    for (const job of byName) {
      // No condition, or one that holds for every event, so the job reports on an entry.
      expect([undefined, expr("!cancelled()")]).toContain(job.if);
    }
    // Only the title's checks are the pull request's alone: an entry has no title to read, and
    // the pull request's own run already held it. Every other step of a required job runs.
    const prOnly = byName.flatMap((job) =>
      job.steps.filter((s) => (s.if ?? "").includes("'pull_request'")).map((s) => s.name),
    );
    expect(prOnly).toEqual([
      "The PR title becomes the squash commit, which Release Please reads",
      "A feature or fix says what users will notice",
    ]);
  });

  test("an entry's run is keyed by its own commit, and never cancelled by another", () => {
    // pull_request && ref || sha: a merge_group event takes the sha.
    expect(ci.concurrency.group).toBe(
      expr(
        "github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha",
      ),
    );
    expect(ci.concurrency["cancel-in-progress"]).toBe(expr("github.event_name == 'pull_request'"));
  });

  test("the scope of an entry is what it adds to the entry ahead of it", () => {
    const scope = ci.jobs.scope as Job;
    const step = scope.steps.find((s) => s.id === "scope") as Step;
    expect(step.if).toBe(
      "github.event_name == 'pull_request' || github.event_name == 'merge_group'",
    );
    expect(step.env?.BASE).toBe(
      expr("github.event.merge_group.base_sha || format('origin/{0}', github.base_ref)"),
    );
    expect(step.run).toContain('bun scripts/ci/scope.ts "$BASE"');
  });

  test("the migrations job runs the guard and the contract, and the required check holds it", () => {
    const job = ci.jobs.migrations as Job;
    expect(job.name).toBe("Migrations");
    expect(job.if).toBeUndefined();
    expect(Object.keys(job.services ?? {})).toEqual(["postgres"]);
    const runs = job.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain('bun scripts/ci/migration-guard.ts check --base "$BASE"');
    expect(runs).toContain('bun scripts/ci/migration-contract.ts --base "$BASE"');
    const contract = job.steps.find((s) => s.run?.includes("migration-contract")) as Step;
    expect(contract.env?.PONZU_TEST_DATABASE_URL).toBe(
      "postgres://postgres:postgres@localhost:5432/ponzu_test",
    );
    const gate = ci.jobs.test as Job;
    expect(gate.name).toBe("Check, typecheck, test");
    expect(gate.needs).toContain("migrations");
    expect(gate.steps.map((s) => s.run ?? "").join("\n")).toContain('[ "$MIGRATIONS" = success ]');
  });
});

describe("what a change lands on", () => {
  const step = (ci.jobs.migrations as Job).steps.find((s) => s.id === "base") as Step;

  /** A repository with main at A, then B; returns its path and the two commits. */
  async function repo() {
    const dir = mkdtempSync(join(tmpdir(), "lands-on-"));
    const git = (...args: string[]) =>
      spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
    await git("init", "-q", "-b", "main");
    for (const name of ["a", "b"]) {
      writeFileSync(join(dir, name), name);
      await git("add", name);
      await git("commit", "-q", "-m", name);
    }
    const a = (await git("rev-parse", "HEAD^")).stdout.trim();
    const b = (await git("rev-parse", "HEAD")).stdout.trim();
    return { dir, a, b };
  }

  async function landsOn(dir: string, env: Record<string, string>) {
    const output = join(dir, "..", `${Math.random()}.out`);
    writeFileSync(output, "");
    const result = await spawn(["bash", "-e", "-c", step.run as string], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, ...env },
    });
    const said = readFileSync(output, "utf8");
    rmSync(output);
    return { code: result.code, base: said.match(/^base=(.*)$/m)?.[1] };
  }

  test("a queue entry lands on the entry ahead of it; a pull request on its merge's base", async () => {
    const { dir, a } = await repo();
    expect(await landsOn(dir, { EVENT: "merge_group", MERGE_GROUP_BASE: a })).toEqual({
      code: 0,
      base: a,
    });
    expect(await landsOn(dir, { EVENT: "pull_request" })).toEqual({ code: 0, base: a });
    rmSync(dir, { recursive: true });
  });

  test("a push lands on the commit before it, or its parent when GitHub has none", async () => {
    const { dir, a } = await repo();
    expect(await landsOn(dir, { EVENT: "push", BEFORE: a })).toEqual({ code: 0, base: a });
    const zero = "0000000000000000000000000000000000000000";
    expect(await landsOn(dir, { EVENT: "push", BEFORE: zero })).toEqual({ code: 0, base: a });
    rmSync(dir, { recursive: true });
  });

  test("a base that is not a commit fails the step, so nothing is judged against nothing", async () => {
    const { dir } = await repo();
    const result = await landsOn(dir, { EVENT: "merge_group", MERGE_GROUP_BASE: "f".repeat(40) });
    expect(result.code).not.toBe(0);
    rmSync(dir, { recursive: true });
  });
});

describe("release.yml's hold with a merge queue", () => {
  const job = load("release.yml").jobs["auto-merge"] as Job;
  const step = job.steps.find((s) => s.run?.includes("gh pr merge")) as Step;

  async function runStep(options: { major: boolean; queued: boolean }) {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8"),
    ) as Record<string, string>;
    const [major, minor] = (manifest["."] as string).split(".").map(Number) as [number, number];
    const version = options.major ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
    const dir = mkdtempSync(join(tmpdir(), "release-queue-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin", "gh"),
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >>"$FAKE_LOG"',
        'case "$1 $2" in',
        '  "pr list") printf "%s\\n" "$FAKE_PR" ;;',
        '  "api -H") printf "%s" "$FAKE_MANIFEST" ;;',
        // The query asks for the PR's node id when it is queued: --jq prints it, or nothing.
        '  "api graphql") case "$*" in *isInMergeQueue*) [ -z "$FAKE_QUEUED" ] || echo PR_node ;; esac ;;',
        "esac",
      ].join("\n"),
    );
    chmodSync(join(dir, "bin", "gh"), 0o755);
    const log = join(dir, "gh.log");
    writeFileSync(log, "");
    const result = await spawn(["bash", "-e", "-c", step.run as string], {
      cwd: ROOT,
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: process.env.HOME ?? dir,
        APP: "ponzu",
        RELEASES_HELD: "",
        GITHUB_REPOSITORY: "o/r",
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        FAKE_LOG: log,
        FAKE_PR: JSON.stringify({
          number: 5,
          title: `chore(main): release ${version}`,
          headRefOid: "abc",
          autoMergeRequest: { mergeMethod: "SQUASH" },
        }),
        FAKE_MANIFEST: JSON.stringify({ ".": version }),
        ...(options.queued ? { FAKE_QUEUED: "1" } : {}),
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    rmSync(dir, { recursive: true });
    return { code: result.code, calls, out: result.stdout };
  }
  const dequeues = (calls: string[]) => calls.filter((c) => c.includes("dequeuePullRequest"));

  test("a held release PR already in the queue is taken out, and loses auto-merge", async () => {
    const run = await runStep({ major: true, queued: true });
    expect(run.code).toBe(0);
    expect(run.calls).toContain("pr merge 5 --repo o/r --disable-auto");
    expect(dequeues(run.calls)).toHaveLength(1);
    expect(dequeues(run.calls)[0]).toContain(`input: {id: "PR_node"}`);
    expect(run.out).toContain("took held release PR #5 out of the merge queue");
  });

  test("a held release PR not in the queue is only taken off auto-merge", async () => {
    const run = await runStep({ major: true, queued: false });
    expect(run.code).toBe(0);
    expect(dequeues(run.calls)).toEqual([]);
  });

  test("a release PR that is not held keeps auto-merge, which the queue honours", async () => {
    // `gh pr merge --squash --auto` on a branch with a merge queue enables auto-merge, and the
    // PR joins the queue once its checks pass (gh pr merge --help); the queue squashes.
    const run = await runStep({ major: false, queued: true });
    expect(run.code).toBe(0);
    expect(run.calls.some((c) => c.startsWith("api graphql"))).toBe(false);
    expect(run.out).toContain("auto-merge already enabled on #5");
  });
});
