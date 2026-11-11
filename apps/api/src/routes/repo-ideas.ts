import type { RepoIdeasAccess } from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { requireRepo } from "../auth/authorize.ts";
import type { AppEnv } from "../http/context.ts";
import { UpstreamError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";
import { repoIdeas as ideasFor } from "../ideas/ideas.ts";

/**
 * A repo's ideas, for the create page: `ready` with four prompts; `generating` while they are
 * being made (ask again in a second or two); `none` when there are none to show, for now or
 * for good. Asking is what starts them, the first time anyone does (docs/cloud.md, "Ideas").
 */
const Ideas = z.object({
  status: z.enum(["ready", "generating", "none"]),
  ideas: z.array(z.object({ prompt: z.string() })),
});

const RepoParam = z.object({ id: z.string().max(64) });

export const repoIdeas = new Hono<AppEnv>()
  /** Anyone who may read the repo; a repo they cannot read is a 404. */
  .get("/:id/ideas", access.user, validate("param", RepoParam), async (c) => {
    let found: RepoIdeasAccess;
    try {
      found = await requireRepo(c, c.req.valid("param").id);
    } catch (error) {
      // GitHub could not say whether they may read it: no ideas this time, and no error. The
      // screen works the same without them.
      if (!(error instanceof UpstreamError)) throw error;
      c.var.log.warn("ideas_access_unknown", { repoId: c.req.valid("param").id, error });
      return c.json(Ideas.parse({ status: "none", ideas: [] }));
    }
    const installationId = found.suspendedAt === null ? found.installationId : null;
    const { status, ideas } = await ideasFor(c.var.deps, c.var.log, {
      repo: found.repo,
      installationId,
    });
    return c.json(Ideas.parse({ status, ideas: ideas.map((prompt) => ({ prompt })) }));
  });
