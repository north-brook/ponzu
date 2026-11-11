import { createPrivateKey, type KeyObject } from "node:crypto";
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
export interface Github {
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
   * token narrowed to it (`contents: read`), or with none for a public one. Each read stops at
   * `maxBytes` of GitHub's answer, however large the thing is.
   */
  /** What a repository says of itself. */
  getRepositoryAbout(token: string | null, fullName: string): Promise<GithubRepositoryAbout>;
  /** Every path in the repository at `ref` (a branch or a commit), as far as `maxBytes` reaches. */
  getTree(
    token: string | null,
    input: { fullName: string; ref: string; maxBytes: number },
  ): Promise<GithubTree>;
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
  /** False when GitHub cut the list short, or it was longer than `maxBytes`. */
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

  /**
   * A GET as the App, with a `metadata: read` token for one repository. A token GitHub stops
   * taking before it runs out (the installation was suspended, or its permissions changed) is
   * dropped, and one more is minted.
   */
  async function getAsApp(installationId: number, repositoryId: number, path: string) {
    const key = `${installationId}:${repositoryId}`;
    for (let attempt = 1; ; attempt++) {
      const token = await metadataToken(key, installationId, repositoryId);
      try {
        return await call("app", "GET", path, token);
      } catch (error) {
        if (attempt === 2 || !(error instanceof UpstreamError) || error.status !== 401) throw error;
        tokens.delete(key);
      }
    }
  }

  /** A `metadata: read` token for one repository, reused while it has a while to run. */
  async function metadataToken(
    key: string,
    installationId: number,
    repositoryId: number,
  ): Promise<string> {
    const held = tokens.get(key);
    if (held && held.expiresAt.getTime() - TOKEN_REUSE_MARGIN_MS > clock.now()) return held.token;
    let minted: GithubInstallationToken;
    try {
      minted = await createInstallationToken({
        installationId,
        repositoryIds: [repositoryId],
        permissions: { metadata: "read" },
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

    async getRepositoryAbout(token, fullName) {
      const { text } = await read(token, `/repos/${fullName}`, JSON_TYPE, ABOUT_MAX_BYTES);
      const repository = JSON.parse(text);
      return {
        description: stringOrNull(repository.description),
        topics: Array.isArray(repository.topics)
          ? repository.topics.filter((topic: unknown) => typeof topic === "string")
          : [],
        homepage: stringOrNull(repository.homepage),
        language: stringOrNull(repository.language),
        defaultBranch: repository.default_branch,
        archived: repository.archived === true,
      };
    },

    async getTree(token, { fullName, ref, maxBytes }) {
      const path = `/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
      const { text, complete } = await read(token, path, JSON_TYPE, maxBytes);
      return parseTree(text, complete);
    },

    async getFileText(token, { fullName, path, ref, maxBytes }) {
      const at = `/repos/${fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
      return readOrNull(token, `${at}?ref=${encodeURIComponent(ref)}`, maxBytes);
    },

    async getReadme(token, { fullName, ref, maxBytes }) {
      return readOrNull(
        token,
        `/repos/${fullName}/readme?ref=${encodeURIComponent(ref)}`,
        maxBytes,
      );
    },
  };

  /** A file as it is, or null when GitHub has none there. */
  async function readOrNull(token: string | null, path: string, maxBytes: number) {
    try {
      return (await read(token, path, RAW_TYPE, maxBytes)).text;
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * A GET to api.github.com read to at most `maxBytes`: what a contents read takes, since a
   * file or a tree can be far larger than anything worth holding. The rest is never fetched.
   */
  async function read(
    token: string | null,
    path: string,
    accept: string,
    maxBytes: number,
  ): Promise<{ text: string; complete: boolean }> {
    let response: Response;
    try {
      response = await fetch(`${API_URL}${path}`, {
        headers: {
          accept,
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          "x-github-api-version": "2022-11-28",
          "user-agent": "ponzu-api",
        },
        signal: clock.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new UpstreamError("github", `GET ${path.split("?")[0]} did not answer`, { cause });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError("github", `GET ${path.split("?")[0]} answered ${response.status}`, {
        status: response.status,
      });
    }
    try {
      return await readCapped(response, maxBytes);
    } catch (cause) {
      throw new UpstreamError("github", `GET ${path.split("?")[0]} broke off`, { cause });
    }
  }
}

const JSON_TYPE = "application/vnd.github+json";
const RAW_TYPE = "application/vnd.github.raw+json";
/** A repository's own JSON is a few kilobytes; this is far more than it ever is. */
const ABOUT_MAX_BYTES = 256 * 1024;

const stringOrNull = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** At most `maxBytes` of a response's body as text, and whether that was all of it. */
export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; complete: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", complete: true };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      complete = false;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // A cut can fall inside a character: what is left of it decodes as U+FFFD.
  return { text: new TextDecoder().decode(bytes), complete };
}

/**
 * GitHub's tree, `{ tree: [{ path, type, size, … }], truncated }`, from all of its JSON or the
 * start of it: its entries are flat objects, so those that arrived whole are read one by one.
 */
function parseTree(text: string, whole: boolean): GithubTree {
  let raw: any[];
  let complete = whole;
  if (whole) {
    const body = JSON.parse(text);
    raw = Array.isArray(body.tree) ? body.tree : [];
    complete = body.truncated !== true;
  } else {
    raw = [];
    for (const match of text.matchAll(/\{[^{}]*\}/g)) {
      try {
        raw.push(JSON.parse(match[0]));
      } catch {
        // The last one, cut off.
      }
    }
  }
  return {
    entries: raw.flatMap((entry) =>
      typeof entry?.path === "string" && (entry.type === "blob" || entry.type === "tree")
        ? [
            {
              path: entry.path,
              type: entry.type,
              size: typeof entry.size === "number" ? entry.size : null,
            },
          ]
        : [],
    ),
    complete,
  };
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
