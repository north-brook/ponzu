import { expect, test } from "bun:test";
import {
  canvasSandboxName,
  parseSandboxName,
  scopePrefix,
  signInSandboxName,
  testSandboxName,
} from "./names.ts";

const SCOPE = "0123456789ab";

test("canvas and sign-in names carry the scope and parse back", () => {
  expect(scopePrefix(SCOPE)).toBe("pz-0123456789ab-");
  const canvas = canvasSandboxName(SCOPE, "d_7Hq2");
  expect(canvas).toBe("pz-0123456789ab-d_7Hq2");
  expect(parseSandboxName(canvas)).toEqual({ scope: SCOPE, kind: "canvas", id: "d_7Hq2" });
  const signIn = signInSandboxName(SCOPE, "as_9");
  expect(signIn).toBe("pz-0123456789ab-signin-as_9");
  expect(parseSandboxName(signIn)).toEqual({ scope: SCOPE, kind: "signin", id: "as_9" });
});

test("test names match no scope", () => {
  const name = testSandboxName("live");
  expect(name).toMatch(/^pz-test-live-[a-z0-9]{8}$/);
  expect(parseSandboxName(name)).toBeNull();
  expect(testSandboxName("live")).not.toBe(name);
});

test("refuses what Vercel would refuse, and a canvas id that reads as a sign-in", () => {
  expect(() => scopePrefix("nothex")).toThrow();
  expect(() => canvasSandboxName(SCOPE, "a/b")).toThrow();
  expect(() => canvasSandboxName(SCOPE, "x".repeat(120))).toThrow();
  expect(() => canvasSandboxName(SCOPE, "signin-x")).toThrow();
  expect(parseSandboxName("other")).toBeNull();
  expect(parseSandboxName("pz-0123456789ab-signin-")).toBeNull();
});
