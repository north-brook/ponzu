import { getPullRequestContext, type PullRequestContext } from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { UserActor } from "../auth/actor.ts";
import { requireCanvas } from "../auth/authorize.ts";
import type { Deps } from "../deps/index.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";
import { actOnPullRequest, type PullRequestAction } from "../pull-requests/actions.ts";
import { openPullRequest } from "../pull-requests/open.ts";
import { readPullRequest, recordCurrent, targetOf } from "../pull-requests/sync.ts";
import { PullRequestTabView, toTab } from "../pull-requests/view.ts";

/*
 * A canvas's pull request (docs/cloud.md, "Pull requests"): what the tab shows, one file's diff,
 * opening it and acting on it. Reading takes read access to the canvas; everything else takes
 * write access. Every answer is GitHub's word as of the request, and is recorded on the canvas's
 * row, which is what the sidebar and the chrome watch.
 */

const Params = z.object({ id: z.string().min(1).max(64) });
/** The commit the person looked at: what they act on, and nothing pushed since. */
const HeadSha = z.string().regex(/^[0-9a-f]{40}$/);
const MergeBody = z.object({
  headSha: HeadSha,
  /**
   * The person chose to merge without what the repo's rules still want, which GitHub allows
   * only to those its rules let bypass them. A client asks them first.
   */
  bypass: z.boolean().default(false),
});
const UpdateBody = z.object({ headSha: HeadSha });
const FileQuery = z.object({ path: z.string().min(1).max(4_096) });
/** The pull request the person said to close; refused if the canvas's newest is another now. */
const CloseQuery = z.object({
  number: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number)
    .optional(),
});

/** The most of one file's diff the tab is sent. */
const MAX_PATCH_CHARS = 512 * 1024;

const FileView = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  change: z.enum(["added", "modified", "deleted", "renamed", "copied", "changed"]),
  additions: z.number(),
  deletions: z.number(),
  /** The unified diff, or what stands in for one that is too large to send or is not text. */
  diff: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), patch: z.string() }),
    z.object({ kind: z.literal("binary") }),
    z.object({ kind: z.literal("too_large") }),
  ]),
});

type Vars = { deps: Deps; actor: UserActor };

/** The canvas, if the person may `need` it, with its repo and installation. */
async function contextOf(
  vars: Vars,
  id: string,
  need: "read" | "write",
): Promise<PullRequestContext> {
  await requireCanvas({ var: vars }, id, need);
  const context = await getPullRequestContext(vars.deps.db, id);
  if (!context) throw new ApiError(404, "not_found", "There is no such canvas.");
  return context;
}

/** Does `action` as the person; answers the tab as GitHub has it afterwards. */
async function act(vars: Vars, id: string, action: PullRequestAction) {
  const context = await contextOf(vars, id, "write");
  return PullRequestTabView.parse(
    await actOnPullRequest(vars.deps, context, vars.actor.user, action),
  );
}

export const canvasPullRequest = new Hono<AppEnv>()
  /** What the tab shows, and the one thing the action button offers. */
  .get("/:id/pull-request", access.user, validate("param", Params), async (c) => {
    const { deps } = c.var;
    const context = await contextOf(c.var, c.req.valid("param").id, "read");
    const target = targetOf(context);
    if (target instanceof ApiError) throw target;
    const found = await readPullRequest(deps, target);
    await recordCurrent(deps, target.canvasId, found);
    return c.json(PullRequestTabView.parse(toTab(target, found.read, deps.config.githubApp.slug)));
  })

  /**
   * One changed file and its diff: one of the first hundred, which the tab lists. 404 for a path
   * that is not among them.
   */
  .get(
    "/:id/pull-request/files",
    access.user,
    validate("param", Params),
    validate("query", FileQuery),
    async (c) => {
      const context = await contextOf(c.var, c.req.valid("param").id, "read");
      const target = targetOf(context);
      if (target instanceof ApiError) throw target;
      const notFound = new ApiError(404, "not_found", "The pull request changes no such file.");
      if (target.number === null) throw notFound;
      const { path } = c.req.valid("query");
      const file = await c.var.deps.github.readPullRequestFile(target.repo, target.number, path);
      if (!file) throw notFound;
      const { patch, ...rest } = file;
      return c.json(FileView.parse({ ...rest, diff: diffOf(file.change, patch, rest) }));
    },
  )

  /**
   * Opens a draft pull request from the canvas's branch into the repo's default branch, as the
   * person: 201 with the tab. When one is already open from the branch, or merged with nothing
   * pushed since, 200 with it. When the commits are only in the canvas's sandbox, 202 with the
   * tab: its runner was asked to push them, and the client asks again once GitHub has them.
   */
  .post("/:id/pull-request", access.user, validate("param", Params), async (c) => {
    const context = await contextOf(c.var, c.req.valid("param").id, "write");
    const { tab, opened, pushing } = await openPullRequest(c.var.deps, context, c.var.actor.user);
    // 202: the sandbox is pushing the branch first; ask again once GitHub has it.
    return c.json(PullRequestTabView.parse(tab), pushing ? 202 : opened ? 201 : 200);
  })

  .post("/:id/pull-request/ready", access.user, validate("param", Params), async (c) =>
    c.json(await act(c.var, c.req.valid("param").id, { kind: "ready" })),
  )

  /** Merges it the first way of squash, merge and rebase that the repo allows, as the person. */
  .post(
    "/:id/pull-request/merge",
    access.user,
    validate("param", Params),
    validate("json", MergeBody),
    async (c) => {
      const { headSha, bypass } = c.req.valid("json");
      return c.json(await act(c.var, c.req.valid("param").id, { kind: "merge", headSha, bypass }));
    },
  )

  .post("/:id/pull-request/auto-merge", access.user, validate("param", Params), async (c) =>
    c.json(await act(c.var, c.req.valid("param").id, { kind: "auto_merge", enabled: true })),
  )

  .delete("/:id/pull-request/auto-merge", access.user, validate("param", Params), async (c) =>
    c.json(await act(c.var, c.req.valid("param").id, { kind: "auto_merge", enabled: false })),
  )

  /**
   * Closes it without merging, as the person. `?number=` names the one they said to close: 409
   * `pull_request_changed` if the canvas's newest is another by now.
   */
  .post(
    "/:id/pull-request/close",
    access.user,
    validate("param", Params),
    validate("query", CloseQuery),
    async (c) => {
      const { number } = c.req.valid("query");
      return c.json(
        await act(c.var, c.req.valid("param").id, {
          kind: "close",
          ...(number === undefined ? {} : { number }),
        }),
      );
    },
  )

  /** Merges the base into the branch, when the branch is behind it. */
  .post(
    "/:id/pull-request/update-branch",
    access.user,
    validate("param", Params),
    validate("json", UpdateBody),
    async (c) => {
      const { headSha } = c.req.valid("json");
      return c.json(await act(c.var, c.req.valid("param").id, { kind: "update_branch", headSha }));
    },
  );

/**
 * What the tab is sent for a file: GitHub gives no patch for a binary file or one too large to
 * diff, and says how many lines changed either way; a rename that changed nothing has neither.
 */
function diffOf(
  change: string,
  patch: string | null,
  lines: { additions: number; deletions: number },
) {
  if (patch !== null) {
    return patch.length > MAX_PATCH_CHARS
      ? { kind: "too_large" as const }
      : { kind: "text" as const, patch };
  }
  if (lines.additions + lines.deletions > 0) return { kind: "too_large" as const };
  return change === "renamed" ? { kind: "text" as const, patch: "" } : { kind: "binary" as const };
}
