/**
 * `apply.ts github-rulesets`: the repository's rulesets as infra/github/ruleset-*.json say,
 * through `@octokit/core` (the version apps/api uses). A ruleset is found by its name: missing,
 * it is created (`POST /repos/{owner}/{repo}/rulesets`); different, it is replaced with the file
 * (`PUT /repos/{owner}/{repo}/rulesets/{id}`). The files are already in the request's shape.
 *
 * The rulesets belong to the repository, not to an environment, so `--env` may be left out.
 * Needs a token that may administer the repository (`GH_TOKEN=$(gh auth token)` as an admin).
 */
import { findings } from "../checks/finding.ts";
import { githubClient, githubDesired, githubStatus, rulesetDifferences } from "../checks/github.ts";
import { RULESET_REQUEST_FIELDS } from "../desired.ts";
import { type ApplyArea, type ApplyContext, type Change, type Plan, statusError } from "./area.ts";

export const GITHUB_API = "https://api.github.com";

function token(ctx: ApplyContext): string {
  const value = ctx.credentials.GH_TOKEN ?? ctx.credentials.GITHUB_TOKEN;
  if (!value) throw new Error("no GH_TOKEN, no GITHUB_TOKEN");
  return value;
}

async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw statusError("GitHub", githubStatus(error), what);
  }
}

export async function planRulesets(ctx: ApplyContext): Promise<Plan> {
  const desired = githubDesired(ctx);
  const [owner, repo] = desired.repository.split("/") as [string, string];
  const gh = githubClient(ctx, token(ctx));
  // Every page: a ruleset missed on a later page would be created a second time.
  const listed = await step("the rulesets", async () => {
    const all: { id: number; name: string }[] = [];
    for (let page = 1; ; page++) {
      const { data } = await gh.request("GET /repos/{owner}/{repo}/rulesets", {
        owner,
        repo,
        includes_parents: false,
        per_page: 100,
        page,
      });
      all.push(...data.map((r) => ({ id: r.id, name: r.name })));
      if (data.length < 100) return all;
    }
  });
  const notes: string[] = [];
  const changes: Change[] = [];
  const base = `${GITHUB_API}/repos/${owner}/${repo}/rulesets`;
  for (const { ruleset } of desired.rulesets) {
    const body = Object.fromEntries(RULESET_REQUEST_FIELDS.map((key) => [key, ruleset[key]]));
    const same = listed.filter((r) => r.name === ruleset.name);
    if (same.length > 1) {
      notes.push(
        `${same.length} rulesets are named "${ruleset.name}"; delete all but one, then run again`,
      );
      continue;
    }
    const live = same[0];
    if (!live) {
      changes.push({
        says: `the ruleset "${ruleset.name}" does not exist: create it`,
        request: { method: "POST", url: base, body },
        send: () =>
          step(`creating "${ruleset.name}"`, () =>
            gh.request("POST /repos/{owner}/{repo}/rulesets", { owner, repo, ...body } as never),
          ).then(() => undefined),
      });
      continue;
    }
    const detail = await step(`the ruleset "${ruleset.name}"`, async () => {
      const { data } = await gh.request("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
        owner,
        repo,
        ruleset_id: live.id,
      });
      return {
        name: data.name,
        target: data.target ?? null,
        enforcement: data.enforcement,
        bypass_actors: data.bypass_actors ?? null,
        conditions: data.conditions ?? null,
        rules: (data.rules ?? []).map((rule) => {
          const r = rule as { type: string; parameters?: Record<string, unknown> };
          return r.parameters ? { type: r.type, parameters: r.parameters } : { type: r.type };
        }),
      };
    });
    const wrong = rulesetDifferences(ruleset, detail);
    if (!wrong.length) {
      notes.push(`the ruleset "${ruleset.name}" already matches its file`);
      continue;
    }
    changes.push({
      says: `the ruleset "${ruleset.name}": ${wrong.join("; ")}. Replace it with its file`,
      request: { method: "PUT", url: `${base}/${live.id}`, body },
      send: () =>
        step(`replacing "${ruleset.name}"`, () =>
          gh.request("PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
            owner,
            repo,
            ruleset_id: live.id,
            ...body,
          } as never),
        ).then(() => undefined),
    });
  }
  return { notes, changes };
}

export const rulesetsArea: ApplyArea = {
  name: "github-rulesets",
  needs: [],
  needsOneOf: ["GH_TOKEN", "GITHUB_TOKEN"],
  envless: true,
  plan: planRulesets,
  /**
   * Each ruleset read again and judged with the check's own comparison (rulesetDifferences):
   * nothing left to create or replace. The full check's github section needs more than the
   * rulesets (environments, secrets, variables), which this area does not change.
   */
  async verify(ctx) {
    const f = findings("github");
    const left = await planRulesets(ctx);
    return githubDesired(ctx).rulesets.map(({ id, ruleset }) => {
      const still = left.changes.find((c) => c.says.includes(`"${ruleset.name}"`));
      const dup = left.notes.find((n) => n.includes(`"${ruleset.name}"`) && n.includes("delete"));
      return still || dup
        ? f.fail(id, still?.says ?? (dup as string))
        : f.ok(id, `the ruleset "${ruleset.name}" is its file's`);
    });
  },
};
