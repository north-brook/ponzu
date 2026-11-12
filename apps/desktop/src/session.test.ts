import { expect, test } from "bun:test";
import { configFor } from "./config.ts";
import { mainSession } from "./session.ts";
import { built } from "./testing.ts";
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
function harness(
  browser: (authorize: URL) => Promise<void>,
  opts: {
    attemptMs?: number;
    exchangeMs?: number;
    exchange?: "down";
    /** Codes whose exchange the API never answers. */
    hang?: string[];
    /** How long the API takes to answer an exchange. */
    delayMs?: number;
  } = {},
) {
  const exchanges: unknown[] = [];
  const storage = memoryStorage();
  let focused = 0;
  const main = mainSession({
    config: configFor(false, { PONZU_API_URL: "https://api.test" }, built()),
    version: "2.0.0",
    storage,
    persistence: () => "memory",
    openBrowser: (url) => browser(new URL(url)),
    focus: () => {
      focused++;
    },
    ...(opts.attemptMs ? { attemptMs: opts.attemptMs } : {}),
    ...(opts.exchangeMs ? { exchangeMs: opts.exchangeMs } : {}),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url === "https://api.test/v1/auth/exchange") {
        const body = (await request.json()) as { code: string };
        exchanges.push({ body, client: request.headers.get("x-ponzu-client") });
        if (opts.hang?.includes(body.code)) {
          await new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          });
        }
        if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
        if (opts.exchange === "down") {
          return Response.json(
            { error: { code: "unavailable", message: "Ponzu is down for a moment." } },
            { status: 503 },
          );
        }
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
    code: "access_denied",
  });
  expect(exchanges).toHaveLength(0);
  expect(main.session.getState().status).toBe("signed_out");
});

/** A browser that keeps every tab it was sent to, for the test to bring back when it likes. */
function tabs() {
  const opened: URL[] = [];
  return {
    open: async (authorize: URL) => {
      opened.push(authorize);
    },
    opened,
    /** The tab coming back from GitHub with `code`: the page it lands on, or null if refused. */
    async back(i: number, code: string): Promise<string | null> {
      const authorize = opened[i]!;
      const redirect = authorize.searchParams.get("redirect_uri")!;
      const state = authorize.searchParams.get("state")!;
      const page = await fetch(`${redirect}?code=${code}&state=${state}`).catch(() => null);
      return page ? page.text() : null;
    },
    async listening(i: number): Promise<boolean> {
      const redirect = new URL(opened[i]!.searchParams.get("redirect_uri")!);
      return (await fetch(`${redirect.origin}/`).catch(() => null)) !== null;
    },
  };
}

const until = async (done: () => boolean) => {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 5));
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a sign-in outlives the window coming forward: its tab finishes it minutes later", async () => {
  const browser = tabs();
  const { main, focused, exchanges } = harness(browser.open);
  const signingIn = main.signIn();
  await until(() => browser.opened.length === 1);
  // The person is back in Ponzu, and away again, while GitHub asks for a two-factor code: the
  // studio once cancelled the sign-in 1.5 s after the window took focus. Nothing does now.
  await wait(1_700);
  expect(await browser.listening(0)).toBe(true);
  expect(await browser.back(0, "code_1")).toContain("You're signed in");
  expect(await signingIn).toEqual({ ok: true });
  expect(exchanges).toHaveLength(1);
  expect(focused()).toBe(1);
});

test("a second press starts another attempt beside the first; the first tab back wins", async () => {
  const browser = tabs();
  const { main, exchanges } = harness(browser.open);
  const first = main.signIn();
  await until(() => browser.opened.length === 1);
  const second = main.signIn();
  await until(() => browser.opened.length === 2);
  // Each its own listener, state and verifier.
  const at = (i: number) => new URL(browser.opened[i]!.searchParams.get("redirect_uri")!).port;
  expect(at(0)).not.toBe(at(1));
  expect(browser.opened[0]!.searchParams.get("state")).not.toBe(
    browser.opened[1]!.searchParams.get("state"),
  );

  // The older tab, where the person finished signing in to GitHub, comes back first.
  expect(await browser.back(0, "code_old")).toContain("You're signed in");
  expect(await first).toEqual({ ok: true });
  expect(main.session.getState()).toEqual({ status: "signed_in", user });
  // The other attempt ends quietly, its listener closed: a late tab finds nothing.
  expect(await second).toEqual({ ok: false, reason: "closed" });
  expect(await browser.listening(1)).toBe(false);
  expect(await browser.back(1, "code_new")).toBeNull();
  expect((exchanges as { body: { code: string } }[]).map((e) => e.body.code)).toEqual(["code_old"]);
});

