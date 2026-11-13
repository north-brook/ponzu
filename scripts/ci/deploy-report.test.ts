import { describe, expect, test } from "bun:test";
import {
  fromEnv,
  type GitHub,
  ghGitHub,
  PRODUCTION_MARK,
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
function fakeGitHub(open: number | null, production = false) {
  const done: string[] = [];
  const github: GitHub = {
    failedStep: async () => ({
      job: "Migrate, deploy and check dev",
      step: "Dev's selfcheck passes",
      url: "https://github.com/o/r/actions/runs/7/job/9",
    }),
    pullRequest: async () => 601,
    openIssue: async () => open,
    recordsProductionFailure: async () => production,
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

  test("only a production failure's report carries the production mark", async () => {
    const prod = fakeGitHub(null);
    await report({ run: run({ production: "failure" }), github: prod.github, live });
    expect(prod.done[0]).toContain(PRODUCTION_MARK);
    const dev = fakeGitHub(null);
    await report({ run: run({ dev: "failure", production: "skipped" }), github: dev.github, live });
    expect(dev.done[0]).not.toContain(PRODUCTION_MARK);
  });

  test("a run that left production out leaves a production failure's issue open", async () => {
    const open = fakeGitHub(42, true);
    const out = await report({
      run: run({ productionOn: false, production: "skipped" }),
      github: open.github,
      live,
    });
    expect(out).toMatchObject({ verdict: "deployed", issue: 42, action: "left open" });
    expect(open.done).toEqual([]);
    // Production switched off after it failed: nothing proves production, so it stays open.
    const switchedOff = fakeGitHub(42, true);
    const stays = await report({
      run: run({ productionOn: false, productionEnabled: false, production: "skipped" }),
      github: switchedOff.github,
      live,
    });
    expect(stays.action).toBe("left open");
    expect(switchedOff.done).toEqual([]);
    // An issue about dev alone is closed by a dev-only run that passes.
    const devOnly = fakeGitHub(42, false);
    const closed = await report({
      run: run({ productionOn: false, productionEnabled: false, production: "skipped" }),
      github: devOnly.github,
      live,
    });
    expect(closed.action).toBe("closed");
    // A push that deployed production as well closes a production failure's issue.
    const both = fakeGitHub(42, true);
    expect((await report({ run: run(), github: both.github, live })).action).toBe("closed");
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
      if (args[0] === "issue" && args[1] === "view") return `body\n${PRODUCTION_MARK}\n`;
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
    expect(await github.recordsProductionFailure(43)).toBe(true);
    expect(await github.createIssue("t", "body")).toBe(43);
    await github.closeIssue(43, "done");
    expect(calls.filter((c) => c.startsWith("issue") || c.startsWith("label"))).toEqual([
      "issue list --repo o/r --label deploy-failed --state open --json number --limit 20",
      expect.stringMatching(/^issue view 43 --repo o\/r --json body,comments --jq /),
      "label create deploy-failed --repo o/r --color B60205 --description The API deploy failed (deploy-api.yml) --force",
      "issue create --repo o/r --title t --label deploy-failed --body-file - <<4",
      "issue comment 43 --repo o/r --body-file - <<4",
      "issue close 43 --repo o/r",
    ]);
  });

  test("gh: a cancelled or timed-out job names the step it stopped in", async () => {
    const jobs =
      (conclusion: string, steps: { name: string; conclusion: string | null }[]) =>
      async (args: string[]) =>
        args[1]?.includes("/jobs")
          ? JSON.stringify([
              { name: "Plan", html_url: "u1", conclusion: "success", steps: [] },
              { name: "Migrate, deploy and check production", html_url: "u2", conclusion, steps },
            ])
          : "";
    const steps = [
      { name: "Promote it to api.ponzu.design", conclusion: "success" },
      { name: "The minute is active in production", conclusion: "cancelled" },
      { name: "Put back the deployment that was serving", conclusion: "success" },
    ];
    expect(await ghGitHub(jobs("cancelled", steps), "o/r", "7").failedStep()).toEqual({
      job: "Migrate, deploy and check production",
      step: "The minute is active in production (the job was cancelled)",
      url: "u2",
    });
    expect(await ghGitHub(jobs("timed_out", steps), "o/r", "7").failedStep()).toEqual({
      job: "Migrate, deploy and check production",
      step: "The minute is active in production (the job ran out of time)",
      url: "u2",
    });
    expect(await ghGitHub(jobs("timed_out", []), "o/r", "7").failedStep()).toEqual({
      job: "Migrate, deploy and check production",
      step: "the job ran out of time",
      url: "u2",
    });
  });

  test("gh: an issue that can't be read is treated as a production failure's", async () => {
    const github = ghGitHub(async () => Promise.reject(new Error("gh failed")), "o/r", "7");
    expect(await github.recordsProductionFailure(43)).toBe(true);
  });
});
