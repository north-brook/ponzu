import { createPrivateKey, type KeyObject } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { Clock } from "@ponzu/sandbox";
import { SignJWT } from "jose";
import { ApiError, UpstreamError } from "../http/errors.ts";
import type { Fetch } from "./fetch.ts";
import { createPullRequestCalls, type GithubPullRequests } from "./github-pull-requests.ts";

/*
 * GitHub, on plain fetch, in the two ways the API talks to it: as a person, with their user
 * token (`ghu_`), and as the Ponzu GitHub App, with a JWT signed by its private key. Callers
 * get the user token from `githubUserToken`, which keeps it fresh; they never store one. The
 * repository contents reads (for `ideas/`) go through Octokit, on the same fetch.
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

/** An installation token is reused until this long before it runs out. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
/** How many installation tokens one instance keeps; past this the oldest go first. */
const TOKENS_KEPT = 1_000;

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
  /** `getRepoPermission`'s questions in flight, by installation, repository and person. */
  const asking = new Map<string, Promise<RepoPermission>>();
  /** The tokens it asks with, by installation and repository, oldest first. */
  const tokens = new Map<string, GithubInstallationToken>();
  /** For the repository contents reads (`getTree`, `getFileText`, …): the token goes on each. */
  const octokit = new Octokit({
    userAgent: "ponzu-api",
    request: { fetch: fetch as typeof globalThis.fetch },
    // Its default log writes warnings (a deprecated endpoint) to the console.
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });

  /**
   * One request to api.github.com, answered whatever its status but a person's 401. `as` says
   * whose credential `bearer` is.
   */
  async function request(
    as: "user" | "app",
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
  ): Promise<GithubAnswer> {
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
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (cause) {
      if (response.ok) {
        throw new UpstreamError("github", `${method} ${path} answered with no JSON`, { cause });
      }
    }
    return { status: response.status, body: parsed };
  }

  /** One call to api.github.com that must succeed: any other answer is an `UpstreamError`. */
  async function call(
    as: "user" | "app",
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
  ) {
    const answer = await request(as, method, path, bearer, body);
    if (answer.status < 200 || answer.status >= 300) {
      throw new UpstreamError("github", `${method} ${path} answered ${answer.status}`, {
        status: answer.status,
      });
    }
    return answer.body;
  }

  /** Every page of a list GitHub wraps as `{ total_count, [key]: [...] }`, up to `MAX_PAGES`. */
  async function listAll(
    as: "user" | "app",
    path: string,
    token: string,
    key: string,
  ): Promise<Listed<any>> {
    const items: any[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await call(as, "GET", `${path}?per_page=${PAGE_SIZE}&page=${page}`, token);
      const batch: any[] = body[key] ?? [];
      items.push(...batch);
      const total = typeof body.total_count === "number" ? body.total_count : null;
      if (batch.length < PAGE_SIZE || (total !== null && items.length >= total)) {
        return { items, complete: true };
      }
    }
    return { items, complete: false };
  }

  function appJwt(): Promise<string> {
    signingKey ??= createPrivateKey(privateKey);
    return signAppJwt({ clientId, privateKey: signingKey, now: clock.now() });
  }

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
   * without `members: read`.) It takes a login, and a login can change hands, so the answer is
   * taken only when the account it names is this person's: otherwise it is asked again under
   * the login their id has now.
   */
  async function askRepoPermission(
    installationId: number,
    repository: RepoPermissionQuery["repository"],
    user: RepoPermissionQuery["user"],
  ): Promise<RepoPermission> {
    const ask = (path: string) => getAsApp(installationId, repository.id, path);
    try {
      const asked = await permissionOf(ask, repository.fullName, user.login);
      if (asked?.userId === user.id) return asked.permission;
      const login = await loginOf(ask, user.id);
      if (login === null || login === user.login) return "none";
      const again = await permissionOf(ask, repository.fullName, login);
      return again?.userId === user.id ? again.permission : "none";
    } catch (error) {
      if (error instanceof NoInstallationToken) return "none";
      throw error;
    }
  }

  /** A GET as the App, with a `metadata: read` token for one repository. */
  function getAsApp(installationId: number, repositoryId: number, path: string) {
    return asApp({ installationId, repositoryId }, { metadata: "read" }, (token) =>
      call("app", "GET", path, token),
    );
  }

  /**
   * Work as the App in one repository, with a token for exactly `permissions` there. A token
   * GitHub stops taking before it runs out (the installation was suspended, or its permissions
   * changed) is dropped, and the work is tried once more with a new one.
   */
  async function asApp<T>(
    target: { installationId: number; repositoryId: number },
    permissions: AppPermissions,
    work: (token: string) => Promise<T>,
  ): Promise<T> {
    const key = `${target.installationId}:${target.repositoryId}:${JSON.stringify(permissions)}`;
    for (let attempt = 1; ; attempt++) {
      const token = await appToken(key, target, permissions);
      try {
        return await work(token);
      } catch (error) {
        if (attempt === 2 || !(error instanceof UpstreamError) || error.status !== 401) throw error;
        tokens.delete(key);
      }
    }
  }

  /** A token for one repository, reused while it has a while to run. */
  async function appToken(
    key: string,
    { installationId, repositoryId }: { installationId: number; repositoryId: number },
    permissions: AppPermissions,
  ): Promise<string> {
    const held = tokens.get(key);
    if (held && held.expiresAt.getTime() - TOKEN_REUSE_MARGIN_MS > clock.now()) return held.token;
    let minted: GithubInstallationToken;
    try {
      minted = await createInstallationToken({
        installationId,
        repositoryIds: [repositoryId],
        permissions: { ...permissions },
      });
    } catch (error) {
      // 404: the installation is gone. 422: the repository is not in it any more.
      if (error instanceof UpstreamError && (error.status === 404 || error.status === 422)) {
        throw new NoInstallationToken();
      }
      throw error;
    }
    tokens.delete(key);
    if (tokens.size >= TOKENS_KEPT) tokens.delete(tokens.keys().next().value!);
    tokens.set(key, minted);
    return minted.token;
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
      const listed = await listAll("user", "/user/installations", userToken, "installations");
      return { ...listed, items: listed.items.map(toInstallation) };
    },

    async listInstallationRepositories(userToken, installationId) {
      const path = `/user/installations/${installationId}/repositories`;
      const listed = await listAll("user", path, userToken, "repositories");
      return {
        ...listed,
        items: listed.items.map((repository) => ({
          ...toRepository(repository),
          canPush: repository.permissions?.push === true,
        })),
      };
    },

    async getOrgRole(userToken, org) {
      const path = `/user/memberships/orgs/${encodeURIComponent(org)}`;
      let membership: any;
      try {
        membership = await call("user", "GET", path, userToken);
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
      try {
        const path = `/app/installations/${installationId}`;
        return toInstallation(await call("app", "GET", path, await appJwt()));
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) return null;
        throw error;
      }
    },

    async listRepositoriesAsInstallation(installationToken) {
      const path = "/installation/repositories";
      const listed = await listAll("app", path, installationToken, "repositories");
      return { ...listed, items: listed.items.map(toRepository) };
    },

    async getAccountName(installationToken, login) {
      const path = `/users/${encodeURIComponent(login)}`;
      const account = await call("app", "GET", path, installationToken);
      return typeof account.name === "string" && account.name.trim() !== "" ? account.name : null;
    },

    ...createPullRequestCalls({
      request,
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
      const { data: repository } = await reading("repos.get", () =>
        octokit.rest.repos.get({ ...at(fullName), ...as(token) }),
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
      const { data } = await reading("git.getTree", () =>
        octokit.rest.git.getTree({ ...at(fullName), tree_sha: ref, recursive: "1", ...as(token) }),
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

    async getFileText(token, { fullName, path, ref, maxBytes }) {
      return fileOrNull(maxBytes, () =>
        reading("repos.getContent", () =>
          octokit.rest.repos.getContent({ ...at(fullName), path, ref, ...as(token) }),
        ),
      );
    },

    async getReadme(token, { fullName, ref, maxBytes }) {
      return fileOrNull(maxBytes, () =>
        reading("repos.getReadme", () =>
          octokit.rest.repos.getReadme({ ...at(fullName), ref, ...as(token) }),
        ),
      );
    },
  };

  /** The token on one call, or none for a public repository; and the call's time limit. */
  function as(token: string | null) {
    return {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      request: { signal: clock.timeout(TIMEOUT_MS) },
    };
  }
}

const at = (fullName: string) => {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
};

/** An Octokit call whose failure is an `UpstreamError` from `github`, with GitHub's status. */
async function reading<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    // Octokit's `RequestError` is an `HttpError`; one with no response never heard GitHub.
    const response = cause instanceof Error && cause.name === "HttpError" ? cause : null;
    const status =
      response && (response as { response?: unknown }).response
        ? (response as { status?: number }).status
        : undefined;
    throw new UpstreamError(
      "github",
      status === undefined ? `${what} did not answer` : `${what} answered ${status}`,
      { ...(status === undefined ? {} : { status }), cause },
    );
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

/** What GitHub answered: its status, and its body when it sent JSON. */
export interface GithubAnswer {
  status: number;
  body: any;
}

/** What an installation token may do, by GitHub's permission names. */
export type AppPermissions = Readonly<Record<string, "read" | "write">>;

/**
 * How a group of calls reaches GitHub: one request as anybody, or work as the App in one
 * repository with a token for exactly the permissions given.
 */
export interface GithubTransport {
  request(
    as: "user" | "app",
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
  ): Promise<GithubAnswer>;
  /** Throws 403 `forbidden` when the App cannot reach the repository at all. */
  asApp<T>(
    target: { installationId: number; repositoryId: number },
    permissions: AppPermissions,
    work: (token: string) => Promise<T>,
  ): Promise<T>;
}

/**
 * The App's own credential: a JWT good for a few minutes, signed with its private key and
 * backdated for clock drift. GitHub takes it only on `/app/…`.
 */
export function signAppJwt({
  clientId,
  privateKey,
  now,
}: {
  clientId: string;
  privateKey: KeyObject;
  /** Epoch milliseconds. */
  now: number;
}): Promise<string> {
  const seconds = Math.floor(now / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(clientId)
    .setIssuedAt(seconds - 60)
    .setExpirationTime(seconds + 540)
    .sign(privateKey);
}

function toInstallation(installation: any): GithubUserInstallation {
  return {
    id: installation.id,
    account: {
      id: installation.account.id,
      login: installation.account.login,
      type: installation.account.type === "Organization" ? "Organization" : "User",
      avatarUrl: installation.account.avatar_url ?? null,
    },
    repositorySelection: installation.repository_selection === "all" ? "all" : "selected",
    suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
  };
}

function toRepository(repository: any): GithubInstalledRepository {
  return {
    id: repository.id,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    private: repository.private === true,
    pushedAt: repository.pushed_at ? new Date(repository.pushed_at) : null,
  };
}

const PERMISSIONS: readonly RepoPermission[] = ["admin", "write", "read", "none"];

/** The App has no way into the repository any more, so nobody has access through it. */
class NoInstallationToken extends Error {}

type AskAsApp = (path: string) => Promise<any>;

/**
 * What GitHub says one login may do in a repository, and the id of the account it means. Null
 * when GitHub knows no such login, or the repository was renamed since it was last synced.
 */
async function permissionOf(
  ask: AskAsApp,
  fullName: string,
  login: string,
): Promise<{ userId: number | undefined; permission: RepoPermission } | null> {
  try {
    const body = await ask(
      `/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    const permission = PERMISSIONS.includes(body.permission) ? body.permission : "none";
    return { userId: body.user?.id, permission };
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) return null;
    throw error;
  }
}

/** The login a GitHub account has now (`GET /user/{id}` needs no permission), or null when it is gone. */
async function loginOf(ask: AskAsApp, userId: number): Promise<string | null> {
  try {
    const body = await ask(`/user/${userId}`);
    return typeof body.login === "string" ? body.login : null;
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) return null;
    throw error;
  }
}
