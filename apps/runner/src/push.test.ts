import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchPush, classify, pushFailureForAgent, pushFailureText } from "./push.ts";
import { agentShell, ShellError } from "./save/shell.ts";
import { type Git, gitIn } from "./save/work.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "ponzu[bot]",
  GIT_COMMITTER_EMAIL: "bot@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

/** A repository on "GitHub" (a bare one) with `main`, and a checkout of it on the canvas's branch. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "ponzu-push-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "README.md"), "fern\n");
  sh(seed, "add", ".");
  sh(seed, "commit", "-qm", "First");
  sh(seed, "push", "-q", origin, "main");
  const work = join(root, "work");
  sh(root, "clone", "-q", origin, work);
  sh(work, "switch", "-qc", "pz/hero");
  let n = 0;
  const commit = (dir = work) => {
    writeFileSync(join(dir, `screen-${++n}.html`), `<p>${n}</p>\n`);
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", `Screen ${n}`);
    return sh(dir, "rev-parse", "HEAD");
  };
  const git = gitIn(agentShell(undefined, ENV), "git", work);
  return { root, origin, work, commit, git };
}

function pusher(git: Git, opts: Partial<ConstructorParameters<typeof BranchPush>[0]> = {}) {
  const erased: string[] = [];
  const events: Record<string, unknown>[] = [];
  const slept: number[] = [];
  const push = new BranchPush({
    git,
    branch: "pz/hero",
    defaultBranch: "main",
    erase: async (reason) => {
      erased.push(reason);
    },
    event: (name, fields) => events.push({ name, ...fields }),
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...opts,
  });
  return { push, erased, events, slept };
}

/** git that fails its first `n` pushes as GitHub did on 2026-11-11, then works. */
function refusingFirst(git: Git, n: number): Git {
  let refused = 0;
  return async (args, opts) => {
    if (args[0] === "push" && refused < n) {
      refused++;
      throw new ShellError(
        "git exited 128: fatal: repository 'https://github.com/north/fern.git/' not found",
        128,
        "remote: Repository not found.\nfatal: repository 'https://github.com/north/fern.git/' not found\n",
      );
    }
    return git(args, opts);
  };
}

test("commits the agent left unpushed go to GitHub, and nothing is pushed when there is nothing", async () => {
  const r = repo();
  const { push, events } = pusher(r.git);
  expect(await push.unpushed()).toBe(0);
  expect(await push.push()).toEqual({ unpushed: 0, pushed: 0, failure: null });
  expect(events).toEqual([]);

  const head = r.commit();
  r.commit();
  expect(await push.unpushed()).toBe(2);
  expect(await push.push()).toEqual({ unpushed: 0, pushed: 2, failure: null });
  expect(sh(r.origin, "rev-parse", "refs/heads/pz/hero")).toBe(sh(r.work, "rev-parse", "HEAD"));
  expect(sh(r.origin, "rev-parse", "refs/heads/pz/hero~1")).toBe(head);
  expect(await push.unpushed()).toBe(0);
  expect(events).toMatchObject([{ name: "git_push", ok: true, attempt: 0 }]);
});

test("a push GitHub refuses as 'Repository not found' is tried again with a new token, and lands", async () => {
  const r = repo();
  r.commit();
  const { push, erased, slept, events } = pusher(refusingFirst(r.git, 2));
  const outcome = await push.push();
  expect(outcome).toEqual({ unpushed: 0, pushed: 1, failure: null });
  // Each refusal gave the token back, so the next try minted another.
  expect(erased).toEqual([
    "git push failed: fatal: repository 'https://github.com/north/fern.git/' not found",
    "git push failed: fatal: repository 'https://github.com/north/fern.git/' not found",
  ]);
  expect(slept).toEqual([2_000, 5_000]);
  expect(events.map((e) => e.ok)).toEqual([false, false, true]);
  expect(sh(r.origin, "rev-parse", "refs/heads/pz/hero")).toBe(sh(r.work, "rev-parse", "HEAD"));
});

