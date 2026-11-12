import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { GraphqlResponseError } from "@octokit/graphql";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { RequestError } from "@octokit/request-error";
import type { Clock } from "@ponzu/sandbox";
import githubAppJwt from "universal-github-app-jwt";
import { ApiError, UpstreamError } from "../http/errors.ts";
import type { Fetch } from "./fetch.ts";
import type { Github, GithubInstallationToken } from "./github.ts";

/*
 * How the API reaches GitHub: Octokit on the API's own fetch and clock, so a test serves every
 * call from memory and moves time by hand. `@octokit/core` with pagination, `@octokit/auth-app`
 * for the App's JWTs and installation tokens, and `@octokit/graphql` (core's `graphql`).
 *
 * Octokit's retry and throttling plugins are deliberately not loaded: a retry inside a person's
 * request changes its timing, and GitHub's answer to a write that was sent twice. A failure,
 * a rate limit included, reaches the caller as it did before: an `UpstreamError` with
 * GitHub's status, or what the caller makes of that status.
 */

/** Core with the pagination plugin: `octokit.paginate`, `octokit.request`, `octokit.graphql`. */
const GithubOctokit = Octokit.plugin(paginateRest);
export type GithubOctokit = InstanceType<typeof GithubOctokit>;

/** Whose credential a call carries, which decides what GitHub's 401 means. */
export type Caller = "user" | "app";

/** Every call to GitHub has this long to answer. */
const TIMEOUT_MS = 10_000;
const API_VERSION = "2022-11-28";
/** Its default log writes warnings (a deprecated endpoint) to the console. */
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

export function createOctokit({ fetch, clock }: { fetch: Fetch; clock: Clock }): GithubOctokit {
  const octokit = new GithubOctokit({
    userAgent: "ponzu-api",
    request: {
      fetch: ((url: string, init?: RequestInit) =>
        wholeAnswer(fetch, url, {
          ...init,
          signal: clock.timeout(TIMEOUT_MS),
        })) as typeof globalThis.fetch,
    },
    log: SILENT,
  });
  octokit.hook.before("request", (options) => {
    options.headers["x-github-api-version"] = API_VERSION;
  });
  return octokit;
}

/** A 2xx from GitHub whose body is not the JSON it promised. */
class NotJson extends Error {}

/** Statuses that carry no body. */
const BODILESS = new Set([204, 205, 304]);

/**
 * GitHub's answer, read in full before Octokit sees it. Octokit takes a body it fails to read,
 * or one that is not JSON, for an empty success, and its paginator then for an empty, complete
 * list: a sync would drop every membership and repository it no longer saw. Here a body cut off
 * by the timeout or a dropped connection throws, as no answer at all, and a 2xx that is not
 * JSON throws `NotJson`.
 */
async function wholeAnswer(fetch: Fetch, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  let bytes: ArrayBuffer;
  try {
    response = await fetch(url, init);
    bytes = await response.arrayBuffer();
  } catch (cause) {
    // Plain, so Octokit wraps it as no answer; it rethrows an AbortError as it is.
    throw new Error("GitHub's answer did not arrive in full", { cause });
  }
  if (response.ok && !BODILESS.has(response.status) && !isJson(bytes, response.headers)) {
    throw new NotJson(`answered ${response.status} with no JSON`);
  }
  const whole = new Response(BODILESS.has(response.status) ? null : bytes, response);
  // The paginator tells a real page from its 409 stand-in by its url.
  Object.defineProperty(whole, "url", { value: response.url });
  return whole;
}

