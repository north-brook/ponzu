import { describe, expect, test } from "bun:test";
import { fakeCloud } from "./backend.fake";
import { type AuthSessionResult, SIGN_IN_FAILED, signIn } from "./sign-in";

/** The fake's authorize page: it hands back `code=fake` with the sign-in's own state. */
const authorizePage =
  (code = "fake", stateOverride?: string) =>
  async (url: string, redirect: string): Promise<AuthSessionResult> => {
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    return {
      type: "success",
      url: `${redirect}?code=${code}&state=${stateOverride ?? query.get("state")}`,
    };
  };

const deps = (cloud: ReturnType<typeof fakeCloud>) => ({
  session: cloud.session,
  workosClientId: "client_test",
  scheme: "ponzu-dev",
  crypto: globalThis.crypto as never,
  authorizeUrl: "http://127.0.0.1:9/authorize",
});

describe("sign in", () => {
  test("through the auth session: the redirect's code signs in", async () => {
    const cloud = fakeCloud();
    let opened: { url: string; redirect: string } | null = null;
    const open = authorizePage();
    const outcome = await signIn({
      ...deps(cloud),
      openAuthSession: (url, redirect) => {
        opened = { url, redirect };
        return open(url, redirect);
      },
    });
    expect(outcome).toEqual({ kind: "signed_in" });
    expect(cloud.session.getState()).toMatchObject({ status: "signed_in" });
    expect(opened!.redirect).toBe("ponzu-dev://auth/callback");
    expect(opened!.url.startsWith("http://127.0.0.1:9/authorize?")).toBe(true);
    const query = new URLSearchParams(opened!.url.split("?")[1]);
    expect(query.get("redirect_uri")).toBe("ponzu-dev://auth/callback");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("provider")).toBe("GitHubOAuth");
  });

  test("closing the sheet is a cancel, with nothing said", async () => {
    const cloud = fakeCloud();
    for (const type of ["cancel", "dismiss", "locked"]) {
      expect(await signIn({ ...deps(cloud), openAuthSession: async () => ({ type }) })).toEqual({
        kind: "cancelled",
      });
    }
    expect(cloud.session.getState()).toEqual({ status: "signed_out" });
  });

  test("saying no on GitHub is a cancel too", async () => {
    const cloud = fakeCloud();
    const outcome = await signIn({
      ...deps(cloud),
      openAuthSession: async (url, redirect) => {
        const state = new URLSearchParams(url.split("?")[1]).get("state");
        return { type: "success", url: `${redirect}?error=access_denied&state=${state}` };
      },
    });
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  test("a redirect that isn't this sign-in's, or a code that doesn't work, fails in one line", async () => {
    const cloud = fakeCloud();
    expect(
      await signIn({ ...deps(cloud), openAuthSession: authorizePage("fake", "someone-else") }),
    ).toEqual({ kind: "failed", message: SIGN_IN_FAILED });
    expect(await signIn({ ...deps(cloud), openAuthSession: authorizePage("wrong") })).toEqual({
      kind: "failed",
      message: SIGN_IN_FAILED,
    });
    expect(cloud.session.getState()).toEqual({ status: "signed_out" });
  });

  test("a build with no client id says so, and opens nothing", async () => {
    const cloud = fakeCloud();
    let opened = false;
    const outcome = await signIn({
      ...deps(cloud),
      workosClientId: "",
      // WorkOS's page, which needs the client id.
      authorizeUrl: null,
      openAuthSession: async () => {
        opened = true;
        return { type: "cancel" };
      },
    });
    expect(outcome.kind).toBe("failed");
    expect(opened).toBe(false);
  });

  test("the fake with no authorize page skips the browser", async () => {
    const cloud = fakeCloud();
    const outcome = await signIn({
      ...deps(cloud),
      workosClientId: "",
      authorizeUrl: null,
      skipBrowser: { code: "fake" },
      openAuthSession: async () => {
        throw new Error("no browser");
      },
    });
    expect(outcome).toEqual({ kind: "signed_in" });
  });
});

describe("the fake cloud", () => {
  test("its scenarios set the session, and an unknown one does nothing", async () => {
    const cloud = fakeCloud();
    await cloud.prepare();
    expect(cloud.seed("too-old")).toBe(true);
    expect(cloud.session.getState()).toEqual({ status: "too_old", minimumVersion: "1.0.0" });
    expect(cloud.seed("github-reauth")).toBe(true);
    expect(cloud.session.getState()).toEqual({ status: "github_reauth" });
    expect(cloud.seed("nonsense")).toBe(false);
    expect(cloud.session.getState()).toEqual({ status: "github_reauth" });
  });

  test("signed in, Maya sees acme's three canvases; Sam, none", async () => {
    const cloud = fakeCloud();
    await cloud.prepare();
    cloud.seed("signed-in");
    const me = await cloud.api.me();
    expect(me.user.githubLogin).toBe("maya");
    const { canvases } = await cloud.api.workspaces.canvases(me.workspaces[0]!.id);
    expect(canvases.map((c) => c.name).sort()).toEqual([
      "Launch poster",
      "Onboarding",
      "Pricing page",
    ]);
    cloud.seed("empty");
    const sam = await cloud.api.me();
    expect(sam.user.githubLogin).toBe("sam");
    expect((await cloud.api.workspaces.canvases(sam.workspaces[0]!.id)).canvases).toEqual([]);
  });
});
