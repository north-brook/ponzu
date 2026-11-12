import { expect, test } from "bun:test";
import { keysToClear, SIGN_OUT_STEPS, type SignOutDeps, signOut } from "./sign-out";

function recorder(fails: string[] = [], deviceId: string | null = "dev_1") {
  const calls: string[] = [];
  const errors: string[] = [];
  const run = (name: string) => {
    calls.push(name);
    if (fails.includes(name)) throw new Error(`${name} failed`);
  };
  const deps: SignOutDeps = {
    readDeviceId: async () => deviceId,
    deleteDevice: async (id) => run(`device:${id}`),
    signOut: async () => run("session"),
    clearQueries: () => run("queries"),
    closeLive: () => run("live"),
    clearFiles: () => run("files"),
    resetAnalytics: () => run("analytics"),
    toSignIn: () => run("route"),
    onError: (step) => errors.push(step),
  };
  return { calls, errors, deps };
}

test("signing out goes in its order: device, session, cache, live, files, analytics, route", async () => {
  const { calls, deps } = recorder();
  await signOut(deps);
  expect(calls).toEqual([
    "device:dev_1",
    "session",
    "queries",
    "live",
    "files",
    "analytics",
    "route",
  ]);
  expect(SIGN_OUT_STEPS).toEqual([
    "device",
    "session",
    "queries",
    "live",
    "files",
    "analytics",
    "route",
  ]);
});

test("a step that fails doesn't stop the rest: the phone still ends signed out", async () => {
  const { calls, errors, deps } = recorder(["device:dev_1", "session", "files"]);
  await signOut(deps);
  expect(calls).toEqual([
    "device:dev_1",
    "session",
    "queries",
    "live",
    "files",
    "analytics",
    "route",
  ]);
  expect(errors).toEqual(["device", "session", "files"]);
});

test("with no device registered, nothing is asked of the API for it", async () => {
  const { calls, deps } = recorder([], null);
  await signOut(deps);
  expect(calls[0]).toBe("session");
});

test("every ponzu.* key goes but the ping ask's; other apps' keys stay", () => {
  expect(
    keysToClear([
      "ponzu.queries",
      "ponzu.workspace.usr_1",
      "ponzu.device",
      "ponzu.drafts.cnv_1",
      "ponzu.pingAsk",
      "posthog.distinctId",
      "expo.something",
    ]),
  ).toEqual(["ponzu.queries", "ponzu.workspace.usr_1", "ponzu.device", "ponzu.drafts.cnv_1"]);
});
