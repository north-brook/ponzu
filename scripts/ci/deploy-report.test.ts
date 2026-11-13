import { describe, expect, test } from "bun:test";
import {
  fromEnv,
  type GitHub,
  ghGitHub,
  productionSentence,
  type Run,
  report,
  verdictOf,
} from "./deploy-report.ts";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const run = (over: Partial<Run> = {}): Run => ({
  commit: SHA,
  runUrl: "https://github.com/o/r/actions/runs/7",
  plan: "success",
  deploy: true,
  dev: "success",
  productionOn: true,
  productionEnabled: true,
  production: "success",
  promote: "skipped",
  rollback: "skipped",
  restored: "skipped",
  rollbackMinute: "skipped",
  previousCommit: OLD,
  ...over,
});

/** A GitHub that records what was done, with one issue open or none. */
function fakeGitHub(open: number | null) {
  const done: string[] = [];
  const github: GitHub = {
    failedStep: async () => ({
      job: "Migrate, deploy and check dev",
      step: "Dev's selfcheck passes",
      url: "https://github.com/o/r/actions/runs/7/job/9",
    }),
    pullRequest: async () => 601,
    openIssue: async () => open,
    createIssue: async (title, body) => {
      done.push(`create ${title}\n${body}`);
      return 42;
    },
    comment: async (n, body) => void done.push(`comment #${n}\n${body}`),
    closeIssue: async (n, body) => void done.push(`close #${n}\n${body}`),
  };
  return { github, done };
}
const live = async () => ({
  dev: "aaaaaaaaaaaa (status ok, dev)",
  production: "bbbbbbbbbbbb (status ok, production)",
});

describe("the verdict", () => {
  test("is deployed only when every job asked of it passed", () => {
    expect(verdictOf(run())).toBe("deployed");
    expect(verdictOf(run({ productionOn: false, production: "skipped" }))).toBe("deployed");
    expect(verdictOf(run({ deploy: false, dev: "skipped", production: "skipped" }))).toBe(
      "nothing",
    );
    expect(verdictOf(run({ dev: "failure", production: "skipped" }))).toBe("failed");
    expect(verdictOf(run({ dev: "cancelled", production: "skipped" }))).toBe("failed");
    expect(verdictOf(run({ production: "failure" }))).toBe("failed");
    expect(verdictOf(run({ plan: "failure" }))).toBe("failed");
  });

  test("says plainly where production stands after each kind of failure", () => {
    expect(productionSentence(run({ dev: "failure", production: "skipped" }))).toBe(
      "Production was not touched: it deploys only after dev has passed.",
    );
    expect(productionSentence(run({ production: "failure" }))).toBe(
      "Production was not promoted, so it still serves what it served before.",
    );
    expect(
      productionSentence(
        run({
          production: "failure",
          rollback: "success",
          restored: "success",
          rollbackMinute: "success",
        }),
      ),
    ).toContain(`was put back on ${OLD.slice(0, 12)}; the database keeps the new migrations`);
    expect(productionSentence(run({ production: "failure", rollback: "failure" }))).toContain(
      "PRODUCTION MAY BE SERVING THE FAILED DEPLOYMENT",
    );
    expect(
      productionSentence(run({ production: "failure", rollback: "success", restored: "failure" })),
    ).toContain("PRODUCTION DID NOT ANSWER");
    expect(
      productionSentence(
        run({
          production: "failure",
          rollback: "success",
          restored: "success",
          rollbackMinute: "failure",
        }),
      ),
    ).toContain("ITS MINUTE IS NOT ACTIVE: turn Disable Cron Jobs off");
    // Cancelled or out of time once the promotion had started, with nothing put back: it can't
    // say production is where it was.
    for (const promote of ["success", "failure", "cancelled"] as const)
      expect(
        productionSentence(run({ production: "cancelled", promote, rollback: "skipped" })),
      ).toContain("PRODUCTION MAY BE SERVING THE FAILED DEPLOYMENT");
    expect(productionSentence(run({ production: "cancelled", promote: "skipped" }))).toBe(
      "Production was not promoted, so it still serves what it served before.",
    );
    // A dispatch, with production on: it says production waits for the next push.
    expect(productionSentence(run({ productionOn: false, production: "skipped" }))).toContain(
      "a dispatch deploys dev alone",
    );
  });
});

