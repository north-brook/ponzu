import { expect, test } from "bun:test";
import { bundleName, runnerClient, VERSION } from "./version.ts";

const sha = "2de5aff8d90350a37fec16d85a27d92312032cdc06cbfdf39781f187948221b1";

test("in a sandbox, the runner names the bundle it was started from", () => {
  expect(bundleName({ PONZU_RUNNER_BUNDLE: sha })).toBe("2de5aff8d903");
});

test("outside a sandbox, or with a variable that is not a hash, it names none", () => {
  expect(bundleName({})).toBeNull();
  expect(bundleName({ PONZU_RUNNER_BUNDLE: "../../etc" })).toBeNull();
  expect(bundleName({ PONZU_RUNNER_BUNDLE: sha.toUpperCase() })).toBeNull();
});

test("it says its version and its bundle as build metadata, or its version alone", () => {
  expect(runnerClient("2de5aff8d903")).toBe(`runner/${VERSION}+2de5aff8d903`);
  expect(runnerClient(null)).toBe(`runner/${VERSION}`);
});
