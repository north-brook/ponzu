import { createHmac, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Clock } from "@ponzu/sandbox";
import { jwtVerify } from "jose";
import type { Fetch } from "../deps/fetch.ts";
import { APP_EVENTS, APP_PERMISSIONS } from "../ops/github-app.ts";
import { FakePullRequests, type FakeRepoAccess } from "./fake-pull-requests.ts";

/*
 * GitHub, in memory, at the HTTP boundary: the API's real GitHub client talks to `fetch` here.
 * It keeps people, their emails, their user tokens, and the App's installations and
 * repositories, and it follows GitHub's rules for user tokens: an access token lasts eight
 * hours, a refresh token works once and is replaced, and a spent one is `bad_refresh_token`.
 *
 * And what the spike recorded of the real one: a person's token lists only installations of
 * the App, and shows a membership only of an organization the App is installed on (an outside
 * collaborator reaches the installation and has none); a suspended installation is listed
 * but mints no token and lists no repositories (403); an installation token is long,
 * acts only as its installation and is refused on `/user`; lists come a page at a time.
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
  /** Private unless it says otherwise. */
  private?: boolean;
  /**
   * Who has explicit access to it, by GitHub user id, and whether they can push: all a
   * person's own token lists (GitHub's documented rule). On a public one anyone can read.
   */
  access: Record<number, "read" | "write">;
  /** When it was last pushed to. Never, unless it says. */
  pushedAt?: Date | null;
  /** What it says of itself on its page. */
  description?: string | null;
  topics?: string[];
  /**
   * Its files on the default branch, by path: what a token with `contents: read` reads. A
   * README among them at the top is the one its page shows.
   */
  files?: Record<string, string>;
}

export interface FakeInstallation {
  id: number;
  account: {
    id: number;
    login: string;
    type: "User" | "Organization";
    /** The display name GitHub shows. None by default. */
    name?: string | null;
    /** An organization's owners, by GitHub user id. */
    owners?: number[];
    /**
     * Its other members, by GitHub user id. Anyone else who reaches one of its repos is an
     * outside collaborator, and GitHub shows them no membership of the organization.
     */
    members?: number[];
  };
  repositorySelection: "all" | "selected";
  repositories: FakeRepository[];
  /** Set while the installation is suspended: GitHub then mints it no tokens. */
  suspendedAt?: Date | null;
  /**
   * False when the account's owner has not granted the App `members: read`: GitHub then
   * refuses (422) a token that asks for it. Granted unless it says.
   */
  grantsMembers?: boolean;
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
    webhookSecret: "fake_webhook_secret_fake_webhook_secret",
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
  /**
   * Every request to revoke a person's grant (`DELETE /applications/{client_id}/grant`), as it
   * arrived: the client id in its path, its authorization header and its body.
   */
  readonly grantRevocations: { clientId: string; authorization: string; body: unknown }[] = [];
  /** Runs inside each grant revoke, before GitHub answers: where a test looks at what is stored then. */
  duringGrantRevoke: (() => Promise<void>) | null = null;
  /** Every installation token the App asked for. */
  readonly installationTokenRequests: { installationId: number; body: unknown }[] = [];
  /** What the next installation tokens are granted in place of what was asked for, in order. */
  readonly grantNext: Record<string, string>[] = [];
  /** Every question about a person's access to a repository, as `owner/name login`. */
  readonly permissionRequests: string[] = [];
  /** Every read of a repository's contents, as `owner/name what`: `readme`, `contents/<path>`. */
  readonly contentRequests: string[] = [];
  /**
   * Every page of people the App asked for, as `org <login>` or `repo <owner/name>`: an
   * organization's members, or everyone with access to a repository.
   */
  readonly peopleRequests: string[] = [];
  /**
   * How many people GitHub puts on a page of them, whatever was asked for: a test makes it
   * small to have a list run past the pages the API reads.
   */
  peoplePageSize = 100;

  /**
   * The App as `GET /app` and `GET /app/hook/config` answer: by default exactly what the API
   * needs, at the test app's slug and address. A test changes it to act out an App set up wrong.
   */
  readonly app = {
    slug: "ponzu-test",
    permissions: { ...APP_PERMISSIONS } as Record<string, string>,
    events: [...APP_EVENTS],
    hook: {
      url: "https://api.test/v1/github/webhook" as string | null,
      content_type: "json" as string | null,
      insecure_ssl: "0" as string | null,
    },
  };

