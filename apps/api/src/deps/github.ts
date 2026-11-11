import type { Endpoints } from "@octokit/types";
import type { Clock } from "@ponzu/sandbox";
import { ApiError, UpstreamError } from "../http/errors.ts";
import type { Fetch } from "./fetch.ts";
import {
  bearer,
  createAppCredentials,
  createOctokit,
  type GithubOctokit,
  idOf,
  listPages,
  pagedAs,
  repoParams,
  send,
} from "./github-octokit.ts";
import { createPullRequestCalls, type GithubPullRequests } from "./github-pull-requests.ts";

/*
 * GitHub, through Octokit (`github-octokit.ts`), in the two ways the API talks to it: as a
 * person, with their user token (`ghu_`), and as the Ponzu GitHub App, with a JWT signed by its
 * private key and the installation tokens minted with it. Callers get the user token from
 * `githubUserToken`, which keeps it fresh; they never store one.
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

/** An installation of the App: one a person can reach, or one the App looked up itself. */
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

/** A repository as the App sees it in an installation: nobody's permission in particular. */
export type GithubInstalledRepository = Omit<GithubRepository, "canPush">;

/** A person's standing in an organization: `admin` is an owner. */
export type GithubOrgRole = "admin" | "member";

/**
 * A list GitHub serves a page at a time. `complete` is false when it was longer than the API
 * reads (`MAX_PAGES`): what is missing from it is not known to be gone.
 */
export interface Listed<T> {
  items: T[];
  complete: boolean;
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
  /** What GitHub says the token may do, as it answered the mint; absent when it did not say. */
  permissions?: Record<string, string>;
  /** The repositories GitHub says it reaches, when it was narrowed to some. */
  repositoryIds?: number[];
}

/**
 * An answer from GitHub that is not a success leaves each of these as an `UpstreamError` that
 * carries GitHub's `status`, so a caller can tell "no such repository, or not for you" (404)
 * and "not allowed" (403) from GitHub being down.
 */
export interface Github extends GithubPullRequests {
  /** Calls made as a person. Each fails as `github_reauth_required` when GitHub refuses the token. */
  getUser(userToken: string): Promise<GithubUser>;
  /** Needs the App's "Email addresses" permission. */
  listEmails(userToken: string): Promise<GithubEmail[]>;
  /** The installations of the App this person can reach: their workspaces. */
  listInstallations(userToken: string): Promise<Listed<GithubUserInstallation>>;
  /** The repositories this person can reach inside one installation. */
  listInstallationRepositories(
    userToken: string,
    installationId: number,
  ): Promise<Listed<GithubRepository>>;
  /** Their role in an organization, or null if they are not an active member it shows them. */
  getOrgRole(userToken: string, org: string): Promise<GithubOrgRole | null>;
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
   * steer a design. Every call asks GitHub, except that calls about the same person and
   * repository at the same time share one question; keeping answers is `auth/repo-access.ts`'s.
   */
  getRepoPermission(input: RepoPermissionQuery): Promise<RepoPermission>;
  /**
   * As the App: one installation as GitHub has it now, or null once it is gone. This is the
   * word to trust over a webhook's payload, which may be older than what happened since.
   */
  getInstallation(installationId: number): Promise<GithubUserInstallation | null>;
  /** With an installation token: every repository the installation can see. */
  listRepositoriesAsInstallation(
    installationToken: string,
  ): Promise<Listed<GithubInstalledRepository>>;
  /** With an installation token: an account's display name, or null when it has none. */
  getAccountName(installationToken: string, login: string): Promise<string | null>;

  /*
   * Reading a repository's contents, a little at a time, never cloning: with an installation
   * token narrowed to it (`contents: read`), or with none for a public one. These go through
   * Octokit: GitHub bounds each answer (a tree at 7 MB, a file's content at 1 MB), and a file's
   * text is then cut at `maxBytes`.
   */
  /** What a repository says of itself. */
  getRepositoryAbout(token: string | null, fullName: string): Promise<GithubRepositoryAbout>;
  /**
   * Every path in the repository at `ref` (a branch or a commit), as far as GitHub lists it:
   * it stops at 100,000 entries or 7 MB and says so.
   */
  getTree(token: string | null, input: { fullName: string; ref: string }): Promise<GithubTree>;
  /** A file's text at `ref`, cut at `maxBytes`, or null when there is no such file. */
  getFileText(
    token: string | null,
    input: { fullName: string; path: string; ref: string; maxBytes: number },
  ): Promise<string | null>;
  /** The README GitHub shows on the repository's page, cut at `maxBytes`, or null for none. */
  getReadme(
    token: string | null,
    input: { fullName: string; ref: string; maxBytes: number },
  ): Promise<string | null>;
}

