import { createHash } from "node:crypto";
import type { RunnerContext } from "@ponzu/db";
import type { GitCredentialRequest, GitCredentialResponse } from "@ponzu/runner/protocol";
import type { GithubInstallationToken } from "../deps/github.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError, UpstreamError } from "../http/errors.ts";

/*
 * Git's credentials for a canvas's checkout (docs/cloud.md, "The runner protocol", "Git"): a
 * one-hour installation token for exactly the canvas's repository, `contents: write` and
 * `metadata: read`, minted as the App when git asks. The sandbox stores none; this instance
 * keeps one for reuse while it has ten minutes or more left, and nowhere else does.
 */

/** A token is handed out again only while it has this long left. */
const REUSE_MARGIN_MS = 10 * 60_000;
/** How many tokens one instance keeps; past this the oldest go first. */
const KEPT = 1_000;
const PERMISSIONS = { contents: "write", metadata: "read" } as const;

/** A token for git, and whether it was minted for this ask or handed out again. */
export interface GitToken {
  token: GithubInstallationToken;
  minted: boolean;
}

/**
 * The tokens this instance has minted for git, by installation and repository. Not auth-app's
 * cache: git is handed a token only with ten minutes left, and `erase` drops one at once.
 *
 * A token goes to git only when GitHub's answer to the mint says it grants what git needs:
 * `contents: write` on the canvas's repository. One that says less is minted again once, and
 * then refused (502): git would only be told the repository is not found.
 */
export class GitTokens {
  readonly #held = new Map<string, GithubInstallationToken>();

  async get(
    { github, clock }: Pick<Deps, "github" | "clock">,
    target: { installationId: number; repositoryId: number },
  ): Promise<GitToken> {
    const key = keyOf(target);
    const held = this.#held.get(key);
    if (held && held.expiresAt.getTime() - clock.now() >= REUSE_MARGIN_MS) {
      return { token: held, minted: false };
    }
    const mint = () =>
      github.createInstallationToken({
        installationId: target.installationId,
        repositoryIds: [target.repositoryId],
        permissions: { ...PERMISSIONS },
      });
    let minted = await mint();
    if (lacks(minted, target.repositoryId)) minted = await mint();
    if (lacks(minted, target.repositoryId)) {
      throw new UpstreamError(
        "github",
        `GitHub granted ${JSON.stringify(minted.permissions ?? {})} on ${JSON.stringify(minted.repositoryIds ?? [])}, not contents: write on ${target.repositoryId}`,
      );
    }
    this.#held.delete(key);
    this.#held.set(key, minted);
    if (this.#held.size > KEPT) this.#held.delete(this.#held.keys().next().value!);
    return { token: minted, minted: true };
  }

  /**
   * GitHub refused the one handed out: the next ask mints another. Answers the fingerprint of
   * the token it dropped, for the log, or null when it held none.
   */
  forget(target: { installationId: number; repositoryId: number }): string | null {
    const key = keyOf(target);
    const held = this.#held.get(key);
    this.#held.delete(key);
    return held ? fingerprint(held.token) : null;
  }
}

/** Whether GitHub said it granted less than git needs. What it did not say is not held against it. */
function lacks(token: GithubInstallationToken, repositoryId: number): boolean {
  if (token.permissions && token.permissions.contents !== "write") return true;
  if (token.repositoryIds && !token.repositoryIds.includes(repositoryId)) return true;
  return false;
}

/**
 * A token's name in the logs: the first 12 hex characters of its SHA-256, which tell two tokens
 * apart and give nothing of either away. The runner logs the same of what it handed git.
 */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** What the log says of a token git was handed: never the token itself. */
export function describeToken({ token, minted }: GitToken): Record<string, unknown> {
  return {
    minted,
    fingerprint: fingerprint(token.token),
    expiresAt: token.expiresAt.toISOString(),
    ...(token.permissions ? { permissions: token.permissions } : {}),
    ...(token.repositoryIds ? { repositoryIds: token.repositoryIds } : {}),
  };
}

const keyOf = ({
  installationId,
  repositoryId,
}: {
  installationId: number;
  repositoryId: number;
}) => `${installationId}/${repositoryId}`;

/**
 * What git asked about, if it is the canvas's own repository on GitHub over https: the
 * installation and repository to mint for. 404 for Scratch, which has none; 403 for any other
 * host, path or protocol, and for a repository the App cannot reach now.
 */
export function gitTarget(
  context: Pick<RunnerContext, "repo" | "installationId" | "suspendedAt">,
  ask: GitCredentialRequest,
): { installationId: number; repositoryId: number } {
  const { repo, installationId, suspendedAt } = context;
  if (!repo) throw new ApiError(404, "not_found", "This canvas has no repository.");
  const path = ask.path.replace(/\.git$/, "").toLowerCase();
  if (
    ask.protocol !== "https" ||
    ask.host.toLowerCase() !== "github.com" ||
    path !== repo.fullName.toLowerCase()
  ) {
    throw new ApiError(403, "forbidden", "Git credentials are only for this canvas's repository.");
  }
  if (installationId === null || suspendedAt !== null) {
    throw new ApiError(403, "forbidden", "Ponzu cannot reach this repository on GitHub now.");
  }
  return { installationId, repositoryId: repo.githubRepoId };
}

/** What git's credential helper prints, from a token. */
export function credentialOf(token: GithubInstallationToken): GitCredentialResponse {
  return {
    username: "x-access-token",
    password: token.token,
    expiresAt: token.expiresAt.toISOString(),
  };
}
