import { expect, test } from "bun:test";
import { SignInError } from "@ponzu/client";
import { type SignIn, signInWithBrowser } from "./sign-in.ts";

/** A sign-in whose "browser" only hands back the URL it was sent to. */
async function start(timeoutMs?: number) {
  let opened = "";
  const signIn: SignIn = await signInWithBrowser({
    workosClientId: "client_test",
    openBrowser: (url) => {
      opened = url;
    },
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const authorize = new URL(opened);
  const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
  const state = authorize.searchParams.get("state")!;
  return { signIn, authorize, redirect, state };
}

test("goes to GitHub through WorkOS with PKCE, and back to this computer only", async () => {
  const { signIn, authorize, redirect } = await start();
  expect(authorize.origin + authorize.pathname).toBe(
    "https://api.workos.com/user_management/authorize",
  );
  expect(authorize.searchParams.get("provider")).toBe("GitHubOAuth");
  expect(authorize.searchParams.get("client_id")).toBe("client_test");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(redirect.hostname).toBe("127.0.0.1");
  expect(redirect.pathname).toBe("/auth/callback");
  expect(Number(redirect.port)).toBeGreaterThan(0);
  signIn.cancel();
  await signIn.result.catch(() => {});
});

test("the redirect with this sign-in's state finishes it, with a page to close", async () => {
  const { signIn, redirect, state } = await start();
  const page = await fetch(`${redirect.href}?code=code_1&state=${state}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  const html = await page.text();
  expect(html).toContain("You're signed in");
  expect(html).toContain("You can close this tab");
  expect(html).not.toContain("<script");
  const result = await signIn.result;
  expect(result.code).toBe("code_1");
  expect(result.codeVerifier.length).toBeGreaterThanOrEqual(43);
});

test("anything else that reaches the listener is dropped, and the wait goes on", async () => {
  const { signIn, redirect, state } = await start();
  const wrongState = await fetch(`${redirect.href}?code=evil&state=guessed`);
  expect(wrongState.status).toBe(404);
  expect(await wrongState.text()).toBe("Not found");
  const otherPath = await fetch(`${redirect.origin}/?code=evil&state=${state}`);
  expect(otherPath.status).toBe(404);
  const post = await fetch(`${redirect.href}?code=evil&state=${state}`, { method: "POST" });
  expect(post.status).toBe(404);

  await fetch(`${redirect.href}?code=real&state=${state}`);
  expect((await signIn.result).code).toBe("real");
});

test("a sign-in GitHub turned down ends with WorkOS's reason and an honest page", async () => {
  const { signIn, redirect, state } = await start();
  const outcome = signIn.result.catch((e: unknown) => e);
  const page = await fetch(`${redirect.href}?error=access_denied&state=${state}`);
  expect(await page.text()).toContain("Sign-in didn't finish");
  const error = await outcome;
  expect(error).toBeInstanceOf(SignInError);
  expect((error as SignInError).code).toBe("access_denied");
});

test("cancelling or waiting too long ends it, and closes the listener", async () => {
  const cancelled = await start();
  cancelled.signIn.cancel();
  expect(((await cancelled.signIn.result.catch((e) => e)) as SignInError).code).toBe("cancelled");

  const late = await start(20);
  expect(((await late.signIn.result.catch((e) => e)) as SignInError).code).toBe("timeout");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const closed = await fetch(`${late.redirect.href}?code=x&state=${late.state}`).catch(() => null);
  expect(closed).toBeNull();
});