export interface GithubRepositoryAbout {
  description: string | null;
  topics: string[];
  homepage: string | null;
  /** The language GitHub counts most of it in. */
  language: string | null;
  defaultBranch: string;
  archived: boolean;
}

export interface GithubTree {
  entries: { path: string; type: "blob" | "tree"; size: number | null }[];
  /** False when GitHub cut the list short. */
  complete: boolean;
}

/** GitHub's four answers: admin, write and read, or none for no access at all. */
export type RepoPermission = "admin" | "write" | "read" | "none";

export interface RepoPermissionQuery {
  installationId: number;
  /** By GitHub's numeric id, which never changes, and the name it was last seen under. */
  repository: { id: number; fullName: string };
  /** By GitHub's numeric id, and the login it last signed in with, which can change hands. */
  user: { id: number; login: string };
}

const OAUTH_URL = "https://github.com";
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
  const octokit = createOctokit({ fetch, clock });
  // The key is read on first use, so a test that never acts as the App needs no real one.
  const app = createAppCredentials({ clientId, privateKey, octokit, clock });
  /** `getRepoPermission`'s questions in flight, by installation, repository and person. */
  const asking = new Map<string, Promise<RepoPermission>>();

  /**
   * Work as the App in one repository, with a token for exactly `permissions` there, kept for
   * reuse while it has a while to run. A token GitHub stops taking before it runs out (the
   * installation was suspended, or its permissions changed) is dropped, and the work is tried
   * once more with a new one.
   */
  async function asApp<T>(
    target: { installationId: number; repositoryId: number },
    permissions: AppPermissions,
    work: (token: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const token = await appToken(target, permissions, attempt > 1);
      try {
        return await work(token);
      } catch (error) {
        if (attempt === 2 || !(error instanceof UpstreamError) || error.status !== 401) throw error;
      }
    }
  }

  async function appToken(
    { installationId, repositoryId }: { installationId: number; repositoryId: number },
    permissions: AppPermissions,
    fresh: boolean,
  ): Promise<string> {
    const scope = {
      installationId,
      repositoryIds: [repositoryId],
      permissions: { ...permissions },
    };
    try {
      return (await app.reuse(scope, fresh)).token;
    } catch (error) {
      // 404: the installation is gone. 422: the repository is not in it any more.
      if (error instanceof UpstreamError && (error.status === 404 || error.status === 422)) {
        throw new NoInstallationToken();
      }
      throw error;
    }
  }

  /**
   * Asks with an installation token for this one repository and `metadata: read`, the least
   * the question takes. (The github-app spike measured this endpoint right for organization
   * owners with that token, where the collaborator list and `collaborators/{login}` were wrong
   * without `members: read`.) It takes a login, and a login can change hands, so the answer is
   * taken only when the account it names is this person's: otherwise it is asked again under
   * the login their id has now.
   */
  async function askRepoPermission(
    installationId: number,
    repository: RepoPermissionQuery["repository"],
    user: RepoPermissionQuery["user"],
  ): Promise<RepoPermission> {
    const asMetadataReader = <T>(work: (token: string) => Promise<T>) =>
      asApp({ installationId, repositoryId: repository.id }, { metadata: "read" }, (token) =>
        send("app", () => work(token)),
      );
    /** What one login may do there, and the id of the account it means. */
    const permissionOf = async (login: string) => {
      const { data } = await asMetadataReader((token) =>
        octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
          ...repoParams(repository.fullName),
          username: login,
          headers: bearer(token),
        }),
      );
      const permission = PERMISSIONS.find((known) => known === data.permission) ?? "none";
      return { userId: data.user?.id, permission };
    };
    /** The login a GitHub account has now (`GET /user/{id}` needs no permission). */
    const loginOf = async (userId: number) => {
      const { data } = await asMetadataReader((token) =>
        octokit.request("GET /user/{account_id}", { account_id: userId, headers: bearer(token) }),
      );
      return typeof data.login === "string" ? data.login : null;
    };
    try {
      // Null when GitHub knows no such login or account, or the repository was renamed since
      // it was last synced.
      const asked = await orNullOn404(permissionOf(user.login));
      if (asked?.userId === user.id) return asked.permission;
      const login = await orNullOn404(loginOf(user.id));
      if (login === null || login === user.login) return "none";
      const again = await orNullOn404(permissionOf(login));
      return again?.userId === user.id ? again.permission : "none";
    } catch (error) {
      if (error instanceof NoInstallationToken) return "none";
      throw error;
    }
  }

  return {
    async getUser(userToken) {
      const { data: user } = await send("user", () =>
        octokit.request("GET /user", { headers: bearer(userToken) }),
      );
      return {
        id: idOf(user.id),
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatar_url ?? null,
      };
    },

    async listEmails(userToken) {
      const { data: emails } = await send("user", () =>
        octokit.request("GET /user/emails", { per_page: PAGE_SIZE, headers: bearer(userToken) }),
      );
      return emails.map((entry) => ({
        email: entry.email,
        primary: entry.primary === true,
        verified: entry.verified === true,
      }));
    },

    async listInstallations(userToken) {
      const listed = await listPages(
        "user",
        octokit.paginate.iterator(
          "GET /user/installations",
          pagedAs(userToken, { per_page: PAGE_SIZE }),
        ),
        MAX_PAGES,
      );
      return { ...listed, items: listed.items.map(toInstallation) };
    },

    async listInstallationRepositories(userToken, installationId) {
      const listed = await listPages(
        "user",
        octokit.paginate.iterator(
          "GET /user/installations/{installation_id}/repositories",
          pagedAs(userToken, { installation_id: installationId, per_page: PAGE_SIZE }),
        ),
        MAX_PAGES,
      );
      return {
        ...listed,
        items: listed.items.map((repository) => ({
          ...toRepository(repository),
          canPush: repository.permissions?.push === true,
        })),
      };
    },

    async getOrgRole(userToken, org) {
      let membership: Endpoints["GET /user/memberships/orgs/{org}"]["response"]["data"];
      try {
        ({ data: membership } = await send("user", () =>
          octokit.request("GET /user/memberships/orgs/{org}", { org, headers: bearer(userToken) }),
        ));
      } catch (error) {
        // 404: not a member. 403: the organization does not let the App see its members.
        if (error instanceof UpstreamError && (error.status === 404 || error.status === 403)) {
          return null;
        }
        throw error;
      }
      if (membership.state !== "active") return null;
      return membership.role === "admin" ? "admin" : "member";
    },

    async refreshUserToken(refreshToken) {
      // Not `@octokit/oauth-methods`: it times the new pair by GitHub's Date header, not the
      // API's clock, and the refresh's single use is `github/user-token.ts`'s to guard.
      const { data: body } = await send("app", () =>
        octokit.request("POST /login/oauth/access_token", {
          baseUrl: OAUTH_URL,
          headers: { accept: "application/json" },
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      );
      // GitHub answers 200 either way and says which in the body.
      const answer = (body ?? {}) as Record<string, unknown>;
      if (typeof answer.access_token === "string") {
        const now = clock.now();
        const after = (seconds: unknown) =>
          typeof seconds === "number" ? new Date(now + seconds * 1000) : null;
        return {
          kind: "refreshed",
          tokens: {
            accessToken: answer.access_token,
            accessTokenExpiresAt: after(answer.expires_in),
            refreshToken: typeof answer.refresh_token === "string" ? answer.refresh_token : null,
            refreshTokenExpiresAt: after(answer.refresh_token_expires_in),
          },
        };
      }
      if (answer.error === "bad_refresh_token") return { kind: "rejected" };
      const code =
        typeof answer.error === "string" && /^[a-z_]{1,64}$/.test(answer.error) ? answer.error : "";
      throw new UpstreamError("github", `the token refresh answered 200 ${code}`, { status: 200 });
    },

    createInstallationToken: (scope) => app.mint(scope),

    getRepoPermission({ installationId, repository, user }) {
      const key = `${installationId}:${repository.id}:${user.id}`;
      const pending = asking.get(key);
      if (pending) return pending;
      const asked = askRepoPermission(installationId, repository, user).finally(() =>
        asking.delete(key),
      );
      asking.set(key, asked);
      return asked;
    },

    async getInstallation(installationId) {
      const jwt = await app.jwt();
      try {
        const { data } = await send("app", () =>
          octokit.request("GET /app/installations/{installation_id}", {
            installation_id: installationId,
            headers: bearer(jwt),
          }),
        );
        return toInstallation(data);
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) return null;
        throw error;
      }
    },

    async listRepositoriesAsInstallation(installationToken) {
      const listed = await listPages(
        "app",
        octokit.paginate.iterator(
          "GET /installation/repositories",
          pagedAs(installationToken, { per_page: PAGE_SIZE }),
        ),
        MAX_PAGES,
      );
      return { ...listed, items: listed.items.map(toRepository) };
    },

    async getAccountName(installationToken, login) {
      const { data: account } = await send("app", () =>
        octokit.request("GET /users/{username}", {
          username: login,
          headers: bearer(installationToken),
        }),
      );
      return typeof account.name === "string" && account.name.trim() !== "" ? account.name : null;
    },

    ...createPullRequestCalls({
      octokit,
      async asApp(target, permissions, work) {
        try {
          return await asApp(target, permissions, work);
        } catch (error) {
          if (!(error instanceof NoInstallationToken)) throw error;
          throw new ApiError(403, "forbidden", "Ponzu cannot reach this repository on GitHub now.");
        }
      },
    }),

    async getRepositoryAbout(token, fullName) {
      const { data: repository } = await send("app", () =>
        octokit.request("GET /repos/{owner}/{repo}", {
          ...repoParams(fullName),
          headers: tokenHeaders(token),
        }),
      );
      return {
        description: stringOrNull(repository.description),
        topics: (repository.topics ?? []).filter((topic) => typeof topic === "string"),
        homepage: stringOrNull(repository.homepage),
        language: stringOrNull(repository.language),
        defaultBranch: repository.default_branch,
        archived: repository.archived === true,
      };
    },

    async getTree(token, { fullName, ref }) {
      const { data } = await send("app", () =>
        octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
          ...repoParams(fullName),
          tree_sha: ref,
          recursive: "1",
          headers: tokenHeaders(token),
        }),
      );
      return {
        entries: data.tree.flatMap((entry) =>
          typeof entry.path === "string" && (entry.type === "blob" || entry.type === "tree")
            ? [{ path: entry.path, type: entry.type, size: entry.size ?? null }]
            : [],
        ),
        complete: data.truncated !== true,
      };
    },

    getFileText(token, { fullName, path, ref, maxBytes }) {
      return fileOrNull(maxBytes, () =>
        send("app", () =>
          octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
            ...repoParams(fullName),
            path,
            ref,
            headers: tokenHeaders(token),
          }),
        ),
      );
    },

    getReadme(token, { fullName, ref, maxBytes }) {
      return fileOrNull(maxBytes, () =>
        send("app", () =>
          octokit.request("GET /repos/{owner}/{repo}/readme", {
            ...repoParams(fullName),
            ref,
            headers: tokenHeaders(token),
          }),
        ),
      );
    },
  };
}

