import { expect, test } from "bun:test";
import { configFor } from "./config.ts";
import { mainSession } from "./session.ts";
import { memoryStorage } from "./token-store.ts";

const user = { id: "usr_1", githubLogin: "maya", name: "Maya", email: null, avatarUrl: null };

/** An unsigned WorkOS-shaped access token good for five minutes: the client reads only its times. */
function accessToken(n: number): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ sub: "user_1", iat: now, exp: now + 300, n })}.sig`;
}

/**
 * The main process's session with a browser that goes straight back to the loopback listener,
 * as WorkOS would after GitHub, and an API that answers the exchange.
 */
function harness(browser: (authorize: URL) => Promise<void>) {
  const exchanges: unknown[] = [];
  const storage = memoryStorage();
  let focused = 0;
  const main = mainSession({
    config: configFor(false, { PONZU_API_URL: "https://api.test" }),
    version: "2.0.0",
    storage,
    persistence: () => "memory",
    openBrowser: (url) => browser(new URL(url)),
    focus: () => {
      focused++;
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url === "https://api.test/v1/auth/exchange") {
        exchanges.push({
          body: await request.json(),
          client: request.headers.get("x-ponzu-client"),
        });
        return Response.json({ user, access_token: accessToken(1), refresh_token: "rt_1" });
      }
      return Response.json({ error: { code: "not_found", message: "No." } }, { status: 404 });
    },
  });
  return { main, storage, exchanges, focused: () => focused };
}

/** The browser coming back with `query` on the redirect WorkOS was given. */
const comeBack = (query: (state: string) => string) => async (authorize: URL) => {
  const redirect = authorize.searchParams.get("redirect_uri")!;
  const state = authorize.searchParams.get("state")!;
  // After the listener is up and the URL handed over, as a real browser would be.
  setTimeout(() => void fetch(`${redirect}?${query(state)}`), 0);
};

test("signs in through the browser, then lends access tokens and never the refresh token", async () => {
  const { main, storage, exchanges, focused } = harness(
    comeBack((state) => `code=code_1&state=${state}`),
  );
  expect(await main.signIn()).toEqual({ ok: true });
  expect(main.session.getState()).toEqual({ status: "signed_in", user });
  expect(focused()).toBe(1);
  expect(exchanges).toHaveLength(1);
  const [exchange] = exchanges as {
    body: { code: string; code_verifier: string };
    client: string;
  }[];
  expect(exchange!.body.code).toBe("code_1");
  expect(exchange!.body.code_verifier.length).toBeGreaterThanOrEqual(43);
  expect(exchange!.client).toMatch(/^(macos|windows|linux)\/2\.0\.0$/);
  // Stored before it is used, rotated pair and all.
  expect(await storage.get("ponzu.session")).toContain("rt_1");

  const lent = await main.accessToken();
  if (!("token" in lent)) throw new Error("No token lent.");
  const claims = JSON.parse(Buffer.from(lent.token.split(".")[1]!, "base64url").toString());
  expect(claims.n).toBe(1);
  expect(JSON.stringify(lent)).not.toContain("rt_1");
});

test("a sign-in GitHub turned down says so, and leaves the person signed out", async () => {
  const { main, exchanges } = harness(comeBack((state) => `error=access_denied&state=${state}`));
  expect(await main.signIn()).toEqual({
    ok: false,
    reason: "failed",
    message: "GitHub didn't let Ponzu in. Try again.",
  });
  expect(exchanges).toHaveLength(0);
  expect(main.session.getState().status).toBe("signed_out");
});

test("starting again, or cancelling, ends the sign-in that was waiting without a word", async () => {
  const { main } = harness(async () => {});
  const first = main.signIn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  main.cancelSignIn();
  expect(await first).toEqual({ ok: false, reason: "cancelled" });
});

test("without a session there is no token to lend, and the studio is told why", async () => {
  const { main } = harness(async () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await main.accessToken()).toEqual({
    error: { status: 401, code: "unauthenticated", message: "Sign in to do this." },
  });
});

test("an error the studio heard reaches the session: an ended session signs out here", async () => {
  const { main } = harness(comeBack((state) => `code=code_1&state=${state}`));
  await main.signIn();
  main.report({ status: 401, code: "session_unknown", message: "Signed out elsewhere." });
  expect(main.session.getState().status).toBe("signed_out");
});