test("a push that keeps failing gives up after the waits, or by the deadline, and says why", async () => {
  const r = repo();
  r.commit();
  const { push, slept } = pusher(refusingFirst(r.git, 99));
  const outcome = await push.push();
  expect(outcome.unpushed).toBe(1);
  expect(outcome.failure).toEqual({
    kind: "transient",
    said: "remote: Repository not found.\nfatal: repository 'https://github.com/north/fern.git/' not found",
  });
  expect(slept).toEqual([2_000, 5_000, 10_000, 15_000]);

  let now = 0;
  const bounded = pusher(refusingFirst(r.git, 99), {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  // Getting ready to sleep: only what fits before the deadline.
  await bounded.push.push({ deadline: 3_000 });
  expect(bounded.erased).toHaveLength(1);
});

test("a branch that moved on GitHub is never pushed over, and a deleted one is pushed again only with new commits", async () => {
  const r = repo();
  r.commit();
  const { push } = pusher(r.git);
  await push.push();

  // Someone pushed to the branch on GitHub from elsewhere.
  const other = join(r.root, "other");
  sh(r.root, "clone", "-q", "-b", "pz/hero", r.origin, other);
  const theirs = r.commit(other);
  sh(other, "push", "-q", "origin", "pz/hero");
  r.commit();

  const diverged = pusher(r.git);
  const outcome = await diverged.push.push();
  expect(outcome.failure?.kind).toBe("diverged");
  expect(outcome.unpushed).toBe(1);
  // Not tried again, and GitHub's commit is still there.
  expect(diverged.erased).toEqual([]);
  expect(sh(r.origin, "rev-parse", "refs/heads/pz/hero")).toBe(theirs);

  // The branch deleted on GitHub (merged, say) at the commit the checkout has: left deleted.
  sh(r.origin, "update-ref", "-d", "refs/heads/pz/hero");
  sh(r.work, "reset", "-q", "--hard", "HEAD~1");
  const gone = pusher(r.git);
  expect(await gone.push.unpushed()).toBe(0);
  expect(await gone.push.push()).toEqual({ unpushed: 0, pushed: 0, failure: null });
  expect(gone.events).toEqual([]);
  expect(() => sh(r.origin, "rev-parse", "--verify", "refs/heads/pz/hero")).toThrow();

  // New commits on it: GitHub lacks them, so it goes back with them, as the agent's push would.
  r.commit();
  expect((await pusher(r.git).push.push()).failure).toBeNull();
  expect(sh(r.origin, "rev-parse", "refs/heads/pz/hero")).toBe(sh(r.work, "rev-parse", "HEAD"));
});

test("a branch pruned after its merge is not put back on GitHub", async () => {
  const r = repo();
  r.commit();
  await pusher(r.git).push.push();
  // Merged and deleted on GitHub, and a fetch pruned it here: the upstream stays configured.
  sh(r.origin, "update-ref", "-d", "refs/heads/pz/hero");
  sh(r.work, "fetch", "-q", "--prune", "origin");
  const pruned = pusher(r.git);
  expect(await pruned.push.unpushed()).toBe(0);
  expect((await pruned.push.push()).pushed).toBe(0);
  expect(() => sh(r.origin, "rev-parse", "--verify", "refs/heads/pz/hero")).toThrow();

  // A checkout restored without its upstream: the merged pull request says the same.
  sh(r.work, "branch", "-q", "--unset-upstream");
  expect(await pusher(r.git).push.unpushed()).toBe(1);
  const merged = pusher(r.git, { merged: () => true });
  expect(await merged.push.unpushed()).toBe(0);
  expect((await merged.push.push()).pushed).toBe(0);
  expect(() => sh(r.origin, "rev-parse", "--verify", "refs/heads/pz/hero")).toThrow();
});

test("what git says decides whether to try again", () => {
  const fail = (stdout: string, stderr: string) => classify(new ShellError("x", 1, stderr, stdout));
  expect(
    fail(
      "To https://github.com/north/fern.git\n!\trefs/heads/pz/hero:refs/heads/pz/hero\t[rejected] (fetch first)\nDone",
      "error: failed to push some refs to 'https://github.com/north/fern.git'",
    ).kind,
  ).toBe("diverged");
  expect(
    fail("", "remote: error: GH006: Protected branch update failed for refs/heads/pz/hero.").kind,
  ).toBe("refused");
  // GitHub's own lines for a workflow file, verbatim: the App's porcelain refusal, and an OAuth
  // App's. Their own kind, never tried again and never "refused" (which tells Claude to fix it).
  expect(
    fail(
      "To https://github.com/north/fern.git\n!\trefs/heads/pz/hero:refs/heads/pz/hero\t[remote rejected] (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)\nDone",
      "error: failed to push some refs to 'https://github.com/north/fern.git'",
    ),
  ).toEqual({
    kind: "workflow_permission",
    said: "!\trefs/heads/pz/hero:refs/heads/pz/hero\t[remote rejected] (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)\nerror: failed to push some refs to 'https://github.com/north/fern.git'",
  });
  expect(
    fail(
      "",
      "! [remote rejected] pz/hero -> pz/hero (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
    ).kind,
  ).toBe("workflow_permission");
  // A hook that declines for its own reasons is still `refused`.
  expect(
    fail("", "! [remote rejected] pz/hero -> pz/hero (pre-receive hook declined)").kind,
  ).toBe("refused");
  expect(
    fail("", "fatal: unable to access 'https://github.com/': Could not resolve host").kind,
  ).toBe("transient");
  expect(
    fail("", "fatal: could not read Username for 'https://github.com': terminal prompts disabled")
      .kind,
  ).toBe("transient");
  // The agent's push landed at the same moment: GitHub's ref was locked, not a rule.
  expect(
    fail(
      "!\trefs/heads/pz/hero:refs/heads/pz/hero\t[remote rejected] (failed to update ref)\nDone",
      "error: failed to push some refs",
    ).kind,
  ).toBe("transient");
});

test("the thread says what happened and what to do, in Ponzu's words", () => {
  const where = { branch: "pz/hero", repo: "north/fern", unpushed: 2 };
  expect(
    pushFailureText({ kind: "transient", said: "fatal: repository 'x' not found" }, where),
  ).toBe(
    "Ponzu couldn't push pz/hero to north/fern (fatal: repository 'x' not found). 2 commits on pz/hero are safe in this canvas's sandbox: Ponzu tries again when Claude's next turn ends, and Create PR tries again too.",
  );
  expect(pushFailureText({ kind: "diverged", said: "" }, { ...where, unpushed: 1 })).toBe(
    "pz/hero on GitHub has commits this canvas doesn't, so Ponzu didn't push over them. 1 commit on pz/hero is safe in this canvas's sandbox. Ask Claude to bring in what's on GitHub and push again.",
  );
  // What the App lacks is no one's to fix in the canvas: leave the files out, or change them on
  // GitHub.
  const workflow = pushFailureText({ kind: "workflow_permission", said: "x" }, where);
  expect(workflow).toBe(
    "GitHub won't let Ponzu push changes to files under .github/workflows/ to north/fern: Ponzu's GitHub App isn't allowed to change workflows. 2 commits on pz/hero are safe in this canvas's sandbox. Ask Claude to leave workflow files out of this canvas's commits, or change them on GitHub yourself.",
  );
  expect(workflow).not.toMatch(/fix/i);
  expect(pushFailureForAgent({ kind: "workflow_permission", said: "a\nb" })).toBe(
    "GitHub refuses every push from Ponzu that changes a file under .github/workflows/: Ponzu's GitHub App isn't allowed to change workflows, so trying again won't get it through. Take those changes out of the branch's commits and push again, and tell the person which workflow change they'll need to make on GitHub themselves. (b)",
  );
});