/** The token on one call, or none for a public repository. */
const tokenHeaders = (token: string | null) => (token === null ? {} : bearer(token));

/** Null for a 404: GitHub has no such thing there. */
async function orNullOn404<T>(asked: Promise<T>): Promise<T | null> {
  try {
    return await asked;
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) return null;
    throw error;
  }
}

const stringOrNull = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * A file's text from its contents JSON, cut at `maxBytes`, or null when GitHub has none there
 * or it is not a file. The JSON form, not the raw one, is what keeps a read small: GitHub puts
 * a file's content in it only up to 1 MB, and leaves it out (`encoding: "none"`) past that.
 */
async function fileOrNull(
  maxBytes: number,
  read: () => Promise<{ data: unknown }>,
): Promise<string | null> {
  let data: unknown;
  try {
    ({ data } = await read());
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) return null;
    throw error;
  }
  const file = data as { type?: unknown; encoding?: unknown; content?: unknown };
  if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
    return null;
  }
  const bytes = Buffer.from(file.content, "base64");
  // A cut can fall inside a character: what is left of it decodes as U+FFFD.
  return new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

/** What an installation token may do, by GitHub's permission names. */
export type AppPermissions = Readonly<Record<string, "read" | "write">>;

/**
 * How the pull request calls reach GitHub: the API's Octokit for one call as anybody, and work
 * as the App in one repository with a token for exactly the permissions given.
 */
