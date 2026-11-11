import { expect, test } from "bun:test";
import { SignInError } from "@ponzu/client";
import { type Finished, type SignInAttempt, signInWithBrowser } from "./sign-in.ts";

/** An attempt whose "browser" only hands back the URL it was sent to. */
async function start(
  opts: {
    timeoutMs?: number;
    finish?: (redirect: { code: string; codeVerifier: string }) => Promise<Finished>;
  } = {},
) {
  let opened = "";
  const finished: { code: string; codeVerifier: string }[] = [];
  const attempt: SignInAttempt = await signInWithBrowser({
    workosClientId: "client_test",
    openBrowser: (url) => {
      opened = url;
    },
    finish:
      opts.finish ??
      (async (redirect) => {
        finished.push(redirect);
        return { ok: true };
      }),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const authorize = new URL(opened);
  const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
  const state = authorize.searchParams.get("state")!;
  return { attempt, authorize, redirect, state, finished };
}

/** Whether anything still listens at the redirect's port. */
async function listening(redirect: URL): Promise<boolean> {
  return (await fetch(`${redirect.origin}/`).catch(() => null)) !== null;
}

const gone = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("goes to GitHub through WorkOS with PKCE, and back to this computer only", async () => {
  const { attempt, authorize, redirect } = await start();
  expect(authorize.origin + authorize.pathname).toBe(
    "https://api.workos.com/user_management/authorize",
  );
  expect(authorize.searchParams.get("provider")).toBe("GitHubOAuth");
  expect(authorize.searchParams.get("client_id")).toBe("client_test");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(redirect.hostname).toBe("127.0.0.1");
  expect(redirect.pathname).toBe("/auth/callback");
  expect(Number(redirect.port)).toBeGreaterThan(0);
  attempt.close();
  expect(await attempt.ended).toEqual({ kind: "closed" });
});

test("the redirect with this attempt's state is finished, then the page says signed in", async () => {
  const { attempt, redirect, state, finished } = await start();
  const page = await fetch(`${redirect.href}?code=code_1&state=${state}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  const html = await page.text();
  expect(html).toContain("You're signed in");
  expect(html).toContain("You can close this tab");
  expect(html).not.toContain("<script");
  expect(await attempt.ended).toEqual({ kind: "signed_in" });
  expect(finished).toHaveLength(1);
  expect(finished[0]!.code).toBe("code_1");
  expect(finished[0]!.codeVerifier.length).toBeGreaterThanOrEqual(43);
});

test("the page waits for the exchange, and says it didn't finish when the exchange failed", async () => {
  let answer!: (finished: Finished) => void;
  const { attempt, redirect, state } = await start({
    finish: () => new Promise((resolve) => (answer = resolve)),
  });
  let landed = false;
  const page = fetch(`${redirect.href}?code=code_1&state=${state}`).then((response) => {
    landed = true;
    return response.text();
  });
  await gone(50);
  // Nothing says "signed in" while the API hasn't answered.
  expect(landed).toBe(false);
  answer({ ok: false, error: new Error("down"), why: "Ponzu couldn't be reached." });
  const html = await page;
  expect(html).toContain("Sign-in didn't finish");
  expect(html).toContain("Ponzu couldn't be reached.");
  expect(html).not.toContain("You're signed in");
  expect((await attempt.ended).kind).toBe("failed");
});

test("anything else that reaches the listener is dropped, and the wait goes on", async () => {
  const { attempt, redirect, state } = await start();
  const wrongState = await fetch(`${redirect.href}?code=evil&state=guessed`);
  expect(wrongState.status).toBe(404);
  expect(await wrongState.text()).toBe("Not found");
  const otherPath = await fetch(`${redirect.origin}/?code=evil&state=${state}`);
  expect(otherPath.status).toBe(404);
  const post = await fetch(`${redirect.href}?code=evil&state=${state}`, { method: "POST" });
  expect(post.status).toBe(404);

  await fetch(`${redirect.href}?code=real&state=${state}`);
  expect(await attempt.ended).toEqual({ kind: "signed_in" });
});

test("single use: a second redirect with the same state is dropped, then the listener goes", async () => {
  const { attempt, redirect, state, finished } = await start();
  await fetch(`${redirect.href}?code=first&state=${state}`);
  const again = await fetch(`${redirect.href}?code=second&state=${state}`).catch(() => null);
  expect(again === null || again.status === 404).toBe(true);
  await attempt.ended;
  expect(finished.map((f) => f.code)).toEqual(["first"]);
  await gone(1100);
  expect(await listening(redirect)).toBe(false);
});

test("a sign-in GitHub turned down ends with WorkOS's reason and an honest page", async () => {
  const { attempt, redirect, state, finished } = await start();
  const page = await fetch(`${redirect.href}?error=access_denied&state=${state}`);
  const html = await page.text();
  expect(html).toContain("Sign-in didn't finish");
  expect(html).toContain("GitHub didn't let Ponzu in.");
  const end = await attempt.ended;
  expect(end.kind).toBe("failed");
  const error = (end as { error: unknown }).error;
  expect(error).toBeInstanceOf(SignInError);
  expect((error as SignInError).code).toBe("access_denied");
  expect(finished).toHaveLength(0);
});

test("closing it, or its window running out, ends it and closes the listener at once", async () => {
  const closed = await start();
  closed.attempt.close();
  expect(await closed.attempt.ended).toEqual({ kind: "closed" });
  expect(await listening(closed.redirect)).toBe(false);

  const late = await start({ timeoutMs: 20 });
  expect(await late.attempt.ended).toEqual({ kind: "expired" });
  expect(await listening(late.redirect)).toBe(false);
});