describe("the issue", () => {
  test("a failure opens one naming the commit, the pull request, the step and the log", async () => {
    const { github, done } = fakeGitHub(null);
    const out = await report({ run: run({ dev: "failure", production: "skipped" }), github, live });
    expect(out).toMatchObject({ verdict: "failed", issue: 42, action: "opened" });
    expect(done).toHaveLength(1);
    const [created] = done;
    expect(created).toStartWith(`create The API deploy of ${SHA.slice(0, 12)} failed`);
    expect(created).toContain(`- Commit: ${SHA} (#601)`);
    expect(created).toContain('at "Migrate, deploy and check dev" › "Dev\'s selfcheck passes"');
    expect(created).toContain("- Log: https://github.com/o/r/actions/runs/7/job/9");
    expect(created).toContain("- Dev serves aaaaaaaaaaaa (status ok, dev).");
    expect(created).toContain("- Production serves bbbbbbbbbbbb (status ok, production).");
  });

  test("another failure adds to the open one; a success closes it; nothing deployed leaves it", async () => {
    const again = fakeGitHub(42);
    expect(
      (await report({ run: run({ production: "failure" }), github: again.github, live })).action,
    ).toBe("commented");
    expect(again.done[0]).toStartWith("comment #42");
    const fixed = fakeGitHub(42);
    expect((await report({ run: run(), github: fixed.github, live })).action).toBe("closed");
    expect(fixed.done[0]).toStartWith("close #42");
    const nothing = fakeGitHub(42);
    const out = await report({
      run: run({ deploy: false, dev: "skipped", production: "skipped" }),
      github: nothing.github,
      live,
    });
    expect(out.action).toBe("none");
    expect(nothing.done).toEqual([]);
    expect(out.text).toContain("changes nothing the API is made from");
  });

  test("a dispatch that deployed dev alone leaves a production failure's issue open", async () => {
    const open = fakeGitHub(42);
    const out = await report({
      run: run({ productionOn: false, production: "skipped" }),
      github: open.github,
      live,
    });
    expect(out).toMatchObject({ verdict: "deployed", issue: 42, action: "left open" });
    expect(open.done).toEqual([]);
    // With production off altogether, dev is everything a run is asked to do.
    const devOnly = fakeGitHub(42);
    const closed = await report({
      run: run({ productionOn: false, productionEnabled: false, production: "skipped" }),
      github: devOnly.github,
      live,
    });
    expect(closed.action).toBe("closed");
  });
});

describe("from the workflow", () => {
  test("reads the jobs' results, and treats anything unknown as a failure", () => {
    const r = fromEnv({
      GITHUB_SHA: SHA,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_RUN_ID: "7",
      PLAN: "success",
      DEPLOY: "true",
      DEV: "success",
      PRODUCTION_ON: "true",
      PRODUCTION_ENABLED: "true",
      PRODUCTION: "weird",
      PROMOTE: "cancelled",
      ROLLBACK: "",
      PREVIOUS_COMMIT: "not a sha",
    });
    expect(r.production).toBe("failure");
    expect(r.rollback).toBe("");
    expect(r.promote).toBe("cancelled");
    expect(r.productionEnabled).toBe(true);
    expect(r.previousCommit).toBe("");
    expect(r.runUrl).toBe("https://github.com/o/r/actions/runs/7");
  });

  test("gh: the first failed step, the merged pull request, and the issue calls", async () => {
    const calls: string[] = [];
    const gh = async (args: string[], input?: string) => {
      calls.push(args.join(" ") + (input === undefined ? "" : ` <<${input.length}`));
      if (args[1]?.includes("/jobs"))
        return JSON.stringify([
          {
            name: "Plan",
            html_url: "u1",
            conclusion: "success",
            steps: [{ name: "x", conclusion: "success" }],
          },
          {
            name: "Migrate, deploy and check production",
            html_url: "u2",
            conclusion: "failure",
            steps: [
              { name: "Promote it to api.ponzu.design", conclusion: "success" },
              { name: "The minute is active in production", conclusion: "failure" },
            ],
          },
        ]);
      if (args[1]?.includes("/pulls")) return "601\n";
      if (args[0] === "issue" && args[1] === "list") return "[]";
      if (args[0] === "issue" && args[1] === "create") return "https://github.com/o/r/issues/43\n";
      return "";
    };
    const github = ghGitHub(gh, "o/r", "7");
    expect(await github.failedStep()).toEqual({
      job: "Migrate, deploy and check production",
      step: "The minute is active in production",
      url: "u2",
    });
    expect(await github.pullRequest(SHA)).toBe(601);
    expect(await github.openIssue()).toBeNull();
    expect(await github.createIssue("t", "body")).toBe(43);
    await github.closeIssue(43, "done");
    expect(calls.filter((c) => c.startsWith("issue") || c.startsWith("label"))).toEqual([
      "issue list --repo o/r --label deploy-failed --state open --json number --limit 20",
      "label create deploy-failed --repo o/r --color B60205 --description The API deploy failed (deploy-api.yml) --force",
      "issue create --repo o/r --title t --label deploy-failed --body-file - <<4",
      "issue comment 43 --repo o/r --body-file - <<4",
      "issue close 43 --repo o/r",
    ]);
  });
});
