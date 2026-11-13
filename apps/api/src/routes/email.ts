import { type Handoff, renderHandoff } from "@ponzu/core/handoff";
import { setPingPrefs } from "@ponzu/db";
import { unsubscribeWords } from "@ponzu/email";
import { type Context, Hono } from "hono";
import { access } from "../auth/access.ts";
import { UNSUBSCRIBE_PREF, type UnsubscribeCategory } from "../email/kinds.ts";
import { openUnsubscribeToken } from "../email/unsubscribe.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";

/*
 * An email's unsubscribe link (docs/cloud.md, "Email"). It has no bearer token: the token in `t`,
 * which only the API can make (email/unsubscribe.ts), says whose email to stop and which one,
 * and that is all it can do.
 *
 *   GET  /v1/email/unsubscribe?t=…  a person, or a mail filter or link scanner, followed the
 *                                   email's link: nothing changes. The answer is a page that
 *                                   asks, with one button that posts the same token.
 *   POST /v1/email/unsubscribe?t=…  turns that email off. From the person's mail app's one-click
 *                                   unsubscribe (RFC 8058, the `List-Unsubscribe` headers), 204.
 *                                   From the page's button (`via=page`), a page that says so.
 *
 * Only a POST changes anything, because scanners fetch every link in an email (RFC 8058,
 * section 6): a link that stopped an email when fetched would stop default-on emails nobody
 * meant to stop. Either is safe to repeat. The email can be turned on again in Settings ›
 * Notifications.
 */

/** The page's headers besides its content security policy. The address carries the token. */
const PAGE_HEADERS = {
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const TITLE: Record<UnsubscribeCategory, string> = {
  digest: "Daily email",
  team: "Emails when people join",
  recap: "Friday recap",
};

/** The page a followed link answers: the question, and the button that answers it. */
function asking(category: UnsubscribeCategory, token: string): Handoff {
  return {
    documentTitle: TITLE[category],
    view: { title: unsubscribeWords.question[category], body: unsubscribeWords.backOn },
    link: null,
    form: {
      action: `/v1/email/unsubscribe?t=${encodeURIComponent(token)}`,
      fields: { via: "page" },
      label: unsubscribeWords.button,
    },
  };
}

/** The page the button answers. */
function done(category: UnsubscribeCategory): Handoff {
  return {
    documentTitle: `${TITLE[category]} off`,
    view: {
      title: unsubscribeWords.done[category],
      body: `${unsubscribeWords.backOn} You can close this tab.`,
    },
    link: null,
  };
}

const BROKEN: Handoff = {
  documentTitle: "Link not working",
  view: {
    title: "This link doesn't work",
    body: "You can turn Ponzu's emails off in Ponzu, in Settings › Notifications.",
  },
  link: null,
  problem: true,
};

async function page(c: Context<AppEnv>, handoff: Handoff, status: 200 | 400) {
  const { html, csp } = await renderHandoff(handoff);
  return c.html(html, status, { ...PAGE_HEADERS, "content-security-policy": csp });
}

/** Whether the POST came from the page's button rather than a mail app. */
async function fromPage(c: Context<AppEnv>): Promise<boolean> {
  const type = c.req.header("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return false;
  const body = new URLSearchParams(await c.req.text());
  return body.get("via") === "page";
}

export const email = new Hono<AppEnv>()
  .get("/unsubscribe", access.public, async (c) => {
    const token = c.req.query("t");
    const opened = await openUnsubscribeToken(c.var.deps.vault, token);
    if (!opened) return page(c, BROKEN, 400);
    return page(c, asking(opened.category, token!), 200);
  })
  .post("/unsubscribe", access.public, async (c) => {
    const { deps, log } = c.var;
    const via = (await fromPage(c)) ? "page" : "one_click";
    const opened = await openUnsubscribeToken(deps.vault, c.req.query("t"));
    if (!opened) {
      if (via === "page") return page(c, BROKEN, 400);
      throw new ApiError(400, "invalid_request", "This unsubscribe link is not one Ponzu made.");
    }
    const { userId, category } = opened;
    let found = true;
    try {
      await setPingPrefs(deps.db, { userId, prefs: { [UNSUBSCRIBE_PREF[category]]: false } });
    } catch (error) {
      // An account deleted since the email went has no email to stop.
      if (!(error instanceof Error && error.message.startsWith("There is no user"))) throw error;
      found = false;
    }
    log.info("email_unsubscribed", { userId, kind: category, via });
    if (found) {
      deps.analytics.capture("email unsubscribed", { kind: category, via }, { distinctId: userId });
    }
    return via === "page" ? page(c, done(category), 200) : c.body(null, 204);
  });
