import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SLICE, SLICE_STROKE } from "@ponzu/canvas/slice";
import { readRedirect, SignInError, startSignIn } from "@ponzu/client";

/*
 * Signing in with GitHub, the Mac's half (docs/cloud.md, "Identity and access"): PKCE through
 * WorkOS in the system browser, which comes back to a listener on this computer only
 * (`http://127.0.0.1:<random port>/auth/callback`, registered with WorkOS for any port). The
 * code and verifier go to the session, which trades them with the API.
 *
 * Any page the browser loads can send a request to the listener, so only the redirect carrying
 * this sign-in's state is answered; anything else gets a bare 404 and the wait goes on.
 */

const CALLBACK = "/auth/callback";
/** Long enough to sign in to GitHub from scratch, with two-factor. */
const GIVE_UP_MS = 10 * 60_000;

export interface SignIn {
  /** The code and verifier to finish with, once the browser comes back. */
  result: Promise<{ code: string; codeVerifier: string }>;
  /** Stop waiting: the listener closes and `result` rejects with `SignInError("cancelled")`. */
  cancel(): void;
}

export async function signInWithBrowser(opts: {
  workosClientId: string;
  openBrowser: (url: string) => Promise<void> | void;
  timeoutMs?: number;
}): Promise<SignIn> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const started = await startSignIn({
    workosClientId: opts.workosClientId,
    redirectUri: `http://127.0.0.1:${port}${CALLBACK}`,
  });

  let settle!: (outcome: { code: string } | SignInError) => void;
  const outcome = new Promise<{ code: string } | SignInError>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(
    () => settle(new SignInError("timeout", "Sign-in took too long. Try again.")),
    opts.timeoutMs ?? GIVE_UP_MS,
  );

  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== CALLBACK) return notFound(response);
    let code: string;
    try {
      code = readRedirect(url.search, started.state).code;
    } catch (error) {
      if (error instanceof SignInError && error.code === "state_mismatch") {
        return notFound(response);
      }
      page(response, DIDNT_FINISH);
      settle(error instanceof SignInError ? error : new SignInError("failed", String(error)));
      return;
    }
    page(response, SIGNED_IN);
    settle({ code });
  });

  try {
    await opts.openBrowser(started.url);
  } catch (error) {
    clearTimeout(timer);
    server.close();
    throw error;
  }

  const result = outcome.then((settled) => {
    clearTimeout(timer);
    // Let the page reach the browser before the listener goes.
    setTimeout(() => server.close(), 1000).unref();
    if (settled instanceof SignInError) throw settled;
    return { code: settled.code, codeVerifier: started.codeVerifier };
  });
  return {
    result,
    cancel: () => settle(new SignInError("cancelled", "Sign-in was cancelled.")),
  };
}

function notFound(response: ServerResponse) {
  response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
  response.end("Not found");
}

const SIGNED_IN = {
  title: "You're signed in",
  body: "You can close this tab and go back to Ponzu.",
};
const DIDNT_FINISH = {
  title: "Sign-in didn't finish",
  body: "You can close this tab and try again in Ponzu.",
};

/** The page the browser lands on: no script, nothing loaded, the slice and two lines. */
function page(response: ServerResponse, { title, body }: { title: string; body: string }) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "referrer-policy": "no-referrer",
  });
  response.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Ponzu</title>
<style>
  :root { color-scheme: light dark; --ink: #111110; --muted: #5e5b54; --ground: #f4f3ef; }
  @media (prefers-color-scheme: dark) { :root { --ink: #f4f3ef; --muted: #a9a59b; --ground: #121211; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--ground);
    color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
  main { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 24px; }
  svg { color: var(--ink); }
  h1 { margin: 36px 0 0; font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
  p { margin: 12px 0 0; color: var(--muted); }
</style>
<main>
  <svg width="56" height="56" viewBox="0 0 64 64" aria-hidden="true"><g fill="currentColor" stroke="currentColor" stroke-width="${SLICE_STROKE}" stroke-linejoin="round">${SLICE.map((d) => `<path d="${d}"/>`).join("")}</g></svg>
  <h1>${title}</h1>
  <p>${body}</p>
</main>
</html>
`);
}
