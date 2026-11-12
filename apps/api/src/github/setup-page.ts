import { APP_NAMES, type Handoff, type HandoffView, renderHandoff } from "@ponzu/core/handoff";
import type { SetupPage } from "./install.ts";
import type { LinkTarget } from "./link-scheme.ts";

/*
 * The page a browser lands on after GitHub's install page: a handoff (@ponzu/core/handoff), the
 * same page the Mac app's sign-in ends on. It is the API's one HTML answer: one fixed script and
 * one fixed style sheet, allowed by their hashes; no request of its own, nothing from the query
 * string, and it can be framed by nobody.
 *
 * Where it hands the person back depends on what the install's state recorded of the app that
 * started it (link-scheme.ts):
 *
 *   a scheme   it opens the app's link by itself, closes once the app has taken it, and offers
 *              the link again if nothing took it:
 *                <scheme>://github/setup?result=installed&workspace=<workspace id>
 *                <scheme>://github/setup?result=requested | pending | sign_in | failed
 *              The app answers any of them by syncing (`POST /v1/github/sync`).
 *   `none`     a build that takes no links: it has asked the API for the outcome
 *              (`GET /v1/github/installs/:id`) and comes forward by itself, so the page says
 *              Ponzu has it and closes as the app takes the focus.
 *   not known  no state (installed from github.com, or from the installation's settings), or an
 *              app that didn't say: the page links nowhere, since a guess could open an app the
 *              person doesn't have. Ponzu catches up when it comes back to the front.
 */

/** The headers besides the content security policy, which comes with the page. */
export const SETUP_PAGE_HEADERS = {
  // The address it was opened at carries the install's state.
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export type { SetupPage };

const CLOSE = "You can close this tab.";

interface Words {
  title: string;
  /** What comes next, said when the app has it or the page can't reach it. */
  line: string;
  /** What comes next when the app's link went unanswered, if not `line`. */
  missed?: string;
  /** What comes next when no app can be named, if not `line`. */
  unknown?: string;
  problem?: boolean;
}

function words(page: SetupPage): Words {
  switch (page.kind) {
    case "installed":
      return {
        title: `Ponzu is set up on ${page.workspace.name}`,
        line: "Ponzu has it.",
        missed: "If Ponzu didn't open, it picks this up when you go back to it.",
        unknown: "Go back to Ponzu to carry on.",
      };
    case "requested":
      return {
        title: "Request sent",
        line: "Ponzu shows the organization once one of its owners approves.",
      };
    case "pending":
      return {
        title: "Almost there",
        line: "Ponzu picks up what you set up on GitHub by itself.",
      };
    case "sign_in":
      return {
        title: "Sign in to Ponzu again",
        line: "Your GitHub connection ran out. What you set up on GitHub is kept.",
      };
    case "failed":
      return {
        title: "Ponzu couldn't reach GitHub",
        line: "What you set up on GitHub is kept, and Ponzu catches up in a moment.",
        problem: true,
      };
  }
}

/** The handoff for an outcome, linking back by what the state recorded. */
export function setupHandoff(page: SetupPage, target: LinkTarget | null): Handoff {
  const said = words(page);
  const ending = (line: string): HandoffView => ({ title: said.title, body: `${line} ${CLOSE}` });
  const base = { documentTitle: said.title, problem: said.problem ?? false };
  if (target === null) {
    return { ...base, view: ending(said.unknown ?? said.line), link: null };
  }
  if (target === "none") {
    return { ...base, view: ending(said.line), link: null, closes: true };
  }
  const link = new URL(`${target}://github/setup`);
  link.searchParams.set("result", page.kind);
  if (page.kind === "installed") link.searchParams.set("workspace", page.workspace.id);
  const app = APP_NAMES[target];
  return {
    ...base,
    view: { title: said.title, body: `Opening ${app}…` },
    link: {
      href: link.toString(),
      app,
      opened: ending(said.line),
      missed: { title: said.title, body: said.missed ?? said.line },
    },
  };
}

/** The page and its content security policy. */
export function renderSetupPage(
  page: SetupPage,
  target: LinkTarget | null,
): Promise<{ html: string; csp: string }> {
  return renderHandoff(setupHandoff(page, target));
}
