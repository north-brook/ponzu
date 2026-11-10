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

  test("a WorkOS user that already belongs to another GitHub account is identity_conflict", async () => {
    const owner = await t.signInAs({ login: "owner" });
    const intruder = await t.startSignIn({ login: "intruder" });
    // Act out WorkOS handing the intruder's GitHub identity the owner's WorkOS user.
    const code = await t.workos.authorize(owner.workos.id, {
      codeVerifier: intruder.codeVerifier,
      oauthTokens: t.github.issueTokens(intruder.github.id),
    });

    const response = await exchange({ code, code_verifier: intruder.codeVerifier });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("identity_conflict");
    expect((await getUserByWorkosId(t.db, owner.workos.id))!.githubUserId).toBe(owner.github.id);
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

  test("an address GitHub has not verified is email_not_verified: no person, no live session", async () => {
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
  });

  test("trying again does not get past it, though WorkOS now counts the email as verified", async () => {
    const who = { login: "persistent", emailVerifiedAtWorkos: false, emailVerifiedAtGithub: false };
    const first = await t.startSignIn(who);
    await exchange({ code: first.code, code_verifier: first.codeVerifier });
    expect(t.workos.user(first.workos.id).emailVerified).toBe(true);

    const second = await t.startSignIn(who);
    const response = await exchange({ code: second.code, code_verifier: second.codeVerifier });

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("email_not_verified");
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
  // Mallory's GitHub account lists maya's address, unverified. WorkOS keys its users by email,
  // so both of them arrive as the same WorkOS user; the API has finished WorkOS's email
  // verification for whoever asked, so WorkOS now takes that user's address as proven.
  async function mallory(workosUserId: string) {
    const account = await t.startSignIn({
      login: "mallory",
      email: "victim@example.com",
      emailVerifiedAtGithub: false,
    });
    const code = await t.workos.authorize(workosUserId, {
      codeVerifier: account.codeVerifier,
      oauthTokens: t.github.issueTokens(account.github.id),
    });
    return exchange({ code, code_verifier: account.codeVerifier });
  }

  test("is refused before the real owner arrives, and after, and holds no usable token", async () => {
    const shared = t.workos.addUser({ email: "victim@example.com", emailVerified: false });

    // First: the API completes the verification, then GitHub says the address is not hers.
    const first = await mallory(shared.id);
    expect([first.status, await errorCode(first)]).toEqual([403, "email_not_verified"]);
    expect(t.workos.user(shared.id).emailVerified).toBe(true);
    // Again, now that WorkOS no longer asks for verification.
    const second = await mallory(shared.id);
    expect([second.status, await errorCode(second)]).toEqual([403, "email_not_verified"]);

    // The owner signs in with her own GitHub account, where the address is verified.
    const victim = await t.startSignIn({ login: "victim", email: "victim@example.com" });
    const code = await t.workos.authorize(shared.id, {
      codeVerifier: victim.codeVerifier,
      oauthTokens: t.github.issueTokens(victim.github.id),
    });
    const admitted = await exchange({ code, code_verifier: victim.codeVerifier });
    expect(admitted.status).toBe(200);
    const owner = ((await admitted.json()) as any).user;
    expect(owner.githubLogin).toBe("victim");

    // Mallory through the exchange: the WorkOS user is taken, by another GitHub account.
    const third = await mallory(shared.id);
    expect([third.status, await errorCode(third)]).toEqual([409, "identity_conflict"]);
    // Mallory straight to WorkOS, which hands her a token for the shared user.
    const direct = await t.workos.signAccessToken({
      userId: shared.id,
      sessionId: "session_mallory",
    });
    const me = await t.app.request("/v1/me", { headers: { authorization: `Bearer ${direct}` } });
    expect([me.status, await errorCode(me)]).toEqual([401, "session_unknown"]);

    // And the owner's account is still hers alone.
    const row = await getUserByWorkosId(t.db, shared.id);
    expect(row).toMatchObject({ id: owner.id, githubUserId: victim.github.id });
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

  test("if WorkOS cannot be reached the session is left whole, to be signed out again", async () => {
    const person = await t.signInAs({ login: "retry" });
    t.workos.failNext("/user_management/sessions/revoke", 503);

    const failed = await t.app.request("/v1/auth/sign-out", {
      method: "POST",
      headers: person.headers,
    });
    expect(failed.status).toBe(502);

    const again = await t.app.request("/v1/auth/sign-out", {
      method: "POST",
      headers: person.headers,
    });
    expect(again.status).toBe(204);
  });

  test("needs a signed-in person", async () => {
    const response = await t.app.request("/v1/auth/sign-out", { method: "POST" });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthenticated");
  });
});