export interface GithubTransport {
  octokit: GithubOctokit;
  /** Throws 403 `forbidden` when the App cannot reach the repository at all. */
  asApp<T>(
    target: { installationId: number; repositoryId: number },
    permissions: AppPermissions,
    work: (token: string) => Promise<T>,
  ): Promise<T>;
}

type Installation = Endpoints["GET /app/installations/{installation_id}"]["response"]["data"];
type Repository =
  Endpoints["GET /installation/repositories"]["response"]["data"]["repositories"][number];

function toInstallation(installation: Installation): GithubUserInstallation {
  // An installation is on a person or an organization here: GitHub's type also allows an
  // enterprise, which has no login and no workspace.
  const account = installation.account as Endpoints["GET /user"]["response"]["data"];
  return {
    id: installation.id,
    account: {
      id: idOf(account.id),
      login: account.login,
      type: account.type === "Organization" ? "Organization" : "User",
      avatarUrl: account.avatar_url ?? null,
    },
    repositorySelection: installation.repository_selection === "all" ? "all" : "selected",
    suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
  };
}

function toRepository(repository: Repository): GithubInstalledRepository {
  return {
    id: idOf(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    private: repository.private === true,
    pushedAt: repository.pushed_at ? new Date(repository.pushed_at) : null,
  };
}

const PERMISSIONS: readonly RepoPermission[] = ["admin", "write", "read", "none"];

/** The App has no way into the repository any more, so nobody has access through it. */
class NoInstallationToken extends Error {}
