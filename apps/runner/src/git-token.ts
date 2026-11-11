import { createHash } from "node:crypto";
import type { RunnerApi } from "./api/api.ts";
import type { GitCredentialRequest, GitCredentialResponse } from "./api/protocol.ts";

/*
 * The runner's side of git's credentials (docs/cloud.md, "Git"): the helper asks the runner, the
 * runner asks the API, and before the token goes to git the runner checks that GitHub's git
 * endpoint honours it for a push. On 2026-11-11 a token minted that instant got "Repository not
 * found" twice, three seconds apart, and one minted seven minutes earlier pushed: GitHub knew the
 * token but did not yet grant it the repository's contents. git asks its helper to erase only
 * after a 401, so nothing learned of that 404. Now the runner asks GitHub first, from the same
 * machine git pushes from, the same way git starts a push (`info/refs?service=git-receive-pack`),
 * waits while GitHub refuses, gives a refused token back so the API mints another, and hands
 * git a token GitHub has honoured. When GitHub cannot be asked, or keeps refusing past the
 * budget, git gets the token anyway and fails or succeeds as it would have.
 */

/** GitHub's answer to the check: its HTTP status, or null when it could not be asked. */
export type Probe = (
  ask: GitCredentialRequest,
  credential: GitCredentialResponse,
) => Promise<number | null>;

/**
 * Asks GitHub's git endpoint for the repository's refs as a push would: 200 when the token may
 * push, 404 when GitHub does not (yet) let it see the contents, 403 when it may only read, 401
 * when GitHub does not know it. The body (every ref) is not read.
 */
export function receivePackProbe(fetcher: typeof fetch = fetch, timeoutMs = 10_000): Probe {
  return async (ask, credential) => {
    const path = ask.path.replace(/^\/+|\/+$/g, "");
    const url = `${ask.protocol}://${ask.host}/${path}/info/refs?service=git-receive-pack`;
    try {
      const response = await fetcher(url, {
        headers: {
          authorization: `Basic ${btoa(`${credential.username}:${credential.password}`)}`,
          // GitHub serves the smart protocol to git's own user agent.
          "user-agent": "git/2.45.0 (ponzu-runner)",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel().catch(() => {});
      return response.status;
    } catch {
      return null;
    }
  };
}

/** Statuses that say GitHub knows of the repository and will not let this token push to it. */
const REFUSED = new Set([401, 403, 404]);

/**
 * Waits between checks of one token, then of the next: about 15 seconds in all, inside the 30
 * the helper waits for an answer. After `ERASE_AFTER` refusals of one token it is given back.
 */
export const READY_WAITS_MS = [500, 1_000, 1_500, 2_000, 2_500, 3_000, 4_000];
const ERASE_AFTER = 4;

/** A token's name in the logs, as the API names it: never the token. */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export class GitCredentials {
  /** Tokens GitHub has honoured for a push, by fingerprint: handed out again without a check. */
  private readonly honoured = new Set<string>();
  private readonly waits: number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly opts: {
      api: Pick<RunnerApi, "gitCredential" | "eraseGitCredential">;
      probe: Probe;
      event(name: string, fields: Record<string, unknown>): void;
      waitsMs?: number[];
      sleep?(ms: number): Promise<void>;
    },
  ) {
    this.waits = opts.waitsMs ?? READY_WAITS_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** A token for git that GitHub honours for a push, as far as it can be had in time. */
  async get(ask: GitCredentialRequest): Promise<GitCredentialResponse> {
    const { api, probe, event } = this.opts;
    let credential = await api.gitCredential(ask);
    let name = fingerprint(credential.password);
    if (this.honoured.has(name)) return credential;
    const started = Date.now();
    let refusals = 0;
    for (let check = 0; ; check++) {
      const status = await probe(ask, credential);
      if (status === 200) {
        this.honoured.add(name);
        event("git_credential_ready", {
          fingerprint: name,
          checks: check + 1,
          ms: Date.now() - started,
        });
        return credential;
      }
      if (status === null || !REFUSED.has(status)) {
        // GitHub could not say (down, unreachable, something unforeseen): git finds out itself.
        event("git_credential_unchecked", { fingerprint: name, status });
        return credential;
      }
      event("git_credential_refused", { fingerprint: name, status, check: check + 1 });
      const wait = this.waits[check];
      if (wait === undefined) break;
      if (++refusals >= ERASE_AFTER) {
        // Not this token, then: the API forgets it and mints another.
        await api.eraseGitCredential({
          ...ask,
          reason: `GitHub's git answered ${status} to the runner's check, ${refusals} times`,
        });
        await this.sleep(wait);
        credential = await api.gitCredential(ask);
        name = fingerprint(credential.password);
        refusals = 0;
        if (this.honoured.has(name)) return credential;
        continue;
      }
      await this.sleep(wait);
    }
    event("git_credential_unready", { fingerprint: name, ms: Date.now() - started });
    return credential;
  }

  /** GitHub refused what git was given (a 401): forget what was honoured, and tell the API. */
  async erase(ask: GitCredentialRequest): Promise<void> {
    this.honoured.clear();
    await this.opts.api.eraseGitCredential(ask);
  }
}
