// A real sign-in from a terminal, the way the Mac app does it: the authorization-code flow
// with PKCE in the system browser, a redirect to a loopback address this script listens on,
// and the exchange through the API. It saves the session so end-to-end tests can act as a
// real signed-in person.
//
//   WORKOS_CLIENT_ID=… PONZU_SESSION_FILE=~/.ponzu-dev-session.json bun run dev:signin
//
//   WORKOS_CLIENT_ID     the WorkOS environment's client id (public; the app ships it)
//   PONZU_SESSION_FILE   where to save { api, user, access_token, refresh_token, saved_at };
//                        written readable by its owner only
//   PONZU_API_URL        the API to exchange with (default dev's, https://api-dev.ponzu.design)
//
// It prints the URL to open and one line when it is done. Tokens and the code are never
// printed. The access token lasts five minutes; whoever uses the file refreshes with WorkOS
// (grant_type=refresh_token, client_id, no secret) and writes the rotated pair back.
import { chmodSync, writeFileSync } from "node:fs";

const WORKOS = "https://api.workos.com/user_management";
const WAIT_MS = 10 * 60_000;

const clientId = process.env.WORKOS_CLIENT_ID;
const sessionFile = process.env.PONZU_SESSION_FILE;
const api = (process.env.PONZU_API_URL ?? "https://api-dev.ponzu.design").replace(/\/+$/, "");
if (!clientId || !sessionFile) {
  console.error("Set WORKOS_CLIENT_ID and PONZU_SESSION_FILE. See the top of this file.");
  process.exit(2);
}

const random = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
const codeVerifier = random(32);
const state = random(16);
const challenge = Buffer.from(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
).toString("base64url");

const page = (text: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Ponzu</title><body style="font:16px system-ui;padding:48px">${text}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const callback = Promise.withResolvers<URL>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 });
    // Anything can open a loopback URL. Only the redirect this sign-in started carries its state.
    if (url.searchParams.get("state") !== state) {
      return page("This is not the sign-in that was started. Go back to the terminal.");
    }
    callback.resolve(url);
    return page("Signed in. You can close this tab and go back to the terminal.");
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const authorize = new URL(`${WORKOS}/authorize`);
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  provider: "GitHubOAuth",
  redirect_uri: `http://127.0.0.1:${server.port}/auth/callback`,
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();
console.log(`Open this to sign in:\n${authorize}`);

const timer = setTimeout(() => fail("Nobody signed in within ten minutes."), WAIT_MS);
const returned = await callback.promise;
clearTimeout(timer);
// Give the browser its page before the listener goes.
setTimeout(() => server.stop(), 500);

const refusal = returned.searchParams.get("error");
if (refusal) fail(`The sign-in was refused: ${refusal}`);
const code = returned.searchParams.get("code") ?? fail("The redirect carried no code.");

const response = await fetch(`${api}/v1/auth/exchange`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-ponzu-client": "devsignin/0.1.0" },
  body: JSON.stringify({ code, code_verifier: codeVerifier }),
});
const body = (await response.json().catch(() => ({}))) as Record<string, any>;
if (response.status !== 200) {
  const requestId = response.headers.get("x-request-id") ?? "none";
  fail(
    `The exchange at ${api} failed: ${response.status} ${body.error?.code ?? "unknown"} (request ${requestId}).`,
  );
}

const session = {
  api,
  user: body.user,
  access_token: body.access_token,
  refresh_token: body.refresh_token,
  saved_at: new Date().toISOString(),
};
writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
// `mode` only applies to a file this call created.
chmodSync(sessionFile, 0o600);
console.log(`Signed in as ${body.user?.githubLogin}. Session saved to ${sessionFile}.`);
process.exit(0);