test("at most three attempts listen: a fourth press closes the oldest", async () => {
  const browser = tabs();
  const { main } = harness(browser.open);
  const results = [main.signIn()];
  for (let n = 2; n <= 4; n++) {
    await until(() => browser.opened.length === n - 1);
    results.push(main.signIn());
  }
  await until(() => browser.opened.length === 4);
  expect(await results[0]).toEqual({ ok: false, reason: "closed" });
  expect(await browser.listening(0)).toBe(false);
  for (const i of [1, 2, 3]) expect(await browser.listening(i)).toBe(true);
  // Quitting closes the rest.
  main.closeSignIns();
  for (const i of [1, 2, 3]) expect(await results[i]).toEqual({ ok: false, reason: "closed" });
  for (const i of [1, 2, 3]) expect(await browser.listening(i)).toBe(false);
});

test("an attempt nobody comes back to ends with its window, quietly", async () => {
  const browser = tabs();
  const { main } = harness(browser.open, { attemptMs: 30 });
  expect(await main.signIn()).toEqual({ ok: false, reason: "closed" });
  expect(await browser.listening(0)).toBe(false);
});

test("an exchange the API turns down says so on the page and in the app", async () => {
  const browser = tabs();
  const { main, focused } = harness(browser.open, { exchange: "down" });
  const signingIn = main.signIn();
  await until(() => browser.opened.length === 1);
  const page = await browser.back(0, "code_1");
  expect(page).toContain("Sign-in didn't finish");
  expect(page).not.toContain("You're signed in");
  const result = await signingIn;
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toBe("failed");
  expect(main.session.getState().status).toBe("signed_out");
  expect(focused()).toBe(1);
});

test("an exchange that stalls is given up: its page says so, and the next tab still signs in", async () => {
  const browser = tabs();
  const { main, exchanges, focused } = harness(browser.open, {
    hang: ["code_stuck"],
    exchangeMs: 150,
  });
  const first = main.signIn();
  await until(() => browser.opened.length === 1);
  const second = main.signIn();
  await until(() => browser.opened.length === 2);
  const stuckPage = browser.back(0, "code_stuck");
  await until(() => exchanges.length === 1);
  // The second tab comes back while the first exchange hangs: it waits, but not for minutes.
  const page = await browser.back(1, "code_2");
  expect(page).toContain("You're signed in");
  expect(await stuckPage).toContain("Ponzu couldn't be reached.");
  expect(await stuckPage).not.toContain("You're signed in");
  expect(await second).toEqual({ ok: true });
  const firstResult = await first;
  expect(firstResult.ok === false && firstResult.reason).toBe("failed");
  expect(main.session.getState()).toEqual({ status: "signed_in", user });
  expect((exchanges as { body: { code: string } }[]).map((e) => e.body.code)).toEqual([
    "code_stuck",
    "code_2",
  ]);
  expect(focused()).toBe(2);
});

test("two tabs back at once: one exchange, and Ponzu comes forward once", async () => {
  const browser = tabs();
  const { main, exchanges, focused } = harness(browser.open, { delayMs: 100 });
  const first = main.signIn();
  await until(() => browser.opened.length === 1);
  const second = main.signIn();
  await until(() => browser.opened.length === 2);
  const pages = await Promise.all([browser.back(0, "code_1"), browser.back(1, "code_2")]);
  for (const page of pages) expect(page).toContain("You're signed in");
  expect(await first).toEqual({ ok: true });
  expect(await second).toEqual({ ok: true });
  expect(exchanges).toHaveLength(1);
  expect(focused()).toBe(1);
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
