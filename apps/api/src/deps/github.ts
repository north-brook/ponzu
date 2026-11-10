import { createPrivateKey } from "node:crypto";
import type { Clock } from "@ponzu/sandbox";
import { SignJWT } from "jose";
import { ApiError, UpstreamError } from "../http/errors.ts";
import type { Fetch } from "./fetch.ts";

/*
 * GitHub, on plain fetch, in the two ways the API talks to it: as a person, with their user
 * token (`ghu_`), and as the Ponzu GitHub App, with a JWT signed by its private key. Callers
 * get the user token from `githubUserToken`, which keeps it fresh; they never store one.
 */

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export interface GithubAccount {
  id: number;
  login: string;
  type: "User" | "Organization";
  avatarUrl: string | null;
}

/** An installation of the App that a person can reach. */
export interface GithubUserInstallation {
  id: number;
  account: GithubAccount;
  repositorySelection: "all" | "selected";
  suspendedAt: Date | null;
}

export interface GithubRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  pushedAt: Date | null;
  /** Whether the person can push to it. */
  canPush: boolean;
}

/** A fresh user token pair, from a refresh. */
export interface GithubTokenPair {
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

export type GithubRefreshResult =
  | { kind: "refreshed"; tokens: GithubTokenPair }
  /** GitHub no longer takes this refresh token: it was used, revoked or ran out. */
  | { kind: "rejected" };

/** A token for the App itself in one installation, good for an hour. */
export interface GithubInstallationToken {
  token: string;
  expiresAt: Date;
}

/**
 * An answer from GitHub that is not a success leaves each of these as an `UpstreamError` that
 * carries GitHub's `status`, so a caller can tell "no such repository, or not for you" (404)
 * and "not allowed" (403) from GitHub being down.
 */
export interface Github {
  /** Calls made as a person. Each fails as `github_reauth_required` when GitHub refuses the token. */
  getUser(userToken: string): Promise<GithubUser>;
  /** Needs the App's "Email addresses" permission. */
  listEmails(userToken: string): Promise<GithubEmail[]>;
  /** The installations of the App this person can reach: their workspaces. */
  listInstallations(userToken: string): Promise<GithubUserInstallation[]>;
  /** The repositories this person can reach inside one installation. */
  listInstallationRepositories(
    userToken: string,
    installationId: number,
  ): Promise<GithubRepository[]>;
  /** Trades a refresh token for a new pair. The old refresh token stops working at once. */
  refreshUserToken(refreshToken: string): Promise<GithubRefreshResult>;

  /**
   * As the App: a token for one installation, narrowed to the repositories and permissions a
   * job needs. Leave either out and GitHub grants everything the installation has, so don't.
   */
  createInstallationToken(input: {
    installationId: number;
    repositoryIds?: number[];
    permissions?: Record<string, "read" | "write">;
  }): Promise<GithubInstallationToken>;

