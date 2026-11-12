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
  expect(gateRoute(STATES.loading, null)).toBeNull();
  expect(gateRoute(STATES.signed_out, null)).toBe("/sign-in");
  expect(gateRoute(STATES.github_reauth, null)).toBe("/sign-in");
  expect(gateRoute(STATES.too_old, null)).toBe("/update");
  expect(gateRoute(STATES.signed_in, "done")).toBe("/canvases");
});

test("signed in, setup's steps come before the canvases; unknown setup waits", () => {
  expect(gateRoute(STATES.signed_in, null)).toBeNull();
  expect(gateRoute(STATES.signed_in, "where")).toBe("/setup/where");
  expect(gateRoute(STATES.signed_in, "claude")).toBe("/setup/claude");
  // Setup never holds back a signed-out or too-old app.
  expect(gateRoute(STATES.signed_out, "where")).toBe("/sign-in");
  expect(gateRoute(STATES.too_old, "claude")).toBe("/update");
});

test("sign-in says why only when GitHub needs granting again", () => {
  expect(signInNotice(STATES.github_reauth)).toBe("Sign in again so Ponzu can reach GitHub.");
  expect(signInNotice(STATES.signed_out)).toBeNull();
});

test("every screen sits behind a gate, but those that move on by themselves", () => {
  expect(areaOf([])).toBeNull();
  expect(areaOf(["auth", "callback"])).toBeNull();
  expect(areaOf(["github", "setup"])).toBeNull();
  expect(areaOf(["dev"])).toBeNull();
  expect(areaOf(["+not-found"])).toBeNull();
  expect(areaOf(["sign-in"])).toBe("/sign-in");
  expect(areaOf(["update"])).toBe("/update");
  expect(areaOf(["setup", "where"])).toBe("/setup/where");
  expect(areaOf(["setup", "claude"])).toBe("/setup/claude");
  // Pasting the code is part of Connect Claude.
  expect(areaOf(["setup", "code"])).toBe("/setup/claude");
  expect(areaOf(["(tabs)", "(canvases)", "canvases"])).toBe("/canvases");
  expect(areaOf(["settings"])).toBe("/canvases");
  expect(areaOf(["canvas", "[id]"])).toBe("/canvases");
});

test("the app moves when the session leaves the screen's gate, and only then", () => {
  const tabs = ["(tabs)", "(canvases)", "canvases"];
  // Signed out elsewhere, or here from settings.
  expect(gateMove(STATES.signed_out, tabs, null)).toBe("/sign-in");
  expect(gateMove(STATES.signed_out, ["settings"], null)).toBe("/sign-in");
  expect(gateMove(STATES.signed_out, ["setup", "where"], null)).toBe("/sign-in");
  // A 426 on any screen.
  expect(gateMove(STATES.too_old, tabs, "done")).toBe("/update");
  expect(gateMove(STATES.too_old, ["sign-in"], null)).toBe("/update");
  // Signing in: to setup, or past it.
  expect(gateMove(STATES.signed_in, ["sign-in"], "done")).toBe("/canvases");
  expect(gateMove(STATES.signed_in, ["sign-in"], "where")).toBe("/setup/where");
  // Until `me` answers, the sign-in screen stays.
  expect(gateMove(STATES.signed_in, ["sign-in"], null)).toBeNull();
  // Staying put.
  expect(gateMove(STATES.signed_in, tabs, "done")).toBeNull();
  expect(gateMove(STATES.signed_in, tabs, null)).toBeNull();
  expect(gateMove(STATES.signed_out, ["sign-in"], null)).toBeNull();
  expect(gateMove(STATES.github_reauth, ["sign-in"], null)).toBeNull();
  expect(gateMove(STATES.loading, tabs, null)).toBeNull();
  // The launch screen makes its own first move.
  expect(gateMove(STATES.signed_in, [], "where")).toBeNull();
});

test("setup moves the app on as each step is done, here or on another device", () => {
  // Continue on Where do you build?
  expect(gateMove(STATES.signed_in, ["setup", "where"], "claude")).toBe("/setup/claude");
  // Claude connected, from the code screen or the key, or on the Mac.
  expect(gateMove(STATES.signed_in, ["setup", "code"], "done")).toBe("/canvases");
  expect(gateMove(STATES.signed_in, ["setup", "claude"], "done")).toBe("/canvases");
  // Pasting the code is still Connect Claude.
  expect(gateMove(STATES.signed_in, ["setup", "code"], "claude")).toBeNull();
  // GitHub took the only workspace away: back to where they build.
  expect(gateMove(STATES.signed_in, ["(tabs)", "(canvases)", "canvases"], "where")).toBe(
    "/setup/where",
  );
  // GitHub's setup link goes back by itself.
  expect(gateMove(STATES.signed_in, ["github", "setup"], "claude")).toBeNull();
});
