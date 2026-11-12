import type {
  AgentPullRequestAction,
  AgentPullRequestAnswer,
  PullRequestStanding,
} from "@ponzu/runner/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { Deps } from "../deps/index.ts";
import type { AppEnv } from "../http/context.ts";
import { validate } from "../http/validate.ts";
import { agentActOnPullRequest, agentReadPullRequest } from "../pull-requests/agent.ts";

/*
 * The design's agent driving its pull request, through its runner (docs/cloud.md, "The agent's
 * pull request"). Each does what the person's own route does, through the same code, as the
 * person the turn is for (`pull-requests/agent.ts`), behind the guardrails that code holds to:
 * a turn no person began never merges, marks ready or turns on auto-merge; the person must still
 * be able to push to the repo; the merge never sets the repo's rules aside; and each is limited
 * to a few an hour. Mounted beside the runner's other routes under `/v1/runner`.
 */

const TurnId = z
  .string()
  .regex(/^evt_[0-9a-z]{1,64}$/)
  .nullable();
const TurnQuery = z.object({
  turn: z
    .string()
    .regex(/^evt_[0-9a-z]{1,64}$/)
    .optional(),
});
const HeadSha = z.string().regex(/^[0-9a-f]{40}$/);
/** Strict: there is no `bypass`, nor anything else, for the agent to send. */
const Act = z.object({ turn: TurnId }).strict();
const ActAt = z.object({ turn: TurnId, headSha: HeadSha }).strict();

export const runnerPullRequest = new Hono<AppEnv>()
  /** Where the design's pull request stands, read now, and who the agent would act as. */
  .get("/pull-request", access.runner, validate("query", TurnQuery), async (c) => {
    const { turn } = c.req.valid("query");
    const standing = await agentReadPullRequest(c.var.deps, c.var.actor.designId, {
      eventId: turn ?? null,
      runnerId: c.var.actor.runnerId,
    });
    return c.json(standing satisfies PullRequestStanding);
  })

  /** Opens it as a draft, as the person; the answer says whether this call opened it. */
  .post("/pull-request/open", access.runner, validate("json", Act), async (c) => {
    const { turn } = c.req.valid("json");
    return c.json(await answer(c.var, "open", turn));
  })

  .post("/pull-request/ready", access.runner, validate("json", Act), async (c) => {
    const { turn } = c.req.valid("json");
    return c.json(await answer(c.var, "ready", turn));
  })

  .post("/pull-request/auto-merge", access.runner, validate("json", Act), async (c) => {
    const { turn } = c.req.valid("json");
    return c.json(await answer(c.var, "auto_merge", turn));
  })

  .post("/pull-request/update-branch", access.runner, validate("json", ActAt), async (c) => {
    const { turn, headSha } = c.req.valid("json");
    return c.json(await answer(c.var, "update_branch", turn, headSha));
  })

  /** Merges only what GitHub says can merge cleanly, never past the repo's rules. */
  .post("/pull-request/merge", access.runner, validate("json", ActAt), async (c) => {
    const { turn, headSha } = c.req.valid("json");
    return c.json(await answer(c.var, "merge", turn, headSha));
  });

async function answer(
  vars: { deps: Deps; actor: { designId: string; runnerId: string } },
  action: AgentPullRequestAction,
  turn: string | null,
  headSha?: string,
): Promise<AgentPullRequestAnswer> {
  return agentActOnPullRequest(vars.deps, vars.actor.designId, {
    action,
    turn: { eventId: turn, runnerId: vars.actor.runnerId },
    ...(headSha ? { headSha } : {}),
  });
}
