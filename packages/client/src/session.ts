import { decodeBase64url } from "./base64url.ts";
import { type Clock, sleep, systemClock } from "./clock.ts";
import { ApiError, errorOf, networkError } from "./errors.ts";
import type { Fetch, Profile } from "./rpc.ts";

/*
 * Who is signed in, and a valid access token for every request (docs/cloud.md, "Identity and
 * access"). WorkOS access tokens last five minutes; this refreshes them directly with WorkOS,
 * as a public client, one refresh at a time, and always stores the rotated refresh token
 * before the new access token is used.
 */

const WORKOS_AUTHENTICATE = "https://api.workos.com/user_management/authenticate";

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 60_000;
/** Tries of one refresh (or of storing its result) before the caller hears it failed. */
const ATTEMPTS = 3;
const FIRST_RETRY_MS = 500;

/**
 * Somewhere small and durable to keep strings. Each app implements it: the Mac's main process
 * over `safeStorage`, `expo-secure-store` on the phone, a `Map` in tests. The session keeps
 * its tokens under one key, so they are written together.
 */
export interface KeyValueStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const SESSION_KEY = "ponzu.session";

export type SessionState =
  /** Reading what storage holds. */
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "signed_in"; user: Profile }
  /** GitHub no longer accepts what Ponzu holds for the person: sign in again to re-grant it. */
  | { status: "github_reauth" }
  /** The API refuses this build (426). Offer the update; nothing else will work. */
  | { status: "too_old"; minimumVersion: string | null };

/** What every request goes through. The API client, the live queries and the fake all take one. */
export interface Session {
  readonly apiUrl: string;
  getState(): SessionState;
  /** Hear each change of `getState()`. */
  subscribe(listener: () => void): () => void;
  /**
   * `fetch` with a valid bearer and the client header. An answer that is not 2xx is thrown as
   * `ApiError`, after the session has taken in what it means: an expired token is refreshed
   * and the request sent once more; a session the API no longer honors signs out.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Finish a sign-in from the browser's redirect (`readRedirect`). */
  completeSignIn(input: { code: string; codeVerifier: string }): Promise<Profile>;
  /** Ends the session at the API, then forgets it here whether or not that worked. */
  signOut(): Promise<void>;
}

export interface SessionOptions {
  /** `https://api.ponzu.design`. */
  apiUrl: string;
  /** The WorkOS environment's client id. Public: the app ships it. */
  workosClientId: string;
  storage: KeyValueStorage;
  /** Who is asking, sent as `X-Ponzu-Client: <platform>/<version>`: `macos` and `2.0.0`. */
  client: { platform: string; version: string };
  fetch?: Fetch;
  clock?: Clock;
}

/** Thrown when the rotated tokens could not be written down. They are kept and written first next time. */
export class SessionStorageError extends Error {
  constructor(cause: unknown) {
    super("Ponzu could not save your session on this device.");
    this.name = "SessionStorageError";
    (this as { cause?: unknown }).cause = cause;
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  user: Profile;
  /**
   * When to refresh, on this device's clock: the token's lifetime counted from when it came,
   * so a clock that is minutes off neither refreshes on every call nor sends expired tokens.
   */
  refreshAt: number;
}

export function createSession(opts: SessionOptions): Session {
  return new TokenSession(opts);
}

class TokenSession implements Session {
  readonly apiUrl: string;
  private readonly opts: SessionOptions;
  private readonly send: Fetch;
  private readonly clock: Clock;
  private readonly clientHeader: string;

  private state: SessionState = { status: "loading" };
  private listeners = new Set<() => void>();
  private tokens: Tokens | null = null;
  /** `tokens` changed and storage does not have it yet. */
  private unsaved = false;
  /** Moves on each sign-in and sign-out, so a refresh that began before one is thrown away. */
  private generation = 0;
  private refreshing: Promise<Tokens> | null = null;
  private readonly loaded: Promise<void>;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.send = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.clock = opts.clock ?? systemClock;
    this.clientHeader = `${opts.client.platform}/${opts.client.version}`;
    this.loaded = this.load();
  }

