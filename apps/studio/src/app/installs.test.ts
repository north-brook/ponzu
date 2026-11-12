import { expect, test } from "bun:test";
import { ApiError } from "@ponzu/client";
import type { DeepLink } from "@ponzu/desktop/bridge";
import { linksWithInstalls } from "./installs.ts";

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
  let told = () => {};
  /** Settles once the first link reaches the app's listeners, however long the asking took. */
  const outcome = new Promise<void>((resolve) => {
    told = resolve;
  });
  links.onLink((link) => {
    heard.push(link);
    told();
  });
  return {
    links,
    heard,
    outcome,
    asked,
    opened,
    forward: () => forward,
    shellSends: (link: DeepLink) => {
      for (const listener of shell) listener(link);
    },
  };
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const later = new Date(Date.now() + 15 * 60_000).toISOString();

test("a build that takes no links: the install's outcome comes by asking, and Ponzu comes forward", async () => {
  const w = world([
    { status: "waiting", expiresAt: later },
    { status: "settled", result: "installed", workspaceId: "ws_lenny" },
  ]);
  await w.links.installGithub({ githubAccountId: 7 });
  expect(w.opened).toEqual(["https://github.com/apps/ponzu-dev/installations/new?target=7"]);

  // The outcome comes on the second ask, whenever a loaded machine runs it; after it, no more.
  await w.outcome;
  await settle();

  expect(w.asked).toEqual(["auth_1", "auth_1"]);
  expect(w.forward()).toBe(1);
  expect(w.heard).toEqual([{ kind: "github_setup", result: "installed", workspaceId: "ws_lenny" }]);
});

test("the page's link and the answer are one outcome, acted on once, whichever comes first", async () => {
  const first = world([{ status: "settled", result: "installed", workspaceId: "ws_1" }]);
  await first.links.installGithub({});
  // The shell's link arrives before the app has asked.
  first.shellSends({ kind: "github_setup", result: "installed", workspaceId: "ws_1" });
  await settle();
  expect(first.heard).toHaveLength(1);
  // The shell brought Ponzu forward with its link; asking doesn't do it again.
  expect(first.forward()).toBe(0);

  const second = world([{ status: "settled", result: "requested", workspaceId: null }]);
  await second.links.installGithub({});
  await settle();
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
  await settle();
  expect(flaky.heard).toEqual([{ kind: "github_setup", result: "pending" }]);

  const expired = world([{ status: "expired" }]);
  await expired.links.installGithub({});
  await settle();
  expect(expired.asked).toHaveLength(1);
  expect(expired.heard).toEqual([]);

  const gone = world([new ApiError(404, "not_found", "There is no such install.")]);
  await gone.links.installGithub({});
  await settle();
  expect(gone.asked).toHaveLength(1);
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
