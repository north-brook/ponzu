import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SLICE, SLICE_STROKE } from "@ponzu/canvas/slice";
import { readRedirect, SignInError, startSignIn } from "@ponzu/client";

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
      page(response, didntFinish(turnedDown(error)));
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
    page(response, finished.ok ? SIGNED_IN : didntFinish(finished.why));
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

const SIGNED_IN = {
  title: "You're signed in",
  body: "You can close this tab and go back to Ponzu.",
};
const didntFinish = (why: string) => ({
  title: "Sign-in didn't finish",
  body: `${why} You can close this tab and try again in Ponzu.`,
});

/** For text between tags (the API's message can say anything): never inside an attribute. */
const escapeHtml = (text: string) =>
  text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** The page the browser lands on: no script, nothing loaded, the slice and two lines. */
function page(response: ServerResponse, { title, body }: { title: string; body: string }) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "referrer-policy": "no-referrer",
    connection: "close",
  });
  response.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Ponzu</title>
<style>
  :root { color-scheme: light dark; --ink: #111110; --muted: #5e5b54; --ground: #f4f3ef; }
  @media (prefers-color-scheme: dark) { :root { --ink: #f4f3ef; --muted: #a9a59b; --ground: #121211; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--ground);
    color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
  main { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 24px; }
  svg { color: var(--ink); }
  h1 { margin: 36px 0 0; font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
  p { margin: 12px 0 0; max-width: 420px; color: var(--muted); }
</style>
<main>
  <svg width="56" height="56" viewBox="0 0 64 64" aria-hidden="true"><g fill="currentColor" stroke="currentColor" stroke-width="${SLICE_STROKE}" stroke-linejoin="round">${SLICE.map((d) => `<path d="${d}"/>`).join("")}</g></svg>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(body)}</p>
</main>
</html>
`);
}
