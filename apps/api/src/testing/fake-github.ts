import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Clock } from "@ponzu/sandbox";
import { jwtVerify } from "jose";
import type { Fetch } from "../deps/fetch.ts";

/*
 * GitHub, in memory, at the HTTP boundary: the API's real GitHub client talks to `fetch` here.
 * It keeps people, their emails, their user tokens, and the App's installations and
 * repositories, and it follows GitHub's rules for user tokens: an access token lasts eight
 * hours, a refresh token works once and is replaced, and a spent one is `bad_refresh_token`.
 */

export interface FakeGithubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  emails: { email: string; primary: boolean; verified: boolean }[];
}

export interface FakeRepository {
  id: number;
  fullName: string;
  defaultBranch?: string;
  private?: boolean;
  /** Who can reach it, by GitHub user id, and whether they can push. */
  access: Record<number, "read" | "write">;
}

export interface FakeInstallation {
  id: number;
  account: { id: number; login: string; type: "User" | "Organization" };
  repositorySelection: "all" | "selected";
  repositories: FakeRepository[];
}

export interface FakeTokenPair {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const ACCESS_TOKEN_SECONDS = 8 * 3600;
const REFRESH_TOKEN_SECONDS = 15_897_600;

// The App's key pair, as GitHub issues it: an RSA key whose private half is a PKCS#1 PEM.
let appKey: { publicKey: KeyObject; privateKey: KeyObject } | undefined;
const appKeyPair = () => {
  appKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 });
  return appKey;
};

export class FakeGithub {
  /** What `createGithub` is given in a test. */
  readonly credentials = {
    clientId: "Iv23fakeclientid",
    clientSecret: "fake_github_client_secret",
    get privateKey() {
      return appKeyPair().privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    },
  };

  readonly installations: FakeInstallation[] = [];
  /** How many times a refresh token was presented, accepted or not. */
  refreshAttempts = 0;
  /**
   * Runs inside each refresh, after GitHub has taken the request and before it answers: where
   * a test holds one caller in flight, or acts out something happening meanwhile.
   */
  duringRefresh: (() => Promise<void>) | null = null;
  /** Every installation token the App asked for. */
  readonly installationTokenRequests: { installationId: number; body: unknown }[] = [];
  /** Every question about a person's access to a repository, as `owner/name login`. */
  readonly permissionRequests: string[] = [];

