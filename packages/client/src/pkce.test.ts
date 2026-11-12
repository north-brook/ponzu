import { describe, expect, test } from "bun:test";
import { readRedirect, SignInError, startSignIn } from "./pkce.ts";

const redirectUri = "ponzu-dev://auth/callback";
const queryOf = (url: string) => new URL(url).searchParams;

describe("startSignIn", () => {
  test("goes to WorkOS's authorize page with GitHub and a S256 challenge by default", async () => {
    const started = await startSignIn({ workosClientId: "client_123", redirectUri });
    expect(started.url.startsWith("https://api.workos.com/user_management/authorize?")).toBe(true);
    const query = queryOf(started.url);
    expect(Object.fromEntries(query)).toEqual({
      response_type: "code",
      client_id: "client_123",
      provider: "GitHubOAuth",
      redirect_uri: redirectUri,
      state: started.state,
      code_challenge: expect.any(String),
      code_challenge_method: "S256",
    });
    // The challenge is the verifier's SHA-256, base64url without padding.
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(started.codeVerifier)),
    );
    expect(query.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
    expect(started.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("an authorizeUrl replaces only where the browser goes, with the same query", async () => {
    const fake = "http://127.0.0.1:8099/fake/authorize";
    const started = await startSignIn({
      workosClientId: "client_123",
      redirectUri,
      authorizeUrl: fake,
    });
    expect(started.url.startsWith(`${fake}?`)).toBe(true);
    const query = queryOf(started.url);
    expect(query.get("redirect_uri")).toBe(redirectUri);
    expect(query.get("state")).toBe(started.state);
    expect(query.get("code_challenge_method")).toBe("S256");
  });

  test("an authorizeUrl that has a query of its own keeps it", async () => {
    const started = await startSignIn({
      workosClientId: "client_123",
      redirectUri,
      authorizeUrl: "http://127.0.0.1:8099/fake/authorize?as=maya",
    });
    const query = queryOf(started.url);
    expect(query.get("as")).toBe("maya");
    expect(query.get("client_id")).toBe("client_123");
    expect(started.url.split("?")).toHaveLength(2);
  });

  test("takes its randomness and digest from the crypto it is given", async () => {
    const calls: number[] = [];
    const started = await startSignIn({
      workosClientId: "client_123",
      redirectUri,
      crypto: {
        getRandomValues: (bytes) => {
          calls.push(bytes.length);
          return bytes.fill(7);
        },
        subtle: { digest: async () => new Uint8Array(32).buffer },
      },
    });
    expect(calls).toEqual([32, 16]);
    expect(started.state).toBe(Buffer.from(new Uint8Array(16).fill(7)).toString("base64url"));
    expect(queryOf(started.url).get("code_challenge")).toBe("A".repeat(43));
  });
});

describe("readRedirect", () => {
  test("hands back the code from the fake page's redirect", async () => {
    const started = await startSignIn({
      workosClientId: "client_123",
      redirectUri,
      authorizeUrl: "http://127.0.0.1:8099/fake/authorize",
    });
    expect(readRedirect(`${redirectUri}?code=fake&state=${started.state}`, started.state)).toEqual({
      code: "fake",
    });
  });

  test("refuses another sign-in's state", () => {
    expect(() => readRedirect(`${redirectUri}?code=fake&state=other`, "mine")).toThrow(SignInError);
  });
});
