import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getGithubUserToken, getUserByWorkosId } from "@ponzu/db";
import { decodeJwt } from "jose";
import { createTestApp, type TestApp } from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const exchange = (body: unknown, headers: Record<string, string> = {}) =>
  t.app.request("/v1/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

/** Sessions WorkOS made that are still live. */
const liveSessions = () => [...t.workos.sessions.values()].filter((session) => !session.revoked);

describe("POST /v1/auth/exchange", () => {
  test("trades the code for a session, makes the person and stores their GitHub token sealed", async () => {
    const started = await t.startSignIn({ login: "maya", name: "Maya Okafor" });

    const response = await exchange(
      { code: started.code, code_verifier: started.codeVerifier },
      { "x-real-ip": "203.0.113.9", "user-agent": "Ponzu/2.0.0 (Macintosh)" },
    );

    expect(response.status).toBe(200);
    const session = (await response.json()) as Record<string, any>;
    expect(Object.keys(session).sort()).toEqual(["access_token", "refresh_token", "user"]);
    expect(session.user).toEqual({
      id: expect.stringMatching(/^usr_/),
      githubLogin: "maya",
      name: "Maya Okafor",
      email: "maya@example.com",
      avatarUrl: "https://avatars.example/maya",
    });
    // The access token is WorkOS's, for the same person, and works as a bearer.
    expect(decodeJwt(session.access_token).sub).toBe(started.workos.id);
    const me = await t.app.request("/v1/me", {
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    expect(me.status).toBe(200);

    // WorkOS was told who was signing in.
    expect(t.workos.lastCaller).toEqual({
      ipAddress: "203.0.113.9",
      userAgent: "Ponzu/2.0.0 (Macintosh)",
    });

    const user = await getUserByWorkosId(t.db, started.workos.id);
    expect(user).toMatchObject({ id: session.user.id, githubUserId: started.github.id });
    const stored = (await getGithubUserToken(t.db, user!.id))!;
    // Eight hours ahead: WorkOS sends the expiry in milliseconds, and it is read as that.
    expect(stored.accessTokenExpiresAt!.getTime()).toBe(t.clock.now() + 8 * 3600_000);
    expect(stored.encryptedAccessToken).toStartWith("pzv1.");
    expect(stored.encryptedRefreshToken).toStartWith("pzv1.");
    const githubToken = await t.deps.vault.open(stored.encryptedAccessToken, {
      column: "github_user_tokens.access_token",
      row: user!.id,
    });
    expect(t.github.accepts(githubToken)).toBe(true);
    // The GitHub token never leaves the API.
    expect(JSON.stringify(session)).not.toContain(githubToken);
    expect(JSON.stringify(session)).not.toContain("ghr_");
  });

  test("signing in again is the same person with a new session and the newer GitHub token", async () => {
    const first = await t.signInAs({ login: "ines" });
    const before = (await getGithubUserToken(t.db, first.userId))!;

    const second = await t.signInAs({ login: "ines" });

    expect(second.userId).toBe(first.userId);
    expect(second.accessToken).not.toBe(first.accessToken);
    const after = (await getGithubUserToken(t.db, first.userId))!;
    expect(after.encryptedAccessToken).not.toBe(before.encryptedAccessToken);
  });

  test("a code that was already used is invalid_code", async () => {
    const started = await t.startSignIn({ login: "used" });
    const body = { code: started.code, code_verifier: started.codeVerifier };
    expect((await exchange(body)).status).toBe(200);

    const again = await exchange(body);

    expect(again.status).toBe(400);
    expect(await errorCode(again)).toBe("invalid_code");
  });

  test("a code nobody issued is invalid_code_verifier, which is all WorkOS says about one", async () => {
    const response = await exchange({ code: "code_made_up", code_verifier: "v".repeat(43) });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_code_verifier");
  });

  test("the wrong verifier is invalid_code_verifier, and the right one still works after", async () => {
    const started = await t.startSignIn({ login: "pkce" });

    const wrong = await exchange({ code: started.code, code_verifier: "w".repeat(43) });
    expect(wrong.status).toBe(400);
    expect(await errorCode(wrong)).toBe("invalid_code_verifier");
    expect(await getUserByWorkosId(t.db, started.workos.id)).toBeNull();

    const right = await exchange({ code: started.code, code_verifier: started.codeVerifier });
    expect(right.status).toBe(200);
  });

  test("a body without a code or a real verifier is refused before WorkOS hears of it", async () => {
    for (const body of [
      {},
      { code: "code_1" },
      { code: "", code_verifier: "v".repeat(43) },
      { code: "code_1", code_verifier: "too-short" },
      { code: "code_1", code_verifier: "has spaces ".repeat(5) },
    ]) {
      const response = await exchange(body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_request");
    }
    t.workos.lastCaller = null;
    await exchange({ code: 5, code_verifier: null });
    expect(t.workos.lastCaller).toBeNull();
  });

  test("without GitHub's tokens the sign-in fails whole: no person, no live session", async () => {
    const started = await t.startSignIn({ login: "tokenless", returnsGithubTokens: false });
    const live = liveSessions().length;

    const response = await exchange({ code: started.code, code_verifier: started.codeVerifier });

    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("github_token_missing");
    expect(await getUserByWorkosId(t.db, started.workos.id)).toBeNull();
    expect(liveSessions()).toHaveLength(live);
  });

  test("WorkOS failing is upstream_unavailable, and says nothing of what WorkOS said", async () => {
    const started = await t.startSignIn({ login: "outage" });
    t.workos.failNext("/user_management/authenticate", 500, {
      message: "pg: connection refused at 10.0.0.7",
    });

    const response = await exchange({ code: started.code, code_verifier: started.codeVerifier });

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("upstream_unavailable");
    expect(text).not.toContain("10.0.0.7");
  });

  test("a step Ponzu has no screen for is sign_in_not_supported", async () => {
    const started = await t.startSignIn({ login: "mfa" });
    t.workos.failNext("/user_management/authenticate", 403, {
      code: "mfa_enrollment",
      message: "The user must enroll in MFA to finish authenticating.",
      pending_authentication_token: "pending_secret_token",
    });

    const response = await exchange({ code: started.code, code_verifier: started.codeVerifier });

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("sign_in_not_supported");
  });

  test("GitHub failing after WorkOS made a session ends that session", async () => {
    const started = await t.startSignIn({ login: "ghdown" });
    const live = liveSessions().length;
    t.github.failNext("/user");

    const response = await exchange({ code: started.code, code_verifier: started.codeVerifier });

    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("upstream_unavailable");
    expect(liveSessions()).toHaveLength(live);
    expect(await getUserByWorkosId(t.db, started.workos.id)).toBeNull();
  });

  test("a second GitHub account that has verified the same address is identity_conflict", async () => {
    const owner = await t.signInAs({ login: "owner" });
    // The owner's other GitHub account, where the address has since been verified, arriving
    // as the same WorkOS user: WorkOS keys its users by email.
    const second = await t.startSignIn({ login: "owner-two", email: "owner@example.com" });
    const code = await t.workos.authorize(owner.workos.id, {
      codeVerifier: second.codeVerifier,
      oauthTokens: t.github.issueTokens(second.github.id),
    });

    const response = await exchange({ code, code_verifier: second.codeVerifier });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("identity_conflict");
    expect((await getUserByWorkosId(t.db, owner.workos.id))!.githubUserId).toBe(owner.github.id);
  });

  test("a sign-in that was not through GitHub is sign_in_not_supported, and no outage of ours", async () => {
    // WorkOS's hosted page offers a password too, and anyone can post the code it gives.
    const started = await t.startSignIn({ login: "password" });
    const live = liveSessions().length;
    const code = await t.workos.authorize(started.workos.id, {
      codeVerifier: started.codeVerifier,
      oauthTokens: null,
      authenticationMethod: "Password",
    });

    const response = await exchange({ code, code_verifier: started.codeVerifier });

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("sign_in_not_supported");
    expect(liveSessions()).toHaveLength(live);
    expect(await getUserByWorkosId(t.db, started.workos.id)).toBeNull();
    expect(t.logs.findLast((line) => line.event === "sign_in_not_supported")).toMatchObject({
      level: "warn",
      reason: "authentication_method_password",
    });
    // Logged as a refusal, not at error level as a failure of the API's.
    const requestId = response.headers.get("x-request-id");
    expect(
      t.logs.filter((line) => line.requestId === requestId).map((line) => line.level),
    ).not.toContain("error");
  });
});

describe("email verification, finished by the API", () => {
  test("a first sign-in WorkOS stops for verification goes through without anyone typing a code", async () => {
    const started = await t.startSignIn({ login: "newcomer", emailVerifiedAtWorkos: false });

    const response = await exchange({ code: started.code, code_verifier: started.codeVerifier });

    expect(response.status).toBe(200);
    const session = (await response.json()) as Record<string, any>;
    expect(session.user).toMatchObject({ githubLogin: "newcomer", email: "newcomer@example.com" });
    expect(t.workos.user(started.workos.id).emailVerified).toBe(true);
    // The GitHub token came back on the second leg, and was stored.
    expect(await getGithubUserToken(t.db, session.user.id)).not.toBeNull();
  });

  test("an address GitHub has not verified is email_not_verified, and WorkOS is left believing nothing", async () => {
    const started = await t.startSignIn({
      login: "unverified",
      emailVerifiedAtWorkos: false,
      emailVerifiedAtGithub: false,
    });
    const live = liveSessions().length;

    const response = await exchange({ code: started.code, code_verifier: started.codeVerifier });

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("email_not_verified");
    expect(await getUserByWorkosId(t.db, started.workos.id)).toBeNull();
    expect(liveSessions()).toHaveLength(live);
    // The API verified the address for WorkOS to get this far. It takes that back: the WorkOS
    // user, with its verified flag and the GitHub identity attached to it, is gone.
    expect(t.workos.hasUser(started.workos.id)).toBe(false);
  });

  test("trying again does not get past it", async () => {
    const who = { login: "persistent", emailVerifiedAtWorkos: false, emailVerifiedAtGithub: false };
    const first = await t.startSignIn(who);
    await exchange({ code: first.code, code_verifier: first.codeVerifier });

    const second = await t.startSignIn(who);
    const response = await exchange({ code: second.code, code_verifier: second.codeVerifier });

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("email_not_verified");
    expect(t.workos.hasUser(second.workos.id)).toBe(false);
  });

  test("if WorkOS cannot be told to forget, the sign-in still fails, and stays refused after", async () => {
    const who = { login: "sticky", emailVerifiedAtWorkos: false, emailVerifiedAtGithub: false };
    const first = await t.startSignIn(who);
    t.workos.failNext(`/user_management/users/${first.workos.id}`, 503);

    const refused = await exchange({ code: first.code, code_verifier: first.codeVerifier });

    expect([refused.status, await errorCode(refused)]).toEqual([403, "email_not_verified"]);
    expect(
      t.logs.findLast((line) => line.event === "email_verification_not_withdrawn"),
    ).toMatchObject({
      level: "error",
      workosUserId: first.workos.id,
    });
    // WorkOS now counts the address as verified and no longer stops the sign-in. GitHub is
    // still asked, because nobody has been let in as this WorkOS user.
    expect(t.workos.user(first.workos.id).emailVerified).toBe(true);
    const second = await t.startSignIn(who);
    const again = await exchange({ code: second.code, code_verifier: second.codeVerifier });
    expect([again.status, await errorCode(again)]).toEqual([403, "email_not_verified"]);
  });

  test("a sign-in that fails for another reason after the API vouched takes the vouching back too", async () => {
    const started = await t.startSignIn({ login: "ghdown-new", emailVerifiedAtWorkos: false });
    t.github.failNext("/user");

    const response = await exchange({ code: started.code, code_verifier: started.codeVerifier });

    expect([response.status, await errorCode(response)]).toEqual([502, "upstream_unavailable"]);
    expect(t.workos.hasUser(started.workos.id)).toBe(false);
    // Nothing is lost by it: the next attempt is a first sign-in again, and goes through.
    const again = await t.startSignIn({ login: "ghdown-new", emailVerifiedAtWorkos: false });
    expect((await exchange({ code: again.code, code_verifier: again.codeVerifier })).status).toBe(
      200,
    );
  });

  test("once they verify the address on GitHub, the next sign-in works", async () => {
    const who = { login: "latecomer", emailVerifiedAtWorkos: false, emailVerifiedAtGithub: false };
    const first = await t.startSignIn(who);
    await exchange({ code: first.code, code_verifier: first.codeVerifier });
    first.github.emails[0]!.verified = true;

    const second = await t.startSignIn(who);
    const response = await exchange({ code: second.code, code_verifier: second.codeVerifier });

    expect(response.status).toBe(200);
  });

  test("an address verified on GitHub that is not the one WorkOS holds does not count", async () => {
    const started = await t.startSignIn({ login: "mismatch", emailVerifiedAtWorkos: false });
    started.github.emails[0]!.email = "someone-else@example.com";

    const response = await exchange({ code: started.code, code_verifier: started.codeVerifier });

    expect(await errorCode(response)).toBe("email_not_verified");
  });

  test("a person already let in is not checked again, whatever became of their GitHub emails", async () => {
    const person = await t.signInAs({ login: "regular" });
    person.github.emails.length = 0;

    const again = await t.startSignIn({ login: "regular" });
    const response = await exchange({ code: again.code, code_verifier: again.codeVerifier });

    expect(response.status).toBe(200);
  });

  test("if the second leg carries no GitHub tokens the sign-in fails as github_token_missing", async () => {
    const started = await t.startSignIn({
      login: "legless",
      emailVerifiedAtWorkos: false,
      returnsGithubTokens: false,
    });

    const response = await exchange({ code: started.code, code_verifier: started.codeVerifier });

    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("github_token_missing");
  });
});

describe("someone signing in under an address that is not theirs", () => {
  // Mallory's GitHub account lists the victim's address, unverified. WorkOS keys its users by
  // email, so she arrives as whichever WorkOS user holds that address. `attachesIdentity` is
  // WorkOS stopping to verify the address before it joins her GitHub identity to that user.
  async function mallory(workosUserId: string, { attachesIdentity = false } = {}) {
    const account = await t.startSignIn({
      login: "mallory",
      email: "victim@example.com",
      emailVerifiedAtGithub: false,
    });
    const code = await t.workos.authorize(workosUserId, {
      codeVerifier: account.codeVerifier,
      oauthTokens: t.github.issueTokens(account.github.id),
      attachesIdentity,
    });
    return exchange({ code, code_verifier: account.codeVerifier });
  }
  const answer = async (response: Response) => [response.status, await response.json()];

  test("before the owner has an account, she is refused and WorkOS is left with nothing of hers", async () => {
    const early = t.workos.addUser({ email: "victim@example.com", emailVerified: false });

    // The API completes the verification, then GitHub says the address is not hers.
    const refused = await mallory(early.id);

    expect([refused.status, await errorCode(refused)]).toEqual([403, "email_not_verified"]);
    // No verified address, and no identity of hers, waits at WorkOS for the owner to walk into.
    expect(t.workos.hasUser(early.id)).toBe(false);
  });

  test("once the owner has an account, nobody can tell, and the API vouches for no one", async () => {
    const victim = await t.signInAs({ login: "victim", emailVerifiedAtWorkos: false });
    const nobody = t.workos.addUser({ email: "nobody@example.com", emailVerified: false });
    const made = t.workos.sessions.size;

    // WorkOS wants the address verified before it attaches her identity to the owner's user.
    const taken = await answer(await mallory(victim.workos.id, { attachesIdentity: true }));
    // The same attempt on an address nobody at Ponzu has.
    const free = await answer(await mallory(nobody.id));

    expect(taken).toEqual(free);
    expect(taken[0]).toBe(403);
    expect((taken[1] as any).error.code).toBe("email_not_verified");
    // For the owner's user the verification was never finished: only the other attempt got as
    // far as a session, so WorkOS attached nothing to her.
    expect(t.workos.sessions.size).toBe(made + 1);
    expect(t.workos.hasUser(victim.workos.id)).toBe(true);
    expect(t.logs.findLast((line) => line.event === "email_verification_refused")).toMatchObject({
      level: "warn",
      workosUserId: victim.workos.id,
    });
  });

  test("if WorkOS has joined her to the owner's user anyway, she is still refused, the same way", async () => {
    const victim = await t.signInAs({ login: "joined", email: "joined@example.com" });
    const account = await t.startSignIn({
      login: "mallory-joined",
      email: "joined@example.com",
      emailVerifiedAtGithub: false,
    });
    const viaExchange = async () => {
      const code = await t.workos.authorize(victim.workos.id, {
        codeVerifier: account.codeVerifier,
        oauthTokens: t.github.issueTokens(account.github.id),
      });
      return exchange({ code, code_verifier: account.codeVerifier });
    };

    // Through the exchange: GitHub is asked, because this is not the GitHub account the WorkOS
    // user belongs to. The answer is the one a stranger to Ponzu would get.
    const refused = await viaExchange();
    expect([refused.status, await errorCode(refused)]).toEqual([403, "email_not_verified"]);

    // Straight to WorkOS, which hands her a well-signed token for the owner's user.
    const direct = await t.workos.signAccessToken({
      userId: victim.workos.id,
      sessionId: "session_mallory",
    });
    const me = await t.app.request("/v1/me", { headers: { authorization: `Bearer ${direct}` } });
    expect([me.status, await errorCode(me)]).toEqual([401, "session_unknown"]);

    // And the owner's account is still hers alone, and still works.
    const row = await getUserByWorkosId(t.db, victim.workos.id);
    expect(row).toMatchObject({ id: victim.userId, githubUserId: victim.github.id });
    expect((await t.app.request("/v1/me", { headers: victim.headers })).status).toBe(200);
  });

  test("a person whose WorkOS address changes is checked against GitHub again", async () => {
    const person = await t.signInAs({ login: "mover" });
    t.workos.user(person.workos.id).email = "new-address@example.com";

    const unverified = await t.startSignIn({ login: "mover" });
    const refused = await exchange({
      code: unverified.code,
      code_verifier: unverified.codeVerifier,
    });
    expect([refused.status, await errorCode(refused)]).toEqual([403, "email_not_verified"]);

    person.github.emails.push({ email: "new-address@example.com", primary: false, verified: true });
    const verified = await t.startSignIn({ login: "mover" });
    const admitted = await exchange({ code: verified.code, code_verifier: verified.codeVerifier });
    expect(((await admitted.json()) as any).user.email).toBe("new-address@example.com");
  });
});

describe("POST /v1/auth/sign-out", () => {
  test("revokes the session the token belongs to, and only that one", async () => {
    const phone = await t.signInAs({ login: "twodevices" });
    const mac = await t.signInAs({ login: "twodevices" });
    const sid = (token: string) => decodeJwt(token).sid as string;

    const response = await t.app.request("/v1/auth/sign-out", {
      method: "POST",
      headers: mac.headers,
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(t.workos.sessions.get(sid(mac.accessToken))!.revoked).toBe(true);
    expect(t.workos.sessions.get(sid(phone.accessToken))!.revoked).toBe(false);
    // The Mac's token has minutes left and is refused all the same; the phone carries on.
    const after = async (headers: { authorization: string }) => {
      const me = await t.app.request("/v1/me", { headers });
      return me.status === 200 ? 200 : [me.status, await errorCode(me)];
    };
    expect(await after(mac.headers)).toEqual([401, "session_unknown"]);
    expect(await after(phone.headers)).toBe(200);
  });

  test("if WorkOS cannot be reached the person is signed out all the same", async () => {
    const person = await t.signInAs({ login: "retry" });
    t.workos.failNext("/user_management/sessions/revoke", 503);

    const response = await t.app.request("/v1/auth/sign-out", {
      method: "POST",
      headers: person.headers,
    });

    expect(response.status).toBe(204);
    // The session WorkOS still holds buys nothing here: the API has forgotten it.
    expect(t.workos.sessions.get(decodeJwt(person.accessToken).sid as string)!.revoked).toBe(false);
    const me = await t.app.request("/v1/me", { headers: person.headers });
    expect([me.status, await errorCode(me)]).toEqual([401, "session_unknown"]);
    expect(t.logs.findLast((line) => line.event === "session_revoke_failed")).toMatchObject({
      level: "warn",
    });
  });

  test("needs a signed-in person", async () => {
    const response = await t.app.request("/v1/auth/sign-out", { method: "POST" });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthenticated");
  });
});
