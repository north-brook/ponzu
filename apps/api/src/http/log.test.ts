import { describe, expect, test } from "bun:test";
import { getGithubUserToken } from "@ponzu/db";
import { githubUserToken } from "../github/user-token.ts";
import { createTestApp, TEST_VAULT_KEY } from "../testing/index.ts";
import { createLogger, type LogLine, redact } from "./log.ts";

describe("redact", () => {
  test("a field whose name says it is a secret loses its value, at any depth", () => {
    const line = redact({
      event: "x",
      code: "code_01ABC",
      access_token: "abc",
      refreshToken: "def",
      Authorization: "Bearer xyz",
      nested: { client_secret: "sk", code_verifier: "v", list: [{ apiKey: "k", password: "p" }] },
      headers: { cookie: "session=1" },
      credential: { any: "thing" },
      PONZU_VAULT_KEY: "k",
    });
    expect(line).toEqual({
      event: "x",
      code: "[redacted]",
      access_token: "[redacted]",
      refreshToken: "[redacted]",
      Authorization: "[redacted]",
      nested: {
        client_secret: "[redacted]",
        code_verifier: "[redacted]",
        list: [{ apiKey: "[redacted]", password: "[redacted]" }],
      },
      headers: { cookie: "[redacted]" },
      credential: "[redacted]",
      PONZU_VAULT_KEY: "[redacted]",
    });
  });

  test("what is safe is left alone", () => {
    const line = {
      level: "info",
      event: "request",
      requestId: "req_1",
      path: "/v1/me",
      status: 200,
      ms: 12,
      userId: "usr_7k2m9x4q0c8v5n1t",
      errorCode: "token_expired",
      at: null,
    };
    expect(redact(line)).toEqual(line);
  });

  test("a secret inside other text is cut out of it", () => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${"a".repeat(40)}.${"b".repeat(40)}`;
    const cases: [string, string][] = [
      [`verify failed for ${jwt}`, "verify failed for [redacted]"],
      ["token ghu_16C7e42F292c6912E7710c838347Ae178B4a rejected", "token [redacted] rejected"],
      [
        "ghr_1B4a2e77838347a7E420ce178F2E7c6912E169246c34E1ccbF66C46812d16D5B1A9Dc86A1498",
        "[redacted]",
      ],
      ["ghs_16C7e42F292c6912E7710c838347Ae178B4a", "[redacted]"],
      ["key sk_test_a1B2c3D4e5F6 is wrong", "key [redacted] is wrong"],
      [`runner pzr_${"0a".repeat(26)} unknown`, "runner [redacted] unknown"],
      ["stored pzv1.ab12cd34.AAAA.BBBB-CCCC_DDDD", "stored [redacted]"],
      ["authorization: Bearer abc.def-ghi", "authorization: [redacted]"],
      [
        "postgres://neondb_owner:npg_s3cr3t@ep-x.us-east-1.aws.neon.tech/neondb",
        "postgres://neondb_owner:[redacted]@ep-x.us-east-1.aws.neon.tech/neondb",
      ],
      ["GET /callback?token=abc123&state=1", "GET /callback?token=[redacted]&state=1"],
      [
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY----- trailing",
        "[redacted] trailing",
      ],
    ];
    for (const [text, expected] of cases) expect(redact(text)).toBe(expected);
  });

  test("an error keeps its name and stack, with secrets cut from its message and its cause", () => {
    const cause = new Error("upstream said ghu_16C7e42F292c6912E7710c838347Ae178B4a");
    const logged = redact({ error: new Error("exchange failed: Bearer abc", { cause }) }) as any;
    expect(logged.error.name).toBe("Error");
    expect(logged.error.message).toBe("exchange failed: [redacted]");
    expect(logged.error.stack).toContain("log.test.ts");
    expect(logged.error.stack).not.toContain("Bearer abc");
    expect(logged.error.cause.message).toBe("upstream said [redacted]");
  });

  test("an object that contains itself does not hang the log", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(JSON.stringify(redact(loop))).toContain("[too deep]");
  });

  test("the logger redacts every line it writes, bound fields included", () => {
    const lines: LogLine[] = [];
    const log = createLogger((line) => lines.push(line)).with({ requestId: "req_1", token: "t" });
    log.warn("refused", { detail: "Bearer abc" });
    expect(lines).toEqual([
      {
        level: "warn",
        event: "refused",
        requestId: "req_1",
        token: "[redacted]",
        detail: "[redacted]",
      },
    ]);
  });
});

test("a whole sign-in, its failures and a token refresh log none of the secrets involved", async () => {
  const t = await createTestApp();
  const secrets = new Set<string>([
    t.workos.apiKey,
    t.github.credentials.clientSecret,
    TEST_VAULT_KEY,
  ]);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    t.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  // A sign-in that works, through the email verification path.
  const started = await t.startSignIn({ login: "maya", emailVerifiedAtWorkos: false });
  const response = await post("/v1/auth/exchange", {
    code: started.code,
    code_verifier: started.codeVerifier,
  });
  const session = (await response.json()) as {
    user: { id: string };
    access_token: string;
    refresh_token: string;
  };
  for (const secret of [
    started.code,
    started.codeVerifier,
    session.access_token,
    session.refresh_token,
  ]) {
    secrets.add(secret);
  }
  const stored = (await getGithubUserToken(t.db, session.user.id))!;
  const open = (sealed: string, column: string) =>
    t.deps.vault.open(sealed, { column: `github_user_tokens.${column}`, row: session.user.id });
  secrets.add(await open(stored.encryptedAccessToken, "access_token"));
  secrets.add(await open(stored.encryptedRefreshToken!, "refresh_token"));

  // Sign-ins that fail at every stage.
  const wrongVerifier = await t.startSignIn({ login: "ines" });
  secrets.add(wrongVerifier.code);
  await post("/v1/auth/exchange", { code: wrongVerifier.code, code_verifier: "w".repeat(43) });
  await post("/v1/auth/exchange", {
    code: "code_that_was_never_issued",
    code_verifier: "v".repeat(43),
  });
  secrets.add("code_that_was_never_issued");
  const unverified = await t.startSignIn({
    login: "sam",
    emailVerifiedAtWorkos: false,
    emailVerifiedAtGithub: false,
  });
  await post("/v1/auth/exchange", {
    code: unverified.code,
    code_verifier: unverified.codeVerifier,
  });
  const outage = await t.startSignIn({ login: "kit" });
  t.workos.failNext("/user_management/authenticate", 500, {
    message: `echoing ${outage.code} and ${t.workos.apiKey} back`,
  });
  await post("/v1/auth/exchange", { code: outage.code, code_verifier: outage.codeVerifier });
  secrets.add(outage.code);
  secrets.add(unverified.code);

  // Requests with good, bad and missing tokens; a sign-out; a refresh of the GitHub token.
  const forged = await t.workos.signAccessToken(
    { userId: started.workos.id, sessionId: "s" },
    { signedWith: "other-key" },
  );
  secrets.add(forged);
  await t.app.request("/v1/me", { headers: { authorization: `Bearer ${session.access_token}` } });
  await t.app.request(`/v1/me?access_token=${session.access_token}`, {
    headers: { authorization: `Bearer ${forged}` },
  });
  await t.app.request("/v1/me", {
    headers: { authorization: "Bearer pzr_0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjk" },
  });
  t.clock.advance(8 * 3600_000);
  secrets.add(await githubUserToken(t.deps, session.user.id));
  const rotated = (await getGithubUserToken(t.db, session.user.id))!;
  secrets.add(await open(rotated.encryptedRefreshToken!, "refresh_token"));
  await post("/v1/auth/sign-out", {}, { authorization: `Bearer ${session.access_token}` });

  const written = t.logs.map((line) => JSON.stringify(line)).join("\n");
  expect(t.logs.length).toBeGreaterThan(10);
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(5);
    expect(written.includes(secret) ? `logged: ${secret}` : "clean").toBe("clean");
  }
  await t.close();
});
