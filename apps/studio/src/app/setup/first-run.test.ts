import { describe, expect, test } from "bun:test";
import { ApiError } from "@ponzu/client";
import { createFakeBackend, FakeClock } from "@ponzu/client/testing";
import { setupStep } from "../../cloud/setup/setup.ts";
import { afterInput, afterRefusal } from "./claude-connect.ts";
import { setupFacts } from "./facts.ts";

/*
 * The guided first run against Ponzu Cloud in memory: what the gates say at each point, read
 * from the API's answers as the window reads them, for a new person, a returning one and a
 * second device; and what the Claude card says to each answer a sign-in or a key can get.
 */

function world() {
  const clock = new FakeClock();
  const backend = createFakeBackend({ clock });
  const maya = backend.addPerson({ login: "maya" });
  const own = backend.addWorkspace({
    login: "maya",
    kind: "personal",
    members: { [maya.id]: "admin" },
    installed: false,
  });
  return { clock, backend, maya, own };
}

const stepOf = async (api: ReturnType<ReturnType<typeof world>["backend"]["connect"]>["api"]) =>
  setupStep(setupFacts(await api.me()));

describe("the gates, on the API's answers", () => {
  test("a new person goes through every step, each cleared only by its own action", async () => {
    const { backend, maya, own } = world();
    const { api } = backend.connect(maya);

    expect(await stepOf(api)).toBe("where");
    const { accounts } = await api.github.accounts();
    expect(accounts.map((a) => [a.kind, a.status])).toEqual([["personal", "not_installed"]]);

    // Set up: GitHub's install page, and the sync on the way back turns the row Ready.
    await api.github.installLink({ client: "mac", githubAccountId: own.githubAccountId });
    const synced = await api.github.sync();
    expect(synced.accounts.map((a) => [a.status, a.workspaceId])).toEqual([["ready", own.id]]);
    // Ready is not enough: Continue confirms the step.
    expect(await stepOf(api)).toBe("where");
    await api.onboarding("where");
    expect(await stepOf(api)).toBe("claude");

    const signIn = await api.claude.startSignIn();
    await api.claude.sendCode(signIn.id, "k7Hq2#state");
    expect(await stepOf(api)).toBe("iphone");
    await api.onboarding("iphone");
    expect(await stepOf(api)).toBe("done");
  });

  test("a returning person lands on the app, even with their Claude since disconnected", async () => {
    const { backend, maya, own } = world();
    backend.install(own.id);
    backend.finishStep(maya.id, "where");
    backend.claude.connect(maya.id);
    backend.finishStep(maya.id, "iphone");
    const { api } = backend.connect(maya);
    expect(await stepOf(api)).toBe("done");

    await api.claude.disconnect();
    const me = await api.me();
    expect(me.claudeAccount).toBeNull();
    // A send asks for Claude again; setup doesn't.
    expect(setupFacts(me).claude).toEqual({ status: "revoked" });
    expect(await stepOf(api)).toBe("done");
  });

  test("a second device skips what the first did, and the step left is the next one", async () => {
    const { backend, maya, own } = world();
    backend.install(own.id);
    const first = backend.connect(maya).api;
    await first.onboarding("where");
    const second = backend.connect(maya).api;
    expect(await stepOf(second)).toBe("claude");

    // Claude connected on the first: the second moves on by itself, once it asks again.
    await first.claude.connectApiKey("sk-ant-api03-0123456789abcdefghij");
    expect(await stepOf(second)).toBe("iphone");
  });

  test("losing the only workspace to a suspension sends the person back to where they design", async () => {
    const { backend, maya, own } = world();
    backend.install(own.id);
    backend.finishStep(maya.id, "where");
    backend.claude.connect(maya.id);
    backend.finishStep(maya.id, "iphone");
    const { api } = backend.connect(maya);
    backend.suspend(own.id);
    expect(await stepOf(api)).toBe("where");
    expect((await api.github.accounts()).accounts[0]?.suspended).toBe(true);
  });
});

describe("the Claude card, after each answer", () => {
  const code = (text: string) => ({
    mode: "subscription" as const,
    code: text,
    status: "connecting" as const,
  });
  const key = { mode: "api_key" as const, key: "sk-ant-api03-x", status: "connecting" as const };

  test("each refusal of a code, from the API in memory, says what it is", async () => {
    const { backend, maya, clock } = world();
    const { api } = backend.connect(maya);
    backend.claude.acceptsCode = (pasted) => !pasted.startsWith("wrong");
    const refusal = (pasted: string, signInId: string) =>
      api.claude.sendCode(signInId, pasted).then(
        () => null,
        (error: unknown) => afterRefusal(code(pasted), error),
      );

    const first = await api.claude.startSignIn();
    // Only half the code: nothing is spent, and it can be pasted again.
    expect(await refusal("k7Hq2", first.id)).toMatchObject({ status: "incomplete" });
    // Turned away by claude.ai: the sign-in is spent.
    expect(await refusal("wrong#state", first.id)).toMatchObject({ status: "wrong" });
    expect(await refusal("k7Hq2#state", first.id)).toMatchObject({ status: "used" });

    const second = await api.claude.startSignIn();
    await clock.advance(10 * 60_000);
    expect(await refusal("k7Hq2#state", second.id)).toEqual({
      mode: "subscription",
      code: "",
      status: "expired",
    });
  });

  test("a key Anthropic turns away is rejected; no answer at all is said as such", async () => {
    const { backend, maya } = world();
    const { api } = backend.connect(maya);
    backend.claude.acceptsKey = () => false;
    const refused = await api.claude.connectApiKey("sk-ant-api03-x").catch((e: unknown) => e);
    expect(afterRefusal(key, refused)).toMatchObject({ status: "rejected" });
    expect(afterRefusal(key, new ApiError(0, "network", "Offline."))).toMatchObject({
      status: "failed",
    });
    expect(
      afterRefusal(code("k7#s"), new ApiError(502, "upstream_unavailable", "No.")),
    ).toMatchObject({ status: "failed" });
  });

  test("typing clears what typing can fix, and nothing a new sign-in must", () => {
    expect(afterInput({ ...code("k7"), status: "incomplete" }, "k7#s").status).toBe("idle");
    expect(afterInput({ ...code("wrong#s"), status: "wrong" }, "k7#s").status).toBe("wrong");
    expect(afterInput({ ...key, status: "rejected" }, " sk-ant-\nnew ")).toEqual({
      mode: "api_key",
      key: "sk-ant-new",
      status: "idle",
    });
  });
});
