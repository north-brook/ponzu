import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { ApiError } from "@ponzu/client";
import type { DeepLink } from "@ponzu/desktop/bridge";
import { linksWithInstalls } from "./installs.ts";

/*
 * The asking runs on a clock the test moves, never the machine's: a loaded machine changes how
 * late a timer fires, and so which of two timers fires first, but not what is asked or heard here.
 */
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

type Answer =
  | { status: "waiting"; expiresAt: string }
  | {
      status: "settled";
      result: "installed" | "requested" | "pending" | "sign_in" | "failed";
      workspaceId: string | null;
    }
  | { status: "expired" };

/** A GitHub install the test says the outcome of, and a shell whose links the test sends. */
function world(answers: (Answer | Error)[]) {
  const asked: string[] = [];
  const opened: string[] = [];
  let forward = 0;
  const shell = new Set<(link: DeepLink) => void>();
  const later = new Date(Date.now() + 15 * 60_000).toISOString();
  const api = {
    github: {
      installLink: async (body: { client: "mac" | "ios"; githubAccountId?: number }) => ({
        id: "auth_1",
        url: `https://github.com/apps/ponzu-dev/installations/new?target=${body.githubAccountId ?? ""}`,
        expiresAt: later,
      }),
      install: async (id: string) => {
        asked.push(id);
        const next = answers.shift() ?? { status: "waiting", expiresAt: later };
        if (next instanceof Error) throw next;
        return next;
      },
    },
  } as never;
  const links = linksWithInstalls({
    api,
    shellLinks: (listener) => {
      shell.add(listener);
      return () => shell.delete(listener);
    },
    openExternal: (url) => opened.push(url),
    comeForward: () => forward++,
    pollMs: 5,
  });
  const heard: DeepLink[] = [];
  links.onLink((link) => heard.push(link));
  return {
    links,
    heard,
    asked,
    opened,
    forward: () => forward,
    shellSends: (link: DeepLink) => {
      for (const listener of shell) listener(link);
    },
  };
}

/**
 * Moves the clock on by `ms`, a millisecond at a time, letting each ask that comes due finish
 * (the answer it awaits is a promise, so a few turns of the microtask queue) before going on.
 */
const pass = async (ms: number) => {
  for (let i = 0; i < ms; i++) {
    jest.advanceTimersByTime(1);
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  }
};
/** How often the world asks (its `pollMs`). */
const POLL = 5;
const later = new Date(Date.now() + 15 * 60_000).toISOString();

test("a build that takes no links: the install's outcome comes by asking, and Ponzu comes forward", async () => {
  const w = world([
    { status: "waiting", expiresAt: later },
    { status: "settled", result: "installed", workspaceId: "ws_lenny" },
  ]);
  await w.links.installGithub({ githubAccountId: 7 });
  expect(w.opened).toEqual(["https://github.com/apps/ponzu-dev/installations/new?target=7"]);
  expect(w.asked).toEqual([]);

  // Asked once a poll on: still waiting, so nothing heard yet.
  await pass(POLL);
  expect(w.asked).toEqual(["auth_1"]);
  expect(w.heard).toEqual([]);

  // The outcome comes on the second ask; after it, however long, no more.
  await pass(POLL);
  expect(w.heard).toEqual([{ kind: "github_setup", result: "installed", workspaceId: "ws_lenny" }]);
  await pass(POLL * 20);
  expect(w.asked).toEqual(["auth_1", "auth_1"]);
  expect(w.forward()).toBe(1);
});

test("the page's link and the answer are one outcome, acted on once, whichever comes first", async () => {
  const first = world([{ status: "settled", result: "installed", workspaceId: "ws_1" }]);
  await first.links.installGithub({});
  // The shell's link arrives before the app has asked.
  first.shellSends({ kind: "github_setup", result: "installed", workspaceId: "ws_1" });
  await pass(POLL * 4);
  expect(first.asked).toEqual(["auth_1"]);
  expect(first.heard).toHaveLength(1);
  // The shell brought Ponzu forward with its link; asking doesn't do it again.
  expect(first.forward()).toBe(0);

  const second = world([{ status: "settled", result: "requested", workspaceId: null }]);
  await second.links.installGithub({});
  await pass(POLL);
  expect(second.asked).toEqual(["auth_1"]);
  // The answer came first; the shell's link after it is the same outcome.
  second.shellSends({ kind: "github_setup", result: "requested" });
  expect(second.heard).toEqual([{ kind: "github_setup", result: "requested" }]);
  expect(second.forward()).toBe(1);
});

test("links from the shell otherwise pass as they are, the same one twice included", async () => {
  const w = world([]);
  const canvas: DeepLink = { kind: "canvas", canvasId: "cnv_1" };
  w.shellSends(canvas);
  w.shellSends({ kind: "github_setup", result: "pending" });
  w.shellSends({ kind: "github_setup", result: "pending" });
  expect(w.heard).toEqual([
    canvas,
    { kind: "github_setup", result: "pending" },
    { kind: "github_setup", result: "pending" },
  ]);
});

test("asking goes on through a network failure, and stops at expiry or for an install not there", async () => {
  const flaky = world([
    new Error("offline"),
    { status: "settled", result: "pending", workspaceId: null },
  ]);
  await flaky.links.installGithub({});
  await pass(POLL);
  expect(flaky.asked).toEqual(["auth_1"]);
  expect(flaky.heard).toEqual([]);
  // The failed ask is asked again a poll later, and that answer is heard.
  await pass(POLL);
  expect(flaky.asked).toEqual(["auth_1", "auth_1"]);
  expect(flaky.heard).toEqual([{ kind: "github_setup", result: "pending" }]);

  const expired = world([{ status: "expired" }]);
  await expired.links.installGithub({});
  await pass(POLL * 20);
  expect(expired.asked).toHaveLength(1);
  expect(expired.heard).toEqual([]);

  const gone = world([new ApiError(404, "not_found", "There is no such install.")]);
  await gone.links.installGithub({});
  await pass(POLL * 20);
  expect(gone.asked).toHaveLength(1);
  expect(gone.heard).toEqual([]);
  expect(gone.forward()).toBe(0);
});

test("an install page that couldn't be had rejects, and nothing is asked", async () => {
  const opened: string[] = [];
  const links = linksWithInstalls({
    api: {
      github: {
        installLink: async () => {
          throw new Error("down");
        },
      },
    } as never,
    shellLinks: () => () => {},
    openExternal: (url) => opened.push(url),
    comeForward: () => {},
  });
  await expect(links.installGithub({})).rejects.toThrow("down");
  expect(opened).toEqual([]);
});
