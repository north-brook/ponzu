import { APP_NAMES, type Handoff, type HandoffView, renderHandoff } from "@ponzu/core/handoff";
import type { CardSetupScheme } from "./cards.ts";

/*
 * The page Stripe's Checkout and customer portal send the browser back to (`GET
 * /v1/billing/return`): a handoff (@ponzu/core/handoff), the same page GitHub's install ends on.
 * Where it hands the person back is the scheme the setup's row recorded when the app asked for
 * it, never anything in the address: a browser can bring anything there.
 *
 *   added      it opens `<scheme>://billing/card?setup=<id>&result=added` by itself
 *   cancelled  it opens `<scheme>://billing/card?setup=<id>&result=cancelled`
 *   `none`     a build that takes no links: it has been asking the API, so the page says Ponzu
 *              has it and closes as the app comes forward
 *   portal     no link (the portal carries nothing of ours): back to Ponzu, close the tab
 */

/** What the return page says. */
export type ReturnPage =
  | { kind: "added"; setupId: string; scheme: CardSetupScheme }
  | { kind: "cancelled"; setupId: string; scheme: CardSetupScheme }
  | { kind: "expired" }
  | { kind: "unreachable" }
  | { kind: "unknown" }
  | { kind: "portal" };

const CLOSE = "You can close this tab.";

interface Words {
  title: string;
  line: string;
  /** What comes next when the app's link went unanswered, if not `line`. */
  missed?: string;
  problem?: boolean;
}

function words(page: ReturnPage): Words {
  switch (page.kind) {
    case "added":
      return {
        title: "Card added",
        line: "Ponzu has it.",
        missed: "If Ponzu didn't open, it picks this up when you go back to it.",
      };
    case "cancelled":
      return { title: "No card added", line: "Go back to Ponzu to try again." };
    case "expired":
      return { title: "That took too long", line: "Go back to Ponzu to try again." };
    case "unreachable":
      return {
        title: "Ponzu couldn't reach Stripe",
        line: "If you added a card, Ponzu picks it up in a moment.",
        problem: true,
      };
    case "unknown":
      return { title: "Nothing to finish here", line: "Go back to Ponzu to try again." };
    case "portal":
      return { title: "Back to Ponzu", line: CLOSE };
  }
}

/** The handoff for a return, linking back only by what the setup's row recorded. */
export function returnHandoff(page: ReturnPage): Handoff {
  const said = words(page);
  const body = said.line === CLOSE ? CLOSE : `${said.line} ${CLOSE}`;
  const base = { documentTitle: said.title, problem: said.problem ?? false };
  const ending: HandoffView = { title: said.title, body };
  if (page.kind !== "added" && page.kind !== "cancelled") {
    return { ...base, view: ending, link: null };
  }
  if (page.scheme === "none") {
    // The app has been asking the API, and comes forward by itself.
    return { ...base, view: ending, link: null, closes: true };
  }
  const link = new URL(`${page.scheme}://billing/card`);
  link.searchParams.set("setup", page.setupId);
  link.searchParams.set("result", page.kind);
  const app = APP_NAMES[page.scheme];
  return {
    ...base,
    view: { title: said.title, body: `Opening ${app}…` },
    link: {
      href: link.toString(),
      app,
      opened: ending,
      missed: { title: said.title, body: said.missed ?? said.line },
    },
  };
}

/** The page and its content security policy. */
export function renderReturnPage(page: ReturnPage): Promise<{ html: string; csp: string }> {
  return renderHandoff(returnHandoff(page));
}