  readonly #clock: Clock;
  readonly #users = new Map<number, FakeGithubUser>();
  readonly #accessTokens = new Map<string, { userId: number; expiresAt: number }>();
  readonly #refreshTokens = new Map<string, number>();
  readonly #installationTokens = new Map<
    string,
    { installationId: number; repositoryIds: number[] | null; expiresAt: number }
  >();
  readonly #failures: { path: string; status: number }[] = [];
  #next = 1;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  addUser(user: FakeGithubUser): FakeGithubUser {
    this.#users.set(user.id, user);
    return user;
  }

  /** A fresh user token pair, as a sign-in or a refresh gives. */
  issueTokens(userId: number): FakeTokenPair {
    const accessToken = `ghu_${this.#secret(36)}`;
    const refreshToken = `ghr_${this.#secret(76)}`;
    const expiresAt = this.#clock.now() + ACCESS_TOKEN_SECONDS * 1000;
    this.#accessTokens.set(accessToken, { userId, expiresAt });
    this.#refreshTokens.set(refreshToken, userId);
    return { accessToken, refreshToken, expiresAt };
  }

  /** Whether GitHub would still take this user access token. */
  accepts(accessToken: string): boolean {
    const token = this.#accessTokens.get(accessToken);
    return token !== undefined && token.expiresAt > this.#clock.now();
  }

  /** The person revoked the App: every token of theirs stops working. */
  revokeTokens(userId: number) {
    for (const [token, held] of this.#accessTokens)
      if (held.userId === userId) this.#accessTokens.delete(token);
    for (const [token, owner] of this.#refreshTokens)
      if (owner === userId) this.#refreshTokens.delete(token);
  }

  /** Every installation token stops working before it runs out, as when one is suspended. */
  revokeInstallationTokens() {
    this.#installationTokens.clear();
  }

  /** Makes the next request to `path` fail as if GitHub itself were broken. */
  failNext(path: string, status = 500) {
    this.#failures.push({ path, status });
  }

  /** Serves api.github.com and github.com. Pass it to `createGithub` as its `fetch`. */
  readonly fetch: Fetch = async (url, init = {}) => {
    const { hostname, pathname, searchParams } = new URL(url);
    const method = init.method ?? "GET";
    const failure = this.#failures.findIndex((queued) => queued.path === pathname);
    if (failure >= 0) {
      const { status } = this.#failures.splice(failure, 1)[0]!;
      return Response.json({ message: "Server Error" }, { status });
    }
    if (
      hostname === "github.com" &&
      method === "POST" &&
      pathname === "/login/oauth/access_token"
    ) {
      return this.#refresh(JSON.parse(String(init.body)));
    }
    if (hostname !== "api.github.com") return notFound(method, url);

    const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const appToken = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname);
    if (method === "POST" && appToken) {
      return this.#installationToken(bearer, Number(appToken[1]), JSON.parse(String(init.body)));
    }

    const permission = /^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/.exec(
      pathname,
    );
    if (method === "GET" && permission) {
      return this.#permission(bearer, permission[1]!, decodeURIComponent(permission[2]!));
    }
    const account = /^\/user\/(\d+)$/.exec(pathname);
    if (method === "GET" && account && this.#installationTokens.has(bearer)) {
      const user = this.#users.get(Number(account[1]));
      if (!user) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({ id: user.id, login: user.login, type: "User" });
    }

    const held = this.#accessTokens.get(bearer);
    if (!held || held.expiresAt <= this.#clock.now()) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const user = this.#users.get(held.userId)!;
    if (method !== "GET") return notFound(method, url);

    if (pathname === "/user") {
      return Response.json({
        id: user.id,
        login: user.login,
        name: user.name,
        avatar_url: user.avatarUrl,
        type: "User",
      });
    }
    if (pathname === "/user/emails") return Response.json(user.emails);
    if (pathname === "/user/installations") {
      const reachable = this.installations.filter((installation) =>
        this.#reaches(user, installation),
      );
      return Response.json({
        total_count: reachable.length,
        installations: page(reachable, searchParams).map((installation) => ({
          id: installation.id,
          account: { ...installation.account, avatar_url: null },
          repository_selection: installation.repositorySelection,
          suspended_at: null,
        })),
      });
    }
    const repositories = /^\/user\/installations\/(\d+)\/repositories$/.exec(pathname);
    if (repositories) {
      const installation = this.installations.find(({ id }) => id === Number(repositories[1]));
      if (!installation || !this.#reaches(user, installation)) return notFound(method, url);
      const reachable = installation.repositories.filter(
        (repository) => repository.access[user.id],
      );
      return Response.json({
        total_count: reachable.length,
        repositories: page(reachable, searchParams).map((repository) => ({
          id: repository.id,
          full_name: repository.fullName,
          default_branch: repository.defaultBranch ?? "main",
          private: repository.private ?? true,
          pushed_at: null,
          permissions: { pull: true, push: repository.access[user.id] === "write" },
        })),
      });
    }
    return notFound(method, url);
  };

  /** A person reaches an installation on their own account, or one with a repository they can see. */
  #reaches(user: FakeGithubUser, installation: FakeInstallation): boolean {
    return (
      installation.account.id === user.id ||
      installation.repositories.some((repository) => repository.access[user.id])
    );
  }

  async #refresh(body: Record<string, unknown>): Promise<Response> {
    const { clientId, clientSecret } = this.credentials;
    if (body.client_id !== clientId || body.client_secret !== clientSecret) {
      return Response.json({ error: "incorrect_client_credentials" });
    }
    this.refreshAttempts++;
    const userId = this.#refreshTokens.get(String(body.refresh_token));
    // Spent on arrival, whatever happens to the answer.
    this.#refreshTokens.delete(String(body.refresh_token));
    await this.duringRefresh?.();
    if (body.grant_type !== "refresh_token" || userId === undefined) {
      // GitHub says so with a 200.
      return Response.json({
        error: "bad_refresh_token",
        error_description: "The refresh token passed is incorrect or expired.",
      });
    }
    const tokens = this.issueTokens(userId);
    return Response.json({
      access_token: tokens.accessToken,
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: tokens.refreshToken,
      refresh_token_expires_in: REFRESH_TOKEN_SECONDS,
      token_type: "bearer",
      scope: "",
    });
  }

  async #installationToken(jwt: string, installationId: number, body: unknown): Promise<Response> {
    try {
      await jwtVerify(jwt, appKeyPair().publicKey, {
        issuer: this.credentials.clientId,
        algorithms: ["RS256"],
        currentDate: new Date(this.#clock.now()),
      });
    } catch {
      return Response.json({ message: "A JSON web token could not be decoded" }, { status: 401 });
    }
    const installation = this.installations.find(({ id }) => id === installationId);
    if (!installation) return Response.json({ message: "Not Found" }, { status: 404 });
    const { repository_ids: repositoryIds } = body as { repository_ids?: number[] };
    const outside = repositoryIds?.some(
      (repositoryId) => !installation.repositories.some(({ id }) => id === repositoryId),
    );
    if (outside) {
      return Response.json(
        { message: "There is at least one repository that does not exist or is not accessible" },
        { status: 422 },
      );
    }
    this.installationTokenRequests.push({ installationId, body });
    const token = `ghs_${this.#secret(36)}`;
    const expiresAt = this.#clock.now() + 3600_000;
    this.#installationTokens.set(token, {
      installationId,
      repositoryIds: repositoryIds ?? null,
      expiresAt,
    });
    return Response.json({ token, expires_at: new Date(expiresAt).toISOString() }, { status: 201 });
  }

  /**
   * `GET /repos/{owner}/{repo}/collaborators/{login}/permission`, asked with an installation
   * token that reaches the repository. A login GitHub does not know is a 404; someone it knows
   * without access is `none`.
   */
  #permission(bearer: string, fullName: string, login: string): Response {
    const token = this.#installationTokens.get(bearer);
    if (!token || token.expiresAt <= this.#clock.now()) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const installation = this.installations.find(({ id }) => id === token.installationId);
    const repository = installation?.repositories.find(
      (candidate) =>
        candidate.fullName === fullName &&
        (token.repositoryIds === null || token.repositoryIds.includes(candidate.id)),
    );
    if (!repository) return Response.json({ message: "Not Found" }, { status: 404 });
    const user = [...this.#users.values()].find((candidate) => candidate.login === login);
    if (!user) return Response.json({ message: "Not Found" }, { status: 404 });
    this.permissionRequests.push(`${fullName} ${login}`);
    const permission = repository.access[user.id] ?? "none";
    return Response.json({
      permission,
      role_name: permission,
      user: { id: user.id, login: user.login },
    });
  }

  #secret(length: number): string {
    return String(this.#next++).padStart(length, "0");
  }
}

function page<T>(items: T[], params: URLSearchParams): T[] {
  const size = Number(params.get("per_page") ?? 30);
  const start = (Number(params.get("page") ?? 1) - 1) * size;
  return items.slice(start, start + size);
}

function notFound(method: string, url: string): Response {
  return Response.json({ message: `The fake GitHub has no ${method} ${url}.` }, { status: 404 });
}
