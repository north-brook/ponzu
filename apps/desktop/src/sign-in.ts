import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readRedirect, SignInError, startSignIn } from "@ponzu/client";
import { type Handoff, renderHandoff } from "@ponzu/core/handoff";

/*
 * Signing in with GitHub, the Mac's half (docs/cloud.md, "Identity and access"): PKCE through
 * WorkOS in the system browser, which comes back to a listener on this computer only
 * (`http://127.0.0.1:<random port>/auth/callback`, registered with WorkOS for any port). The
 * code and verifier go to `finish` (the session's exchange with the API), and the page the
 * browser lands on says how that went: it is written once the exchange has answered, never
 * before.
 *
 * Any page the browser loads can send a request to the listener, so only the first redirect
 * carrying this attempt's state is answered; anything else gets a bare 404 and the wait goes
 * on. Once answered, the listener closes.
 *
 * An attempt lives until its browser comes back, its window runs out, or the session closes it
 * (signed in by another attempt, too many attempts, Ponzu quitting). Nothing the app's window
 * does touches it.
 */

const CALLBACK = "/auth/callback";
/** Long enough to sign in to GitHub from scratch, with two-factor. */
export const ATTEMPT_MS = 10 * 60_000;
/** Time for the page to reach the browser before the listener goes. */
const LINGER_MS = 1000;

/** What the exchange made of the code the browser brought back. */
export type Finished = { ok: true } | { ok: false; error: unknown; why: string };

/** How an attempt ended. */
export type AttemptEnd =
  /** The browser came back and `finish` signed the person in. */
  | { kind: "signed_in" }
  /** The browser came back, and GitHub, WorkOS or the exchange turned it down. */
  | { kind: "failed"; error: unknown }
  /** Nobody came back within its window. */
  | { kind: "expired" }
  /** Closed before the browser came back. */
  | { kind: "closed" };

export interface SignInAttempt {
  /** Settles once, after the browser has been answered when it came back. */
  ended: Promise<AttemptEnd>;
  /** Stop listening, unless the browser has come back already (then it closes once answered). */
  close(): void;
}

export async function signInWithBrowser(opts: {
  workosClientId: string;
  openBrowser: (url: string) => Promise<void> | void;
  /** Trade the code and verifier for a session. Called at most once. */
  finish: (redirect: { code: string; codeVerifier: string }) => Promise<Finished>;
  timeoutMs?: number;
}): Promise<SignInAttempt> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const shut = () => {
    server.close();
    server.closeAllConnections();
  };

  let started: Awaited<ReturnType<typeof startSignIn>>;
  try {
    started = await startSignIn({
      workosClientId: opts.workosClientId,
      redirectUri: `http://127.0.0.1:${port}${CALLBACK}`,
    });
  } catch (error) {
    shut();
    throw error;
  }

  let used = false;
  let settle!: (end: AttemptEnd) => void;
  const ended = new Promise<AttemptEnd>((resolve) => {
    settle = resolve;
  });
  /** Before the browser came back: stop now, with `end`. */
  const stop = (end: AttemptEnd) => {
    if (used) return;
    used = true;
    clearTimeout(timer);
    shut();
    settle(end);
  };
  const timer = setTimeout(() => stop({ kind: "expired" }), opts.timeoutMs ?? ATTEMPT_MS);
  timer.unref?.();

  /** The browser was answered: let the page reach it, then close. */
  const answered = (end: AttemptEnd) => {
    clearTimeout(timer);
    setTimeout(shut, LINGER_MS).unref();
    settle(end);
  };

  server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (used || request.method !== "GET" || url.pathname !== CALLBACK) return notFound(response);
    let code: string;
    try {
      code = readRedirect(url.search, started.state).code;
    } catch (error) {
      if (error instanceof SignInError && error.code === "state_mismatch") {
        return notFound(response);
      }
      used = true;
      await page(response, didntFinish(turnedDown(error)));
      answered({ kind: "failed", error });
      return;
    }
    used = true;
    let finished: Finished;
    try {
      finished = await opts.finish({ code, codeVerifier: started.codeVerifier });
    } catch (error) {
      finished = { ok: false, error, why: "Ponzu couldn't finish signing you in." };
    }
    await page(response, finished.ok ? SIGNED_IN : didntFinish(finished.why));
    answered(finished.ok ? { kind: "signed_in" } : { kind: "failed", error: finished.error });
  });

  try {
    await opts.openBrowser(started.url);
  } catch (error) {
    stop({ kind: "closed" });
    throw error;
  }

  return { ended, close: () => stop({ kind: "closed" }) };
}

/** Why GitHub or WorkOS sent the browser back without a code, for the page. */
function turnedDown(error: unknown): string {
  if (error instanceof SignInError && error.code === "access_denied") {
    return "GitHub didn't let Ponzu in.";
  }
  return "GitHub sent you back without signing you in.";
}

function notFound(response: ServerResponse) {
  response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
  response.end("Not found");
}

/*
 * The page the browser lands on: a handoff (@ponzu/core/handoff), the same page the API's
 * GitHub setup ends on. There is no link to open: the session brings Ponzu forward itself once
 * the exchange has signed the person in, so the page says Ponzu has it and closes as the app
 * takes the focus. One that didn't finish stays, saying why.
 */
const SIGNED_IN: Handoff = {
  documentTitle: "You're signed in",
  view: { title: "You're signed in", body: "Ponzu has it. You can close this tab." },
  link: null,
  closes: true,
};
const didntFinish = (why: string): Handoff => ({
  documentTitle: "Sign-in didn't finish",
  view: {
    title: "Sign-in didn't finish",
    body: `${why} You can close this tab and try again in Ponzu.`,
  },
  link: null,
  problem: true,
});

/** Answer the browser with `handoff`, under its own content security policy and nothing more. */
async function page(response: ServerResponse, handoff: Handoff) {
  const { html, csp } = await renderHandoff(handoff);
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": csp,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(html);
}