  readonly #clock: Clock;
  readonly #users = new Map<number, FakeGithubUser>();
  readonly #accessTokens = new Map<string, { userId: number; expiresAt: number }>();
  readonly #refreshTokens = new Map<string, number>();
  /** Each installation token the App was given: the installation it acts in, and for what. */
  readonly #installationTokens = new Map<string, InstallationToken>();
  readonly #failures: { path: string; status: number }[] = [];
  readonly #holds: { path: string; arrived: () => void; released: Promise<void> }[] = [];
  #next = 1;

  /** The branches and pull requests of every repository. */
  readonly pulls: FakePullRequests;

  constructor(clock: Clock) {
    this.#clock = clock;
    this.pulls = new FakePullRequests(
      clock,
      (login) => [...this.#users.values()].find((user) => user.login === login)?.id,
    );
  }

  /** A repository of any installation, as the branch and pull request calls reach it. */
  repo(fullName: string): FakeRepoAccess | undefined {
    for (const installation of this.installations) {
      const repository = installation.repositories.find((repo) => repo.fullName === fullName);
      if (repository) {
        return {
          id: repository.id,
          fullName,
          installationId: installation.id,
          defaultBranch: repository.defaultBranch ?? "main",
          canPush: (userId) => repository.access[userId] === "write",
        };
      }
    }
    return undefined;
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

  /** Forgets the failures `failNext` queued that no request has met yet. */
  clearFailures() {
    this.#failures.length = 0;
  }

  /**
   * Holds the answer to the next request to `path` on its way back: GitHub answers it as
   * things are when it arrives, `reached` settles, and the caller has the answer only after
   * `release()`. Where a test makes something happen while a caller is acting on old news.
   */
  holdNext(path: string): { reached: Promise<void>; release: () => void } {
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#holds.push({ path, arrived, released });
    return { reached, release };
  }

  /**
   * A webhook delivery as GitHub sends one: the body, and headers that name the event and the
   * delivery and sign the body with the App's webhook secret. Post it to the webhook route.
   */
  delivery(
    event: string,
    payload: unknown,
    {
      id = crypto.randomUUID() as string,
      secret = this.credentials.webhookSecret,
    }: { id?: string; secret?: string } = {},
  ): { method: "POST"; headers: Record<string, string>; body: string } {
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "GitHub-Hookshot/fake",
        "x-github-event": event,
        "x-github-delivery": id,
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    };
  }

  /** Serves api.github.com and github.com. Pass it to `createGithub` as its `fetch`. */
  readonly fetch: Fetch = async (url, init = {}) => {
    const answer = await this.#serve(url, init);
    // A fetched response says where it came from; Octokit's paginator reads it.
    Object.defineProperty(answer, "url", { value: url });
    const hold = this.#holds.findIndex((queued) => queued.path === new URL(url).pathname);
    if (hold >= 0) {
      const { arrived, released } = this.#holds.splice(hold, 1)[0]!;
      arrived();
      await released;
    }
    return answer;
  };

  async #serve(url: string, init: RequestInit): Promise<Response> {
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

    const grant = /^\/applications\/([^/]+)\/grant$/.exec(pathname);
    if (method === "DELETE" && grant) {
      return this.#deleteGrant(decodeURIComponent(grant[1]!), init);
    }

    // GitHub reads the scheme in any case.
    const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /i, "") ?? "";
    const appToken = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname);
    if (method === "POST" && appToken) {
      // A token for everything the installation has is asked for with no body at all.
      const body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
      return this.#installationToken(bearer, Number(appToken[1]), body);
    }
    if (method === "GET" && pathname === "/app") {
      if (!(await this.#isAppJwt(bearer))) return badJwt();
      const { slug, permissions, events } = this.app;
      return Response.json({
        id: 1,
        slug,
        client_id: this.credentials.clientId,
        permissions,
        events,
      });
    }
    if (method === "GET" && pathname === "/app/hook/config") {
      if (!(await this.#isAppJwt(bearer))) return badJwt();
      return Response.json(this.app.hook);
    }
    const appInstallation = /^\/app\/installations\/(\d+)$/.exec(pathname);
    if (method === "GET" && appInstallation) {
      if (!(await this.#isAppJwt(bearer))) return badJwt();
      const installation = this.#installation(Number(appInstallation[1]));
      return installation ? Response.json(installationJson(installation)) : notFound(method, url);
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const find = (fullName: string) => this.repo(fullName);
    const asInstallation = this.#installationTokens.get(bearer);
    if (asInstallation !== undefined) {
      if (asInstallation.expiresAt <= this.#clock.now()) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      if (method === "POST" && pathname === "/graphql") {
        const people = this.#people(asInstallation, body);
        if (people) return people;
      }
      const caller = { kind: "app" as const, ...asInstallation };
      const pulled = this.pulls.serve(caller, method, new URL(url), body, find);
      return pulled ?? this.#serveInstallation(asInstallation, method, url);
    }

    const held = this.#accessTokens.get(bearer);
    if (!held || held.expiresAt <= this.#clock.now()) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const user = this.#users.get(held.userId)!;
    const caller = { kind: "user" as const, id: user.id, login: user.login };
    const pulled = this.pulls.serve(caller, method, new URL(url), body, find);
    if (pulled) return pulled;
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
      return paged(url, reachable.length, {
        total_count: reachable.length,
        installations: page(reachable, searchParams).map(installationJson),
      });
    }
    const repositories = /^\/user\/installations\/(\d+)\/repositories$/.exec(pathname);
    if (repositories) {
      const installation = this.#installation(Number(repositories[1]));
      if (!installation || !this.#reaches(user, installation)) return notFound(method, url);
      if (installation.suspendedAt) return suspended();
      const reachable = installation.repositories.filter((repository) =>
        given(installation, repository, user.id),
      );
      return paged(url, reachable.length, {
        total_count: reachable.length,
        repositories: page(reachable, searchParams).map((repository) => ({
          id: repository.id,
          full_name: repository.fullName,
          default_branch: repository.defaultBranch ?? "main",
          private: repository.private ?? true,
          pushed_at: repository.pushedAt?.toISOString() ?? null,
          permissions: {
            pull: true,
            push: given(installation, repository, user.id) === "write",
          },
        })),
      });
    }
    const orgMembership = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(pathname);
    if (orgMembership) {
      // GitHub shows a person their membership only of organizations the App is installed on.
      const org = this.installations.find(
        ({ account }) => account.type === "Organization" && account.login === orgMembership[1],
      );
      if (!org || !this.#reaches(user, org)) return notFound(method, url);
      const role = org.account.owners?.includes(user.id)
        ? "admin"
        : org.account.members?.includes(user.id)
          ? "member"
          : null;
      if (!role) return notFound(method, url);
      return Response.json({ state: "active", role, organization: { login: org.account.login } });
    }
    return this.#serveAnyone(method, url) ?? notFound(method, url);
  }

  /** What an installation token can ask for, as the installation it was minted in. */
  #serveInstallation(token: InstallationToken, method: string, url: string): Response {
    const { pathname, searchParams } = new URL(url);
    const installation = this.#installation(token.installationId);
    if (!installation) return Response.json({ message: "Bad credentials" }, { status: 401 });
    const repositories = installation.repositories.filter(
      ({ id }) => token.repositoryIds === null || token.repositoryIds.includes(id),
    );
    if (method === "GET" && pathname === "/installation/repositories") {
      return paged(url, repositories.length, {
        total_count: repositories.length,
        repository_selection: installation.repositorySelection,
        repositories: page(repositories, searchParams).map(repositoryJson),
      });
    }
    const permission = /^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/.exec(
      pathname,
    );
    if (method === "GET" && permission) {
      return this.#permission(
        installation,
        repositories,
        permission[1]!,
        decodeURIComponent(permission[2]!),
      );
    }
    // A repository by id, for a token that reaches it.
    const byId = /^\/repositories\/(\d+)$/.exec(pathname);
    if (method === "GET" && byId) {
      const repository = repositories.find(({ id }) => id === Number(byId[1]));
      if (!repository) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json(repositoryJson(repository));
    }
    const contents = this.#serveContents(token, repositories, method, url);
    if (contents) return contents;
    // An account by id needs no permission at all.
    const account = /^\/user\/(\d+)$/.exec(pathname);
    if (method === "GET" && account) {
      const user = this.#users.get(Number(account[1]));
      if (!user) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({ id: user.id, login: user.login, type: "User" });
    }
    // An installation token cannot act as a person.
    if (pathname === "/user" || pathname.startsWith("/user/")) {
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    }
    return this.#serveAnyone(method, url) ?? notFound(method, url);
  }

  /**
   * A repository's page, its tree and its files, for a token that reaches it: its metadata
   * with any permission, its contents only with `contents`. Null for any other path.
   */
  #serveContents(
    token: InstallationToken,
    reachable: FakeRepository[],
    method: string,
    url: string,
  ): Response | null {
    const { pathname, searchParams } = new URL(url);
    const match = /^\/repos\/([^/]+\/[^/]+)(?:\/(git\/trees\/[^/]+|readme|contents\/.+))?$/.exec(
      pathname,
    );
    if (method !== "GET" || !match) return null;
    const repository = reachable.find((candidate) => candidate.fullName === match[1]);
    if (!repository) return Response.json({ message: "Not Found" }, { status: 404 });
    const part = match[2];
    if (part === undefined) {
      return Response.json({
        ...repositoryJson(repository),
        description: repository.description ?? null,
        topics: repository.topics ?? [],
        homepage: null,
        language: null,
        archived: false,
      });
    }
    if (!token.permissions?.contents) {
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    }
    this.contentRequests.push(`${repository.fullName} ${part}`);
    const files = repository.files ?? {};
    if (part.startsWith("git/trees/")) {
      if (searchParams.get("recursive") !== "1") return notFound(method, url);
      const folders = new Set(
        Object.keys(files).flatMap((path) =>
          path
            .split("/")
            .slice(0, -1)
            .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
        ),
      );
      return Response.json({
        sha: "0".repeat(40),
        tree: [
          ...[...folders].map((path) => ({ path, mode: "040000", type: "tree" })),
          ...Object.entries(files).map(([path, text]) => ({
            path,
            mode: "100644",
            type: "blob",
            size: new TextEncoder().encode(text).byteLength,
          })),
        ],
        truncated: false,
      });
    }
    const path =
      part === "readme"
        ? Object.keys(files).find((candidate) => /^readme(\.[a-z]+)?$/i.test(candidate))
        : decodeURIComponent(part.slice("contents/".length));
    const text = path === undefined ? undefined : files[path];
    if (text === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
    // GitHub's JSON form: the content in base64 up to 1 MB, left out past that.
    const bytes = Buffer.from(text);
    const large = bytes.byteLength > 1024 * 1024;
    return Response.json({
      type: "file",
      path,
      size: bytes.byteLength,
      encoding: large ? "none" : "base64",
      content: large ? "" : bytes.toString("base64"),
    });
  }

  /** What any token may read: an account's public profile. */
  #serveAnyone(method: string, url: string): Response | null {
    const login = /^\/users\/([^/]+)$/.exec(new URL(url).pathname)?.[1];
    if (method !== "GET" || !login) return null;
    const person = [...this.#users.values()].find((user) => user.login === login);
    if (person) {
      return Response.json({ id: person.id, login, name: person.name, type: "User" });
    }
    const account = this.installations.find(
      (installation) => installation.account.login === login,
    )?.account;
    if (!account) return notFound(method, url);
    return Response.json({ id: account.id, login, name: account.name ?? null, type: account.type });
  }

  #installation(id: number): FakeInstallation | undefined {
    return this.installations.find((installation) => installation.id === id);
  }

  async #isAppJwt(jwt: string): Promise<boolean> {
    try {
      await jwtVerify(jwt, appKeyPair().publicKey, {
        issuer: this.credentials.clientId,
        algorithms: ["RS256"],
        currentDate: new Date(this.#clock.now()),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** A person reaches an installation on their own account, or one with a repository they can see. */
  #reaches(user: FakeGithubUser, installation: FakeInstallation): boolean {
    return (
      installation.account.id === user.id ||
      installation.repositories.some((repository) => given(installation, repository, user.id))
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

  /**
   * `DELETE /applications/{client_id}/grant`, as GitHub documents it: the App's client id and
   * secret as Basic auth, the person's token in the body, 204 and every token of theirs dead.
   * A token GitHub does not know is 404; client credentials it does not take are 404 too (its
   * answer for a wrong id), or 401 for a right id with a wrong secret.
   */
  async #deleteGrant(clientId: string, init: RequestInit): Promise<Response> {
    const authorization = new Headers(init.headers).get("authorization") ?? "";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    this.grantRevocations.push({ clientId, authorization, body });
    await this.duringGrantRevoke?.();
    const { clientId: id, clientSecret: secret } = this.credentials;
    if (clientId !== id) return Response.json({ message: "Not Found" }, { status: 404 });
    if (!/^basic /i.test(authorization) || atob(authorization.slice(6)) !== `${id}:${secret}`) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const held = this.#accessTokens.get(String(body?.access_token));
    if (!held) return Response.json({ message: "Not Found" }, { status: 404 });
    this.revokeTokens(held.userId);
    return new Response(null, { status: 204 });
  }

  async #installationToken(jwt: string, installationId: number, body: unknown): Promise<Response> {
    if (!(await this.#isAppJwt(jwt))) return badJwt();
    const installation = this.#installation(installationId);
    if (!installation) return Response.json({ message: "Not Found" }, { status: 404 });
    if (installation.suspendedAt) return suspended();
    const { repository_ids: repositoryIds, permissions = {} } = body as {
      repository_ids?: number[];
      permissions?: Record<string, string>;
    };
    if (permissions.members && installation.grantsMembers === false) {
      return Response.json(
        { message: "The permissions requested are not granted to this installation." },
        { status: 422 },
      );
    }
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
    // A token GitHub grants less than was asked for, as a test says.
    const granted = this.grantNext.shift() ?? permissions;
    // Shaped like GitHub's today, which are far longer than the 40 characters they once were.
    const token = `ghs_${this.#secret(380)}`;
    const expiresAt = this.#clock.now() + 3600_000;
    this.#installationTokens.set(token, {
      installationId,
      repositoryIds: repositoryIds ?? null,
      permissions: granted,
      expiresAt,
    });
    // As GitHub answers: what the token may do, and the repositories it was narrowed to.
    const repositories = repositoryIds
      ? installation.repositories.filter(({ id }) => repositoryIds.includes(id))
      : null;
    return Response.json(
      {
        token,
        expires_at: new Date(expiresAt).toISOString(),
        permissions: granted,
        repository_selection: repositories ? "selected" : "all",
        ...(repositories
          ? {
              repositories: repositories.map(({ id, fullName }) => ({
                id,
                name: fullName.split("/")[1],
                full_name: fullName,
              })),
            }
          : {}),
      },
      { status: 201 },
    );
  }

  /**
   * `GET /repos/{owner}/{repo}/collaborators/{login}/permission`, asked with an installation
   * token that reaches the repository. A login GitHub does not know is a 404; someone it knows
   * without access is `none`, or `read` on a public repository, which anyone can read.
   */
  #permission(
    installation: FakeInstallation,
    reachable: FakeRepository[],
    fullName: string,
    login: string,
  ): Response {
    const repository = reachable.find((candidate) => candidate.fullName === fullName);
    if (!repository) return Response.json({ message: "Not Found" }, { status: 404 });
    const user = [...this.#users.values()].find((candidate) => candidate.login === login);
    if (!user) return Response.json({ message: "Not Found" }, { status: 404 });
    this.permissionRequests.push(`${fullName} ${login}`);
    // Anyone may read a public repository, collaborator or not: GitHub answers `read` for them.
    const permission =
      given(installation, repository, user.id) ?? (repository.private === false ? "read" : "none");
    return Response.json({
      permission,
      role_name: permission,
      user: { id: user.id, login: user.login },
    });
  }

  /**
   * The two GraphQL lists of people the App reads with an installation token, a page at a
   * time: an organization's members with their roles (it takes `members: read`), and everyone
   * with access to a repository with what they may do there: its explicit collaborators, and,
   * as GitHub counts them, the organization's owners or the personal account's person as
   * admins. Null for any other operation.
   */
  #people(token: InstallationToken, body: unknown): Response | null {
    const { query, variables } = body as { query: string; variables: Record<string, any> };
    const operation = /^\s*query\s+(\w+)/.exec(query)?.[1];
    if (
      operation !== "InstallationOrganizationPeople" &&
      operation !== "InstallationRepositoryPeople"
    ) {
      return null;
    }
    const installation = this.#installation(token.installationId)!;
    const error = (type: string, message: string) =>
      Response.json({ data: null, errors: [{ type, message }] });
    const node = (id: number) => {
      const user = this.#users.get(id);
      return user
        ? { databaseId: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl }
        : null;
    };
    const pageOf = <T>(edges: T[]) => {
      const start = Number(variables.after ?? 0);
      const end = start + this.peoplePageSize;
      return {
        pageInfo: { hasNextPage: end < edges.length, endCursor: String(end) },
        edges: edges.slice(start, end),
      };
    };
    const { account } = installation;

    if (operation === "InstallationOrganizationPeople") {
      if (account.type !== "Organization" || account.login !== variables.login) {
        return error("NOT_FOUND", "Could not resolve to an Organization.");
      }
      if (!token.permissions.members) {
        return error("FORBIDDEN", "Resource not accessible by integration");
      }
      this.peopleRequests.push(`org ${account.login}`);
      const roles = [
        ...(account.owners ?? []).map((id) => ({ id, role: "ADMIN" })),
        ...(account.members ?? []).map((id) => ({ id, role: "MEMBER" })),
      ];
      const edges = roles.flatMap(({ id, role }) => {
        const person = node(id);
        return person ? [{ role, node: person }] : [];
      });
      return Response.json({ data: { organization: { membersWithRole: pageOf(edges) } } });
    }

    const fullName = `${variables.owner}/${variables.name}`;
    const repository = installation.repositories.find(
      (repo) =>
        repo.fullName === fullName &&
        (token.repositoryIds === null || token.repositoryIds.includes(repo.id)),
    );
    if (!repository) return error("NOT_FOUND", "Could not resolve to a Repository.");
    this.peopleRequests.push(`repo ${fullName}`);
    const admins = account.type === "Organization" ? (account.owners ?? []) : [account.id];
    const permissions = new Map<number, string>(
      Object.entries(repository.access).map(([id, access]) => [
        Number(id),
        access === "write" ? "WRITE" : "READ",
      ]),
    );
    for (const id of admins) permissions.set(id, "ADMIN");
    const edges = [...permissions].flatMap(([id, permission]) => {
      const person = node(id);
      return person ? [{ permission, node: person }] : [];
    });
    return Response.json({ data: { repository: { collaborators: pageOf(edges) } } });
  }

  #secret(length: number): string {
    return String(this.#next++).padStart(length, "0");
  }
}

interface InstallationToken {
  installationId: number;
  /** The repositories it was narrowed to; null for every one the installation has. */
  repositoryIds: number[] | null;
  /** What it may do, as it was asked for; none asked for is nothing. */
  permissions: Record<string, string>;
  /** Epoch milliseconds. */
  expiresAt: number;
}

function page<T>(items: T[], params: URLSearchParams): T[] {
  const size = Number(params.get("per_page") ?? 30);
  const start = (Number(params.get("page") ?? 1) - 1) * size;
  return items.slice(start, start + size);
}

/** One page of a list of `total`, with GitHub's `Link` to the next page while there is one. */
/**
 * What GitHub has given a person in a repository: what its `access` says, and otherwise push
 * for the personal account that owns it and for an owner of the organization that does (GitHub
 * gives an organization's owners admin on every repository of it). Undefined: nothing, though
 * anyone may still read it if it is public.
 */
function given(
  installation: FakeInstallation,
  repository: FakeRepository,
  userId: number,
): "read" | "write" | undefined {
  const explicit = repository.access[userId];
  if (explicit) return explicit;
  const { account } = installation;
  if (account.id === userId || account.owners?.includes(userId)) return "write";
  return undefined;
}

function paged(url: string, total: number, body: unknown): Response {
  const next = new URL(url);
  const size = Number(next.searchParams.get("per_page") ?? 30);
  const number = Number(next.searchParams.get("page") ?? 1);
  if (number * size >= total) return Response.json(body);
  next.searchParams.set("page", String(number + 1));
  return Response.json(body, { headers: { link: `<${next}>; rel="next"` } });
}

function installationJson(installation: FakeInstallation) {
  const { name: _name, owners: _owners, ...account } = installation.account;
  return {
    id: installation.id,
    account: { ...account, avatar_url: null },
    repository_selection: installation.repositorySelection,
    suspended_at: installation.suspendedAt?.toISOString() ?? null,
  };
}

function repositoryJson(repository: FakeRepository) {
  return {
    id: repository.id,
    full_name: repository.fullName,
    default_branch: repository.defaultBranch ?? "main",
    private: repository.private ?? true,
    pushed_at: repository.pushedAt?.toISOString() ?? null,
  };
}

function badJwt(): Response {
  return Response.json({ message: "A JSON web token could not be decoded" }, { status: 401 });
}

function suspended(): Response {
  return Response.json({ message: "This installation has been suspended" }, { status: 403 });
}

function notFound(method: string, url: string): Response {
  return Response.json({ message: `The fake GitHub has no ${method} ${url}.` }, { status: 404 });
}
