import { type Api, ApiError } from "@ponzu/client";
import type { DeepLink } from "@ponzu/desktop/bridge";

/*
 * Installing the GitHub App from Ponzu (docs/cloud.md, "Installing"). The app opens GitHub's
 * install page in the browser and then asks the API how that install stands until it has come
 * back (`GET /v1/github/installs/:id`). Once it has, Ponzu comes forward by itself and moves on,
 * as it does when a sign-in's tab finishes: the outcome goes to the app's link listeners as the
 * `github_setup` link the setup page would have opened.
 *
 * So the link is never needed. A build that takes none (Ponzu Local, on a Mac) hears the outcome
 * this way only; one that takes links usually hears it twice, by the page's link and by asking,
 * and acts on whichever comes first (`heard`).
 */

/** How often an install waiting on GitHub is asked about. */
export const INSTALL_POLL_MS = 2_000;
/** A second word of the same outcome within this long is the same outcome. */
const SAME_OUTCOME_MS = 30_000;

type SetupLink = Extract<DeepLink, { kind: "github_setup" }>;

export interface Installs {
  /**
   * Open GitHub's install page, suggesting `githubAccountId`, and listen for it coming back.
   * Rejects when the page couldn't be had.
   */
  start(body: { githubAccountId?: number }): Promise<void>;
  /**
   * A link from the shell. False for a setup link that only repeats the outcome just acted on
   * (the page's link arriving after the API was asked, or the other way round).
   */
  heard(link: DeepLink): boolean;
  /** Stop listening for every install. */
  close(): void;
}

/**
 * A host's `onLink` and `installGithub`, from the links its shell hears (`shellLinks`): each
 * listener hears both the shell's links and the outcomes asked of the API, each outcome once.
 */
export function linksWithInstalls(opts: {
  api: Pick<Api, "github">;
  shellLinks: (listener: (link: DeepLink) => void) => () => void;
  openExternal: (url: string) => void;
  comeForward: () => void;
  pollMs?: number;
}): {
  onLink: (listener: (link: DeepLink) => void) => () => void;
  installGithub: (body: { githubAccountId?: number }) => Promise<void>;
} {
  const listeners = new Set<(link: DeepLink) => void>();
  const tell = (link: DeepLink) => {
    for (const listener of [...listeners]) listener(link);
  };
  const watcher = installs({
    api: opts.api,
    openExternal: opts.openExternal,
    comeForward: opts.comeForward,
    emit: tell,
    ...(opts.pollMs ? { pollMs: opts.pollMs } : {}),
  });
  // One subscription to the shell while anyone listens, so each of its links is judged once
  // and reaches every listener, links queued before the first listener included.
  let off: (() => void) | null = null;
  return {
    onLink(listener) {
      listeners.add(listener);
      off ??= opts.shellLinks((link) => {
        if (watcher.heard(link)) tell(link);
      });
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && off) {
          off();
          off = null;
        }
      };
    },
    installGithub: (body) => watcher.start(body),
  };
}

export function installs(opts: {
  api: Pick<Api, "github">;
  openExternal: (url: string) => void;
  /** Bring the app in front of the browser. */
  comeForward: () => void;
  /** Hand the outcome to the app's link listeners. */
  emit: (link: SetupLink) => void;
  now?: () => number;
  pollMs?: number;
}): Installs {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? INSTALL_POLL_MS;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let last: { key: string; from: "shell" | "api"; at: number } | null = null;

  /**
   * Whether `link` is news, noting it as the last outcome if so: the same outcome heard the other
   * way just now is not. The same link twice from the shell is two links, and both count.
   */
  const fresh = (link: SetupLink, from: "shell" | "api") => {
    const key = `${link.result}:${link.workspaceId ?? ""}`;
    const echo =
      last && last.key === key && last.from !== from && now() - last.at < SAME_OUTCOME_MS;
    if (echo) {
      last = null;
      return false;
    }
    last = { key, from, at: now() };
    return true;
  };

  const later = (run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, pollMs);
    timers.add(timer);
  };

  const watch = (id: string, until: number) => {
    const ask = async () => {
      let answer: Awaited<ReturnType<Api["github"]["install"]>>;
      try {
        answer = await opts.api.github.install(id);
      } catch (error) {
        // Not theirs or gone: nothing to hear. Anything else is asked again while it can come.
        if (error instanceof ApiError && error.status === 404) return;
        if (now() < until) later(ask);
        return;
      }
      if (answer.status === "settled") {
        const link: SetupLink = {
          kind: "github_setup",
          result: answer.result,
          ...(answer.workspaceId ? { workspaceId: answer.workspaceId } : {}),
        };
        if (!fresh(link, "api")) return;
        opts.comeForward();
        opts.emit(link);
        return;
      }
      if (answer.status === "waiting" && now() < until) later(ask);
    };
    later(ask);
  };

  return {
    async start(body) {
      const { id, url, expiresAt } = await opts.api.github.installLink({ client: "mac", ...body });
      opts.openExternal(url);
      watch(id, Date.parse(String(expiresAt)));
    },
    heard(link) {
      return link.kind !== "github_setup" || fresh(link, "shell");
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
