import type { RunnerContext } from "@ponzu/db";
import type { GitCredentialRequest, GitCredentialResponse } from "@ponzu/runner/protocol";
import type { GithubInstallationToken } from "../deps/github.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";

/*
 * Git's credentials for a design's checkout (docs/cloud.md, "The runner protocol", "Git"): a
 * one-hour installation token for exactly the design's repository, `contents: write` and
 * `metadata: read`, minted as the App when git asks. The sandbox stores none; this instance
 * keeps one for reuse while it has ten minutes or more left, and nowhere else does.
 */

/** A token is handed out again only while it has this long left. */
const REUSE_MARGIN_MS = 10 * 60_000;
/** How many tokens one instance keeps; past this the oldest go first. */
const KEPT = 1_000;
const PERMISSIONS = { contents: "write", metadata: "read" } as const;

/**
 * The tokens this instance has minted for git, by installation and repository. Not auth-app's
 * cache: git is handed a token only with ten minutes left, and `erase` drops one at once.
 */
export class GitTokens {
  readonly #held = new Map<string, GithubInstallationToken>();

  async get(
    { github, clock }: Pick<Deps, "github" | "clock">,
    target: { installationId: number; repositoryId: number },
  ): Promise<GithubInstallationToken> {
    const key = keyOf(target);
    const held = this.#held.get(key);
    if (held && held.expiresAt.getTime() - clock.now() >= REUSE_MARGIN_MS) return held;
    const minted = await github.createInstallationToken({
      installationId: target.installationId,
      repositoryIds: [target.repositoryId],
      permissions: { ...PERMISSIONS },
    });
    this.#held.delete(key);
    this.#held.set(key, minted);
    if (this.#held.size > KEPT) this.#held.delete(this.#held.keys().next().value!);
    return minted;
  }

  /** GitHub refused the one handed out: the next ask mints another. */
  forget(target: { installationId: number; repositoryId: number }): void {
    this.#held.delete(keyOf(target));
  }
}

const keyOf = ({
  installationId,
  repositoryId,
}: {
  installationId: number;
  repositoryId: number;
}) => `${installationId}/${repositoryId}`;

/**
 * What git asked about, if it is the design's own repository on GitHub over https: the
 * installation and repository to mint for. 404 for Scratch, which has none; 403 for any other
 * host, path or protocol, and for a repository the App cannot reach now.
 */
export function gitTarget(
  context: Pick<RunnerContext, "repo" | "installationId" | "suspendedAt">,
  ask: GitCredentialRequest,
): { installationId: number; repositoryId: number } {
  const { repo, installationId, suspendedAt } = context;
  if (!repo) throw new ApiError(404, "not_found", "This design has no repository.");
  const path = ask.path.replace(/\.git$/, "").toLowerCase();
  if (
    ask.protocol !== "https" ||
    ask.host.toLowerCase() !== "github.com" ||
    path !== repo.fullName.toLowerCase()
  ) {
    throw new ApiError(403, "forbidden", "Git credentials are only for this design's repository.");
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
