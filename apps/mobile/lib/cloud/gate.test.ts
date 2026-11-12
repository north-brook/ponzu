import { expect, test } from "bun:test";
import type { SessionState } from "@ponzu/client";
import { areaOf, gateMove, gateRoute, signInNotice } from "./gate";

const user = {
  id: "usr_1",
  githubLogin: "maya",
  name: "Maya",
  email: "maya@example.com",
  avatarUrl: null,
};
const STATES: Record<SessionState["status"], SessionState> = {
  loading: { status: "loading" },
  signed_out: { status: "signed_out" },
  signed_in: { status: "signed_in", user },
  github_reauth: { status: "github_reauth" },
  too_old: { status: "too_old", minimumVersion: "1.0.0" },
};

test("each state of the session has its screen; loading keeps the launch screen", () => {
  expect(gateRoute(STATES.loading)).toBeNull();
  expect(gateRoute(STATES.signed_out)).toBe("/sign-in");
  expect(gateRoute(STATES.github_reauth)).toBe("/sign-in");
  expect(gateRoute(STATES.too_old)).toBe("/update");
  expect(gateRoute(STATES.signed_in)).toBe("/canvases");
});

test("sign-in says why only when GitHub needs granting again", () => {
  expect(signInNotice(STATES.github_reauth)).toBe("Sign in again so Ponzu can reach GitHub.");
  expect(signInNotice(STATES.signed_out)).toBeNull();
});

test("every screen sits behind a gate, but those that move on by themselves", () => {
  expect(areaOf([])).toBeNull();
  expect(areaOf(["auth", "callback"])).toBeNull();
  expect(areaOf(["dev"])).toBeNull();
  expect(areaOf(["+not-found"])).toBeNull();
  expect(areaOf(["sign-in"])).toBe("/sign-in");
  expect(areaOf(["update"])).toBe("/update");
  expect(areaOf(["(tabs)", "(canvases)", "canvases"])).toBe("/canvases");
  expect(areaOf(["settings"])).toBe("/canvases");
  expect(areaOf(["canvas", "[id]"])).toBe("/canvases");
});

test("the app moves when the session leaves the screen's gate, and only then", () => {
  const tabs = ["(tabs)", "(canvases)", "canvases"];
  // Signed out elsewhere, or here from settings.
  expect(gateMove(STATES.signed_out, tabs)).toBe("/sign-in");
  expect(gateMove(STATES.signed_out, ["settings"])).toBe("/sign-in");
  // A 426 on any screen.
  expect(gateMove(STATES.too_old, tabs)).toBe("/update");
  expect(gateMove(STATES.too_old, ["sign-in"])).toBe("/update");
  // Signing in.
  expect(gateMove(STATES.signed_in, ["sign-in"])).toBe("/canvases");
  // Staying put.
  expect(gateMove(STATES.signed_in, tabs)).toBeNull();
  expect(gateMove(STATES.signed_out, ["sign-in"])).toBeNull();
  expect(gateMove(STATES.github_reauth, ["sign-in"])).toBeNull();
  expect(gateMove(STATES.loading, tabs)).toBeNull();
  // The launch screen makes its own first move.
  expect(gateMove(STATES.signed_in, [])).toBeNull();
});
