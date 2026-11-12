import { type Api, ApiError } from "@ponzu/client";
import { parseLink } from "../links";
import type { AuthSessionResult } from "./sign-in";

/*
 * Installing Ponzu's GitHub App from the phone (docs/mobile.md, "Setup"): GitHub's install page
 * opens in the system's auth session, and the app hears how it ended two ways at once. The
 * API's setup page sends the browser on to `<scheme>://github/setup?result=…`, which the auth
 * session takes as its redirect; and the app asks the API how the install stands every two
 * seconds while the page is open (`GET /v1/github/installs/:id`), closing the sheet itself once
 * it has settled. Whichever comes first is the outcome; the other is not heard.
 */

/** How often an install waiting on GitHub is asked about, as the Mac asks. */
export const INSTALL_POLL_MS = 2_000;

export type InstallOutcome =
  | {
      /** As the setup page said: `installed`, `requested`, `pending`, `sign_in` or `failed`. */
      result: string;
      workspaceId?: string;
      via: "link" | "poll";
    }
  /** The sheet was closed before GitHub was done, or the page timed out. */
  | { result: "closed" };

export interface InstallDeps {
  github: Pick<Api["github"], "installLink" | "install">;
  /** The account to suggest on GitHub's page; none for "Don't see an organization?". */
  githubAccountId?: number;
  scheme: string;
  /** `WebBrowser.openAuthSessionAsync`. */
  openAuthSession(url: string, redirectUri: string): Promise<AuthSessionResult>;
  /** `WebBrowser.dismissAuthSession`: the poll heard the outcome before the page's link. */
  dismissAuthSession(): void;
  /** Resolves after `ms`; a test's clock moves it. */
  wait?(ms: number): Promise<void>;
  now?(): number;
}

export const setupRedirectFor = (scheme: string) => `${scheme}://github/setup`;

/** The outcome a `<scheme>://github/setup?…` link carries, or null for any other URL. */
export function linkOutcome(url: string, scheme: string): InstallOutcome | null {
  const route = parseLink(url, scheme);
  if (route?.screen !== "github-setup") return null;
  const { result, workspace } = route.params;
  return { result, ...(workspace ? { workspaceId: workspace } : {}), via: "link" };
}

/**
 * Opens GitHub's install page and answers how it ended. Rejects only when the page couldn't be
 * had (the API refused the install link).
 */
export async function runInstall(deps: InstallDeps): Promise<InstallOutcome> {
  // The wait between questions ends early once the sheet is gone, so no timer outlives it.
  let stopWaiting = () => {};
  const wait =
    deps.wait ??
    ((ms: number) =>
      new Promise<void>((done) => {
        const timer = setTimeout(done, ms);
        stopWaiting = () => {
          clearTimeout(timer);
          done();
        };
      }));
  const now = deps.now ?? Date.now;
  const { id, url, expiresAt } = await deps.github.installLink({
    client: "ios",
    ...(deps.githubAccountId ? { githubAccountId: deps.githubAccountId } : {}),
  });
  // An expiry the app can't read never stops the asking early: the sheet's closing does.
  const parsed = Date.parse(String(expiresAt));
  const until = Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  let heard: InstallOutcome | null = null;
  let open = true;

  const poll = async () => {
    while (open && now() < until) {
      await wait(INSTALL_POLL_MS);
      if (!open) return;
      let answer: Awaited<ReturnType<Api["github"]["install"]>>;
      try {
        answer = await deps.github.install(id);
      } catch (error) {
        // Not theirs or gone: nothing more to hear. Anything else is asked again.
        if (error instanceof ApiError && error.status === 404) return;
        continue;
      }
      if (!open) return;
      if (answer.status === "expired") return;
      if (answer.status === "settled") {
        heard = {
          result: answer.result,
          ...(answer.workspaceId ? { workspaceId: answer.workspaceId } : {}),
          via: "poll",
        };
        open = false;
        try {
          deps.dismissAuthSession();
        } catch {
          // The sheet stays until the person closes it; what was heard is still the outcome.
        }
        return;
      }
    }
  };

  // Not waited on once the sheet is gone: a question in flight then is not heard.
  void poll();
  let result: AuthSessionResult;
  try {
    result = await deps.openAuthSession(url, setupRedirectFor(deps.scheme));
  } finally {
    open = false;
    stopWaiting();
  }
  if (heard) return heard;
  const fromLink =
    result.type === "success" && "url" in result ? linkOutcome(result.url, deps.scheme) : null;
  return fromLink ?? { result: "closed" };
}

/*
 * The setup page's link can also reach the app outside the auth session (finished in Safari,
 * or the sheet already gone): app/github/setup.tsx takes it and tells whoever is listening, which
 * is "Where do you build?" when it is on screen.
 */
type Listener = (outcome: InstallOutcome) => void;
const listeners = new Set<Listener>();

export function onInstallOutcome(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells every listener; false when nobody was listening. */
export function announceInstall(outcome: InstallOutcome): boolean {
  for (const listener of [...listeners]) listener(outcome);
  return listeners.size > 0;
}
