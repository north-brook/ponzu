import { removeLinkedPullRequests } from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { requireCanvas } from "../auth/authorize.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";
import { type LinkResult, linkPullRequests, listPullRequests } from "../pull-requests/links.ts";

/*
 * The pull requests a canvas links (docs/cloud.md, "Linked pull requests"), beside its own from
 * its branch. Listing takes read access to the canvas; linking and unlinking take write access,
 * as steering it does. Each pull request linked is checked on its own (`linkPullRequests`).
 */

const Params = z.object({ id: z.string().min(1).max(64) });
const LinkParams = Params.extend({
  repoId: z.string().min(1).max(64),
  number: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number),
});
const LinkBody = z.object({ urls: z.array(z.string().min(1).max(512)).min(1).max(20) }).strict();

export const canvasPullRequests = new Hono<AppEnv>()
  /** The branch's own pull request, if any, and every one the canvas links. */
  .get("/:id/pull-requests", access.user, validate("param", Params), async (c) => {
    const { id } = c.req.valid("param");
    await requireCanvas(c, id, "read");
    return c.json(await listPullRequests(c.var.deps, id));
  })

  /** Links each pull request, and answers what happened to each, in the order given. */
  .post(
    "/:id/pull-requests",
    access.user,
    validate("param", Params),
    validate("json", LinkBody),
    async (c) => {
      const { id } = c.req.valid("param");
      await requireCanvas(c, id, "write");
      const results: LinkResult[] = await linkPullRequests(c.var.deps, {
        canvasId: id,
        user: c.var.actor.user,
        refs: c.req.valid("json").urls,
        source: "person",
      });
      return c.json({ results });
    },
  )

  /** Unlinks one. 404 when the canvas doesn't link it. */
  .delete(
    "/:id/pull-requests/:repoId/:number",
    access.user,
    validate("param", LinkParams),
    async (c) => {
      const { id, repoId, number } = c.req.valid("param");
      await requireCanvas(c, id, "write");
      // By the link's own key, which the list answers: the same as `unlinkPullRequests` by URL.
      const removed = await removeLinkedPullRequests(c.var.deps.db, id, [{ repoId, number }]);
      if (removed.length === 0) {
        throw new ApiError(404, "not_found", "This canvas doesn't link that pull request.");
      }
      c.var.deps.log.info("pull_request_unlinked", { canvasId: id, count: 1 });
      return c.body(null, 204);
    },
  );
