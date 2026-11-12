import { type Handoff, renderHandoff } from "@ponzu/core/handoff";
import { setPingPrefs } from "@ponzu/db";
import { type Context, Hono } from "hono";
import { access } from "../auth/access.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { unsubscribeUser } from "../notifications/unsubscribe.ts";

/*
 * The daily email's unsubscribe link (notifications/digest.ts). It has no bearer token: the
 * token in `t`, which only the API can make (notifications/unsubscribe.ts), says whose email to
 * stop, and that is all it can do.
 *
 *   GET  /v1/email/unsubscribe?t=…  a person followed the email's link: the email is turned off,
 *                                   and the answer is a page that says so.
 *   POST /v1/email/unsubscribe?t=…  their mail app's one-click unsubscribe (RFC 8058, from the
 *                                   `List-Unsubscribe` headers): turned off, 204.
 *
 * Either is safe to repeat. The email can be turned on again in Settings › Notifications.
 */

/** The page's headers besides its content security policy. The address carries the token. */
const PAGE_HEADERS = {
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const DONE: Handoff = {
  documentTitle: "Daily email off",
  view: {
    title: "You won't get Ponzu's daily email any more.",
    body: "You can turn it on again in Ponzu, in Settings › Notifications. You can close this tab.",
  },
  link: null,
};

const BROKEN: Handoff = {
  documentTitle: "Link not working",
  view: {
    title: "This link doesn't work",
    body: "You can turn the daily email off in Ponzu, in Settings › Notifications.",
  },
  link: null,
  problem: true,
};

/** Turns off the email of the person the request's token names; false when it names nobody. */
async function unsubscribe(c: Context<AppEnv>): Promise<boolean> {
  const { deps } = c.var;
  const userId = await unsubscribeUser(deps.vault, c.req.query("t"));
  if (!userId) return false;
  try {
    await setPingPrefs(deps.db, { userId, prefs: { emailDigest: false } });
  } catch (error) {
    // An account deleted since the email went has no email to stop.
    if (!(error instanceof Error && error.message.startsWith("There is no user"))) throw error;
  }
  c.var.log.info("digest_unsubscribed", { userId });
  return true;
}

export const email = new Hono<AppEnv>()
  .get("/unsubscribe", access.public, async (c) => {
    const done = await unsubscribe(c);
    const { html, csp } = await renderHandoff(done ? DONE : BROKEN);
    return c.html(html, done ? 200 : 400, { ...PAGE_HEADERS, "content-security-policy": csp });
  })
  .post("/unsubscribe", access.public, async (c) => {
    if (!(await unsubscribe(c))) {
      throw new ApiError(400, "invalid_request", "This unsubscribe link is not one Ponzu made.");
    }
    return c.body(null, 204);
  });
