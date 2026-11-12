import { Hono } from "hono";
import { z } from "zod";
import { deleteAccount } from "../account/delete.ts";
import { access } from "../auth/access.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";

/*
 * Settings › Account › Delete (docs/cloud.md, "Deleting an account"). The person confirms by
 * typing their GitHub login, as the dialog asks. Their name, avatar and email are GitHub's and
 * are changed there, so nothing about the profile is changed here.
 */

const DeleteBody = z.object({
  /** The person's GitHub login, typed out. Case does not matter, as on GitHub. */
  confirm: z.string().trim().min(1).max(100),
});

export const account = new Hono<AppEnv>()
  /**
   * Delete the account. 409 `sole_admin` while the person is the only admin of a team others
   * are in. 204 once it is gone: the app signs out.
   */
  .delete("/", access.user, validate("json", DeleteBody), async (c) => {
    const { deps, actor } = c.var;
    const { user } = actor;
    if (c.req.valid("json").confirm.toLowerCase() !== user.githubLogin.toLowerCase()) {
      throw new ApiError(
        400,
        "confirmation_mismatch",
        `Type ${user.githubLogin} to delete your account.`,
      );
    }
    await deleteAccount(deps, user);
    return c.body(null, 204);
  });