/** JSON, or no body where none was promised (no JSON content type). */
function isJson(bytes: ArrayBuffer, headers: Headers): boolean {
  if (bytes.byteLength === 0) return !/json/i.test(headers.get("content-type") ?? "");
  try {
    JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}

/** The header that makes one call as whoever holds `token`. */
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * A list's parameters with `token` on every page. The paginator sends `headers` as `request`
 * does, but its types leave them out.
 */
export function pagedAs<P extends object>(token: string, params: P): P {
  return { ...params, headers: bearer(token) };
}

/**
 * A GitHub id as a number. Octokit reads integers past 2^53 as bigints; GitHub's account,
 * installation and repository ids are far below that, and were always read as numbers.
 */
export const idOf = (id: number | bigint) => Number(id);

/** `owner/name` as Octokit's route parameters. */
export function repoParams(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf("/");
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

/**
 * What a failed Octokit call is to the rest of the API: a person's 401 is
 * `github_reauth_required`, any other answer an `UpstreamError` with GitHub's status, and no
 * answer an `UpstreamError` without one.
 *
 * Ours, not Octokit's: these are the API's stable codes, which clients branch on.
 */
export function githubFailure(caller: Caller, error: unknown): unknown {
  if (!(error instanceof RequestError)) return error;
  const { method, url } = error.request;
  const what = `${method} ${new URL(url).pathname}`;
  if (error.cause instanceof NotJson) {
    return new UpstreamError("github", `${what} ${error.cause.message}`, { cause: error });
  }
  if (!error.response) {
    return new UpstreamError("github", `${what} did not answer`, { cause: error });
  }
  if (error.status === 401 && caller === "user") {
    // The token ran out early or the person revoked the App: only signing in again mends it.
    return new ApiError(401, "github_reauth_required", "Sign in again to reconnect GitHub.");
  }
  return new UpstreamError("github", `${what} answered ${error.status}`, { status: error.status });
}

/** One Octokit call, failing as `githubFailure` says. */
export async function send<T>(caller: Caller, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw githubFailure(caller, error);
  }
}

/** What GitHub answered: its status, and its body. */
export interface GithubAnswer {
  status: number;
  body: any;
}

/**
 * One Octokit call whose every answer means something to the caller: GitHub's status and body,
 * whatever the status. Only a person's 401 and no answer at all are thrown, as `send` throws them.
 */
export async function answer(
  caller: Caller,
  call: () => Promise<{ status: number; data: unknown }>,
): Promise<GithubAnswer> {
  try {
    const { status, data } = await call();
    return { status, body: data };
  } catch (error) {
    if (
      error instanceof RequestError &&
      error.response &&
      !(error.status === 401 && caller === "user")
    ) {
      return { status: error.status, body: error.response.data };
    }
    throw githubFailure(caller, error);
  }
}

/**
 * A GraphQL call. GitHub answers most failures with a 200 and `errors` beside whatever `data`
 * it could still give; those come back for the caller to judge. Any other status throws, as
 * `send` throws it.
 */
export async function graphql(
  octokit: GithubOctokit,
  caller: Caller,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data: any; errors: { type?: string; path?: unknown[]; message?: string }[] }> {
  try {
    const data = await octokit.graphql<any>(query, { ...variables, headers: bearer(token) });
    return { data: data ?? null, errors: [] };
  } catch (error) {
    if (error instanceof GraphqlResponseError) {
      return { data: error.data ?? null, errors: error.errors ?? [] };
    }
    throw githubFailure(caller, error);
  }
}

/** Every page of a list, up to `maxPages`: `complete` is false when GitHub had more. */
export async function listPages<T>(
  caller: Caller,
  pages: AsyncIterable<{ data: T[]; headers: { link?: string }; url?: string }>,
  maxPages: number,
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let read = 0;
  try {
    for await (const page of pages) {
      // The paginator reads a 409 as an empty last page (an empty repository's commits). None of
      // the lists read here answers one, so it stays what it was: GitHub failing.
      if (page.url === undefined) {
        throw new UpstreamError("github", "a list answered 409", { status: 409 });
      }
      items.push(...page.data);
      if (++read === maxPages) {
        return { items, complete: !/rel="next"/.test(page.headers.link ?? "") };
      }
    }
  } catch (error) {
    throw githubFailure(caller, error);
  }
  return { items, complete: true };
}

/** What an installation token is for: `Github["createInstallationToken"]`'s input. */
export type InstallationTokenScope = Parameters<Github["createInstallationToken"]>[0];

/** A kept installation token is reused until this long before it runs out. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
/** How many installation tokens one instance keeps; past this the oldest go first. */
const TOKENS_KEPT = 1_000;

/**
 * Installation tokens as `@octokit/auth-app` keeps them, by installation, repositories and
 * permissions, in this instance's memory only and never in a row. Its own cache times a token
 * by the machine's clock from when it was minted; this one by the API's clock from when GitHub
 * says it runs out, so a test can move past it.
 */
class KeptTokens {
  readonly #held = new Map<string, string>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** The entry kept under `key` while its token has a while to run; "" is none, to auth-app. */
  get(key: string): string {
    const value = this.#held.get(key);
    if (value === undefined) return "";
    // auth-app's entry is `token|createdAt|expiresAt|…`; one it cannot be read from is not reused.
    const expiresAt = Date.parse(value.split("|")[2] ?? "");
    if (expiresAt - TOKEN_REUSE_MARGIN_MS > this.#clock.now()) return value;
    this.#held.delete(key);
    return "";
  }

  set(key: string, value: string): void {
    this.#held.delete(key);
    if (this.#held.size >= TOKENS_KEPT) this.#held.delete(this.#held.keys().next().value!);
    this.#held.set(key, value);
  }
}

/** Seconds the App's JWT is dated back on top of `universal-github-app-jwt`'s own 30. */
const JWT_DRIFT_S = 30;

/** auth-app with nowhere to keep a token: each one is minted for its caller. */
const NOT_KEPT = { get: () => "", set() {} };

export interface AppAuth {
  /** The App's own credential, for `/app/…`: a JWT signed now, by the API's clock. */
  jwt(): Promise<string>;
  /** Mints a new token, kept nowhere. */
  mint(scope: InstallationTokenScope): Promise<GithubInstallationToken>;
  /** A kept token while it has a while to run, else a new one, kept; `fresh` always mints. */
  reuse(scope: InstallationTokenScope, fresh: boolean): Promise<GithubInstallationToken>;
}

/**
 * The App's credentials through `@octokit/auth-app`: its JWT, signed by `universal-github-app-jwt`
 * at the API's clock, and installation tokens minted with it on the API's Octokit. Calls for the
 * same token in flight at once share one mint (auth-app's own rule).
 */
export function createAppCredentials({
  clientId,
  privateKey,
  octokit,
  clock,
}: {
  clientId: string;
  /** The App's private key as GitHub gave it: a PEM, PKCS#1 or PKCS#8. */
  privateKey: string;
  octokit: GithubOctokit;
  clock: Clock;
}): AppAuth {
  // GitHub takes the App's client id as the JWT's issuer, in place of its numeric id.
  const createJwt = async (appId: string | number) => {
    const { token, expiration } = await githubAppJwt({
      id: appId,
      privateKey,
      // The library dates the JWT 30 seconds back and lets it run 10 minutes from there; 30 more
      // make it a minute back and 9 minutes on, so it holds against a clock up to a minute off
      // GitHub's either way.
      now: Math.floor(clock.now() / 1000) - JWT_DRIFT_S,
    });
    return { jwt: token, expiresAt: new Date(expiration * 1000).toISOString() };
  };
  const options = { appId: clientId, createJwt, request: octokit.request, log: SILENT };
  const kept = createAppAuth({ ...options, cache: new KeptTokens(clock) });
  const unkept = createAppAuth({ ...options, cache: NOT_KEPT });

  const installation = async (
    auth: typeof kept,
    { installationId, repositoryIds, permissions }: InstallationTokenScope,
    refresh: boolean,
  ): Promise<GithubInstallationToken> => {
    const answer = await send("app", () =>
      auth({
        type: "installation",
        installationId,
        // auth-app sorts this one in place.
        ...(repositoryIds ? { repositoryIds: [...repositoryIds] } : {}),
        ...(permissions ? { permissions: { ...permissions } } : {}),
        refresh,
      }),
    );
    const { token, expiresAt, permissions: allowed, repositoryIds: reached } = answer;
    return {
      token,
      expiresAt: new Date(expiresAt),
      // What GitHub granted, as it said: the caller checks it is what it asked for.
      ...(allowed ? { permissions: { ...(allowed as Record<string, string>) } } : {}),
      ...(reached ? { repositoryIds: reached.map(idOf) } : {}),
    };
  };

  return {
    jwt: async () => (await kept({ type: "app" })).token,
    mint: (scope) => installation(unkept, scope, true),
    reuse: (scope, fresh) => installation(kept, scope, fresh),
  };
}