  getState(): SessionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    let token = await this.accessToken();
    let response = await this.sendToApi(input, init, token);
    if (response.status === 401) {
      const error = await errorOf(response);
      if (error.code !== "token_expired") throw this.taken(error);
      token = await this.accessToken(token);
      response = await this.sendToApi(input, init, token);
    }
    if (!response.ok) throw this.taken(await errorOf(response));
    return response;
  }

  async completeSignIn({ code, codeVerifier }: { code: string; codeVerifier: string }) {
    await this.loaded;
    const response = await this.sendToApi(`${this.apiUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
    });
    if (!response.ok) throw this.taken(await errorOf(response));
    const body = (await response.json()) as {
      user: Profile;
      access_token: string;
      refresh_token: string;
    };
    this.generation++;
    this.tokens = this.received(body, body.user);
    this.unsaved = true;
    await this.persist();
    this.set({ status: "signed_in", user: body.user });
    return body.user;
  }

  async signOut(): Promise<void> {
    await this.loaded;
    if (!this.tokens) return this.forget({ status: "signed_out" });
    try {
      const token = await this.accessToken();
      await this.sendToApi(`${this.apiUrl}/v1/auth/sign-out`, { method: "POST" }, token);
    } catch {
      // Offline, or already ended: forgetting it here is what the person asked for.
    }
    await this.forget({ status: "signed_out" });
  }

  /**
   * A token good for at least another minute. `rejected` is one the API just called expired:
   * unless someone has refreshed since, refresh now whatever its claims say.
   */
  private async accessToken(rejected?: string): Promise<string> {
    await this.loaded;
    const tokens = this.tokens;
    if (!tokens) throw new ApiError(401, "unauthenticated", "Sign in to do this.");
    if (this.unsaved) await this.persist();
    const stale = rejected === tokens.accessToken || this.clock.now() >= tokens.refreshAt;
    if (!stale) return tokens.accessToken;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return (await this.refreshing).accessToken;
  }

  /**
   * A fresh pair. Another session on the same storage (a second window, a tab) may have
   * refreshed already, spending the token this one holds: then theirs is taken up instead.
   */
  private async refresh(): Promise<Tokens> {
    const generation = this.generation;
    const newer = await this.storedOtherThan(this.tokens!.refreshToken);
    if (generation !== this.generation) throw signedOut();
    if (newer) {
      this.tokens = newer;
      if (this.clock.now() < newer.refreshAt) return newer;
    }
    return this.redeem(generation);
  }

  /** Trade the refresh token for a new pair, store it, and only then hand it out. */
  private async redeem(generation: number): Promise<Tokens> {
    const { refreshToken, user } = this.tokens!;
    let wait = FIRST_RETRY_MS;
    for (let attempt = 1; ; attempt++) {
      let response: Response | null = null;
      try {
        response = await this.send(WORKOS_AUTHENTICATE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: this.opts.workosClientId,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        });
      } catch {
        // No answer: try again with the same token.
      }
      if (generation !== this.generation) throw signedOut();
      if (response?.ok) {
        const body = (await response.json()) as { access_token: string; refresh_token: string };
        this.tokens = this.received(body, user);
        this.unsaved = true;
        await this.persist();
        return this.tokens;
      }
      if (response && !retryable(response.status)) {
        const error = await response.json().catch(() => null);
        if ((error as { error?: string } | null)?.error === "invalid_grant") {
          // Spent by another session while this one was asking: carry on with what it stored.
          const newer = await this.storedOtherThan(refreshToken);
          if (generation !== this.generation) throw signedOut();
          if (newer) {
            this.tokens = newer;
            return this.clock.now() < newer.refreshAt ? newer : this.redeem(generation);
          }
          await this.forget({ status: "signed_out" });
          throw signedOut();
        }
        throw new ApiError(
          response.status,
          "upstream_unavailable",
          "Sign-in could not be renewed.",
        );
      }
      if (attempt === ATTEMPTS) throw networkError(response?.status);
      await sleep(this.clock, wait);
      wait *= 2;
    }
  }

  /** Write `tokens` down, trying a few times. Until it works, no new access token is used. */
  private async persist(): Promise<void> {
    let wait = FIRST_RETRY_MS;
    for (let attempt = 1; ; attempt++) {
      const tokens = this.tokens;
      if (!tokens) return;
      try {
        await this.opts.storage.set(SESSION_KEY, JSON.stringify(tokens));
        if (this.tokens === tokens) this.unsaved = false;
        return;
      } catch (error) {
        if (attempt === ATTEMPTS) throw new SessionStorageError(error);
      }
      await sleep(this.clock, wait);
      wait *= 2;
    }
  }

  /** What an error from the API means for the session, then the error, to throw. */
  private taken(error: ApiError): ApiError {
    switch (error.code) {
      case "session_unknown":
      case "token_invalid":
        void this.forget({ status: "signed_out" });
        break;
      case "github_reauth_required":
        void this.forget({ status: "github_reauth" });
        break;
      case "client_too_old": {
        const minimum = error.details?.minimumVersion;
        this.set({
          status: "too_old",
          minimumVersion: typeof minimum === "string" ? minimum : null,
        });
        break;
      }
    }
    return error;
  }

  private async sendToApi(input: RequestInfo | URL, init: RequestInit, token?: string) {
    const headers = new Headers(init.headers);
    headers.set("x-ponzu-client", this.clientHeader);
    if (token) headers.set("authorization", `Bearer ${token}`);
    try {
      return await this.send(input, { ...init, headers });
    } catch (error) {
      throw networkError(error);
    }
  }

  /** A pair just handed out by the API or WorkOS. */
  private received(body: { access_token: string; refresh_token: string }, user: Profile): Tokens {
    const { exp, iat } = claims(body.access_token);
    const lifetime = typeof exp === "number" && typeof iat === "number" ? exp - iat : null;
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      user,
      refreshAt:
        lifetime === null
          ? expiresAt(body.access_token) - REFRESH_MARGIN_MS
          : this.clock.now() + lifetime * 1000 - REFRESH_MARGIN_MS,
    };
  }

  /** What storage holds, if it is a session with a refresh token other than `refreshToken`. */
  private async storedOtherThan(refreshToken: string): Promise<Tokens | null> {
    const stored = await this.stored();
    return stored && stored.refreshToken !== refreshToken ? stored : null;
  }

  private async stored(): Promise<Tokens | null> {
    try {
      const saved = await this.opts.storage.get(SESSION_KEY);
      const tokens = saved ? (JSON.parse(saved) as Partial<Tokens>) : null;
      if (!tokens?.refreshToken || !tokens.user) return null;
      const accessToken = tokens.accessToken ?? "";
      return {
        accessToken,
        refreshToken: tokens.refreshToken,
        user: tokens.user,
        // Stored before `refreshAt` was: by the token's own claims.
        refreshAt: tokens.refreshAt ?? expiresAt(accessToken) - REFRESH_MARGIN_MS,
      };
    } catch {
      // Unreadable: as good as nothing stored.
      return null;
    }
  }

  private async load(): Promise<void> {
    const tokens = await this.stored();
    if (this.state.status !== "loading") return;
    this.tokens = tokens;
    this.set(
      this.tokens ? { status: "signed_in", user: this.tokens.user } : { status: "signed_out" },
    );
  }

  private async forget(next: SessionState): Promise<void> {
    this.generation++;
    this.tokens = null;
    this.unsaved = false;
    if (this.state.status !== "too_old") this.set(next);
    try {
      await this.opts.storage.delete(SESSION_KEY);
    } catch {
      // Nothing to use it with: the API has ended it, or will at its next sight of it.
    }
  }

  private set(state: SessionState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

const signedOut = () => new ApiError(401, "unauthenticated", "Sign in again.");

/** Network trouble, a timeout, a rate limit or WorkOS failing: the same token may work next time. */
function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** When a JWT runs out, in milliseconds; 0 when it cannot be read, so it is refreshed. */
export function expiresAt(jwt: string): number {
  const { exp } = claims(jwt);
  return typeof exp === "number" ? exp * 1000 : 0;
}

function claims(jwt: string): { exp?: unknown; iat?: unknown } {
  try {
    return JSON.parse(decodeBase64url(jwt.split(".")[1] ?? "")) ?? {};
  } catch {
    return {};
  }
}