  /**
   * As the App: what a person may do in one repository, which is what decides who may open and
   * steer a design. The answer is kept for a minute per person and repository, in this
   * function instance only, so someone whose access is taken away loses it within a minute.
   */
  getRepoPermission(input: RepoPermissionQuery): Promise<RepoPermission>;
}

/** GitHub's four answers: admin, write and read, or none for no access at all. */
export type RepoPermission = "admin" | "write" | "read" | "none";

export interface RepoPermissionQuery {
  installationId: number;
  /** The repository and the person by GitHub's numeric ids, which are what the answer is kept under. */
  repository: { id: number; fullName: string };
  user: { id: number; login: string };
}

/** How long an answer about a person's access to a repository is kept. */
export const REPO_PERMISSION_TTL_MS = 60_000;
/** How many answers one instance keeps; past this the oldest go first. */
const REPO_PERMISSION_CACHE_SIZE = 10_000;
/** An installation token is reused until this long before it runs out. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;

const API_URL = "https://api.github.com";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
/** The most pages one list is read to: 2,000 installations or repositories. */
const MAX_PAGES = 20;

export function createGithub({
  clientId,
  clientSecret,
  privateKey,
  fetch,
  clock,
}: {
  clientId: string;
  clientSecret: string;
  /** The App's private key as GitHub gave it: a PEM, PKCS#1 or PKCS#8. */
  privateKey: string;
  fetch: Fetch;
  clock: Clock;
}): Github {
  // Parsed on first use, so a test that never acts as the App needs no real key.
  let signingKey: ReturnType<typeof createPrivateKey> | undefined;
  /** `getRepoPermission`'s answers, by repository and person, oldest first. */
  const permissions = new Map<string, { permission: RepoPermission; until: number }>();
  /** The tokens it asks with, by installation and repository. */
  const tokens = new Map<string, GithubInstallationToken>();

  /** One call to api.github.com. `as` says whose credential `bearer` is. */
  async function call(
    as: "user" | "app",
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
  ) {
    let response: Response;
    try {
      response = await fetch(`${API_URL}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${bearer}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "ponzu-api",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: clock.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new UpstreamError("github", `${method} ${path} did not answer`, { cause });
    }
    if (response.status === 401 && as === "user") {
      // The token ran out early or the person revoked the App: only signing in again mends it.
      throw new ApiError(401, "github_reauth_required", "Sign in again to reconnect GitHub.");
    }
    if (!response.ok) {
      throw new UpstreamError("github", `${method} ${path} answered ${response.status}`, {
        status: response.status,
      });
    }
    return (await response.json()) as any;
  }

  /** Every page of a list GitHub wraps as `{ total_count, [key]: [...] }`. */
  async function listAll(path: string, userToken: string, key: string): Promise<any[]> {
    const items: any[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await call(
        "user",
        "GET",
        `${path}?per_page=${PAGE_SIZE}&page=${page}`,
        userToken,
      );
      const batch: any[] = body[key] ?? [];
      items.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return items;
  }

  /** The App's own credential: a JWT good for a few minutes, backdated for clock drift. */
  function appJwt(): Promise<string> {
    signingKey ??= createPrivateKey(privateKey);
    const now = Math.floor(clock.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(clientId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 540)
      .sign(signingKey);
  }

  return {
    async getUser(userToken) {
      const user = await call("user", "GET", "/user", userToken);
      return {
        id: user.id,
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatar_url ?? null,
      };
    },

    async listEmails(userToken) {
      const emails: any[] = await call(
        "user",
        "GET",
        `/user/emails?per_page=${PAGE_SIZE}`,
        userToken,
      );
      return emails.map((entry) => ({
        email: entry.email,
        primary: entry.primary === true,
        verified: entry.verified === true,
      }));
    },

    async listInstallations(userToken) {
      const installations = await listAll("/user/installations", userToken, "installations");
      return installations.map((installation) => ({
        id: installation.id,
        account: {
          id: installation.account.id,
          login: installation.account.login,
          type: installation.account.type === "Organization" ? "Organization" : "User",
          avatarUrl: installation.account.avatar_url ?? null,
        },
        repositorySelection: installation.repository_selection === "all" ? "all" : "selected",
        suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
      }));
    },

    async listInstallationRepositories(userToken, installationId) {
      const path = `/user/installations/${installationId}/repositories`;
      const repositories = await listAll(path, userToken, "repositories");
      return repositories.map((repository) => ({
        id: repository.id,
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        private: repository.private === true,
        pushedAt: repository.pushed_at ? new Date(repository.pushed_at) : null,
        canPush: repository.permissions?.push === true,
      }));
    },

    async refreshUserToken(refreshToken) {
      let response: Response;
      try {
        response = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
          signal: clock.timeout(TIMEOUT_MS),
        });
      } catch (cause) {
        throw new UpstreamError("github", "the token refresh did not answer", { cause });
      }
      // GitHub answers 200 either way and says which in the body.
      const body = response.ok ? ((await response.json()) as any) : {};
      if (typeof body.access_token === "string") {
        const now = clock.now();
        const after = (seconds: unknown) =>
          typeof seconds === "number" ? new Date(now + seconds * 1000) : null;
        return {
          kind: "refreshed",
          tokens: {
            accessToken: body.access_token,
            accessTokenExpiresAt: after(body.expires_in),
            refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
            refreshTokenExpiresAt: after(body.refresh_token_expires_in),
          },
        };
      }
      if (body.error === "bad_refresh_token") return { kind: "rejected" };
      const code =
        typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : "";
      throw new UpstreamError("github", `the token refresh answered ${response.status} ${code}`, {
        status: response.status,
      });
    },

    createInstallationToken,

    async getRepoPermission({ installationId, repository, user }) {
      const key = `${repository.id}:${user.id}`;
      const known = permissions.get(key);
      if (known && known.until > clock.now()) return known.permission;

      const permission = await askRepoPermission(installationId, repository, user.login);
      permissions.delete(key);
      if (permissions.size >= REPO_PERMISSION_CACHE_SIZE) {
        permissions.delete(permissions.keys().next().value!);
      }
      permissions.set(key, { permission, until: clock.now() + REPO_PERMISSION_TTL_MS });
      return permission;
    },
  };

  async function createInstallationToken({
    installationId,
    repositoryIds,
    permissions,
  }: Parameters<Github["createInstallationToken"]>[0]): Promise<GithubInstallationToken> {
    const path = `/app/installations/${installationId}/access_tokens`;
    const body = await call("app", "POST", path, await appJwt(), {
      ...(repositoryIds ? { repository_ids: repositoryIds } : {}),
      ...(permissions ? { permissions } : {}),
    });
    return { token: body.token, expiresAt: new Date(body.expires_at) };
  }

  /**
   * Asks with an installation token for this one repository and `metadata: read`, the least
   * the question takes. (The github-app spike measured this endpoint right for organization
   * owners with that token, where the collaborator list and `collaborators/{login}` were wrong
   * without `members: read`.) It takes a login, so a person who renamed themselves since they
   * last signed in is not found, and has no access until they sign in again.
   */
  async function askRepoPermission(
    installationId: number,
    repository: RepoPermissionQuery["repository"],
    login: string,
  ): Promise<RepoPermission> {
    let token: string;
    try {
      token = await metadataToken(installationId, repository.id);
    } catch (error) {
      // 404: the installation is gone. 422: the repository is not in it any more.
      if (error instanceof UpstreamError && (error.status === 404 || error.status === 422)) {
        return "none";
      }
      throw error;
    }
    const path = `/repos/${repository.fullName}/collaborators/${encodeURIComponent(login)}/permission`;
    try {
      const body = await call("app", "GET", path, token);
      return PERMISSIONS.includes(body.permission) ? body.permission : "none";
    } catch (error) {
      // No such login, or a repository renamed since it was last synced.
      if (error instanceof UpstreamError && error.status === 404) return "none";
      throw error;
    }
  }

  /** A `metadata: read` token for one repository, reused while it has a while to run. */
  async function metadataToken(installationId: number, repositoryId: number): Promise<string> {
    const key = `${installationId}:${repositoryId}`;
    const held = tokens.get(key);
    if (held && held.expiresAt.getTime() - TOKEN_REUSE_MARGIN_MS > clock.now()) return held.token;
    const minted = await createInstallationToken({
      installationId,
      repositoryIds: [repositoryId],
      permissions: { metadata: "read" },
    });
    tokens.set(key, minted);
    return minted.token;
  }
}

const PERMISSIONS: readonly RepoPermission[] = ["admin", "write", "read", "none"];
