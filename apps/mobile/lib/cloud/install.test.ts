import { describe, expect, test } from "bun:test";
import { type Api, ApiError } from "@ponzu/client";
import {
  announceInstall,
  INSTALL_POLL_MS,
  linkOutcome,
  onInstallOutcome,
  runInstall,
  setupRedirectFor,
} from "./install";
import type { AuthSessionResult } from "./sign-in";

type InstallAnswer = Awaited<ReturnType<Api["github"]["install"]>>;

/**
 * A clock the test moves, GitHub's install page as a promise the test settles, and the API's
 * answers to "how does the install stand" in turn.
 */
function world(answers: (InstallAnswer | Error)[] = []) {
  let at = 0;
  const sleepers: { until: number; wake: () => void }[] = [];
  let finish!: (result: AuthSessionResult) => void;
  const opened: { url: string; redirect: string }[] = [];
  const asked: string[] = [];
  const linked: unknown[] = [];
  let dismissed = 0;
  const github: Pick<Api["github"], "installLink" | "install"> = {
    installLink: async (body) => {
      linked.push(body);
      return {
        id: "auth_1",
        url: "https://github.com/apps/ponzu-dev/installations/new?state=s",
        expiresAt: new Date(15 * 60_000).toISOString(),
      } as Awaited<ReturnType<Api["github"]["installLink"]>>;
    },
    install: async (id) => {
      asked.push(id);
      const next = answers.shift() ?? {
        status: "waiting",
        expiresAt: new Date(15 * 60_000).toISOString(),
      };
      if (next instanceof Error) throw next;
      return next as InstallAnswer;
    },
  };
  return {
    opened,
    asked,
    linked,
    get dismissed() {
      return dismissed;
    },
    deps: {
      github,
      scheme: "ponzu-dev",
      openAuthSession: (url: string, redirect: string) => {
        opened.push({ url, redirect });
        return new Promise<AuthSessionResult>((done) => {
          finish = done;
        });
      },
      dismissAuthSession: () => {
        dismissed++;
        finish({ type: "dismiss" });
      },
      wait: (ms: number) =>
        new Promise<void>((wake) => {
          sleepers.push({ until: at + ms, wake });
        }),
      now: () => at,
    },
    /** The page sends the browser back on a link, or the person closes the sheet. */
    finish: (result: AuthSessionResult) => finish(result),
    /** Move the clock on by `ms`, letting each wait that ends meanwhile answer. */
    async advance(ms: number) {
      const end = at + ms;
      for (;;) {
        await flush();
        sleepers.sort((a, b) => a.until - b.until);
        const next = sleepers[0];
        if (!next || next.until > end) break;
        sleepers.shift();
        at = next.until;
        next.wake();
      }
      at = end;
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("installing the GitHub App from the phone", () => {
  test("opens GitHub's page for the account in the auth session, back on github/setup", async () => {
    const w = world();
    const outcome = runInstall({ ...w.deps, githubAccountId: 42 });
    await flush();
    expect(w.linked).toEqual([{ client: "ios", githubAccountId: 42 }]);
    expect(w.opened).toEqual([
      {
        url: "https://github.com/apps/ponzu-dev/installations/new?state=s",
        redirect: "ponzu-dev://github/setup",
      },
    ]);
    w.finish({ type: "success", url: "ponzu-dev://github/setup?result=installed&workspace=ws_1" });
    expect(await outcome).toEqual({ result: "installed", workspaceId: "ws_1", via: "link" });
    expect(w.dismissed).toBe(0);
  });

  test("the poll settles first: the sheet is closed for the person, and the link isn't needed", async () => {
    const w = world([
      { status: "waiting", expiresAt: new Date(15 * 60_000).toISOString() },
      { status: "settled", result: "installed", workspaceId: "ws_9" },
    ]);
    const outcome = runInstall(w.deps);
    await w.advance(INSTALL_POLL_MS);
    expect(w.asked).toEqual(["auth_1"]);
    expect(w.dismissed).toBe(0);
    await w.advance(INSTALL_POLL_MS);
    expect(w.asked).toEqual(["auth_1", "auth_1"]);
    expect(w.dismissed).toBe(1);
    expect(await outcome).toEqual({ result: "installed", workspaceId: "ws_9", via: "poll" });
    // Asked no more once it has settled.
    await w.advance(INSTALL_POLL_MS * 3);
    expect(w.asked).toHaveLength(2);
  });

  test("the link comes first: the poll stops, and a later settled answer is not heard", async () => {
    const w = world([{ status: "settled", result: "installed", workspaceId: "ws_9" }]);
    const outcome = runInstall(w.deps);
    await flush();
    w.finish({ type: "success", url: "ponzu-dev://github/setup?result=requested" });
    expect(await outcome).toEqual({ result: "requested", via: "link" });
    await w.advance(INSTALL_POLL_MS * 3);
    expect(w.asked).toEqual([]);
    expect(w.dismissed).toBe(0);
  });

  test("closing the sheet before GitHub is done is `closed`", async () => {
    const w = world();
    const outcome = runInstall(w.deps);
    await w.advance(INSTALL_POLL_MS);
    w.finish({ type: "cancel" });
    expect(await outcome).toEqual({ result: "closed" });
  });

  test("a failed question is asked again; a 404 or an expired install stops asking", async () => {
    const offline = world([
      new ApiError(0, "network", "Offline."),
      { status: "settled", result: "failed", workspaceId: null },
    ]);
    const first = runInstall(offline.deps);
    await offline.advance(INSTALL_POLL_MS * 2);
    expect(await first).toEqual({ result: "failed", via: "poll" });

    const gone = world([new ApiError(404, "not_found", "No such install.")]);
    const second = runInstall(gone.deps);
    await gone.advance(INSTALL_POLL_MS * 5);
    expect(gone.asked).toHaveLength(1);
    gone.finish({ type: "dismiss" });
    expect(await second).toEqual({ result: "closed" });

    const expired = world([{ status: "expired" }]);
    const third = runInstall(expired.deps);
    await expired.advance(INSTALL_POLL_MS * 5);
    expect(expired.asked).toHaveLength(1);
    expired.finish({ type: "cancel" });
    expect(await third).toEqual({ result: "closed" });
  });

  test("the setup link outside the sheet reaches whoever listens, and says if anyone did", () => {
    const outcome = { result: "installed", workspaceId: "ws_1", via: "link" as const };
    expect(announceInstall(outcome)).toBe(false);
    const heard: unknown[] = [];
    const off = onInstallOutcome((o) => heard.push(o));
    expect(announceInstall(outcome)).toBe(true);
    expect(heard).toEqual([outcome]);
    off();
    expect(announceInstall(outcome)).toBe(false);
    expect(heard).toHaveLength(1);
  });

  test("a link for the other app, or not a setup link, is no outcome", async () => {
    expect(linkOutcome("ponzu://github/setup?result=installed", "ponzu-dev")).toBeNull();
    expect(linkOutcome("ponzu-dev://canvas/cnv_1", "ponzu-dev")).toBeNull();
    expect(linkOutcome("ponzu-dev://github/setup?result=nonsense", "ponzu-dev")).toBeNull();
    expect(linkOutcome("ponzu-dev://github/setup?result=sign_in", "ponzu-dev")).toEqual({
      result: "sign_in",
      via: "link",
    });
    expect(setupRedirectFor("ponzu")).toBe("ponzu://github/setup");

    const w = world();
    const outcome = runInstall(w.deps);
    await flush();
    w.finish({ type: "success", url: "ponzu://github/setup?result=installed" });
    expect(await outcome).toEqual({ result: "closed" });
  });
});
