import {
  ApiError,
  createSession,
  type Fetch,
  type KeyValueStorage,
  type SessionHost,
  SignInError,
} from "@ponzu/client";
import type { BorrowedToken, BridgeError, SessionPersistence, SignInResult } from "./bridge.ts";
import type { Config } from "./config.ts";
import { type SignIn, signInWithBrowser } from "./sign-in.ts";

/*
 * The one session, in the main process (docs/cloud.md, "Clients"). It alone holds the refresh
 * token and refreshes, one refresh at a time, writing the rotated pair down before using it; the
 * single-instance lock keeps it the only one on this computer. The studio borrows an access
 * token per request and never sees the refresh token.
 */

export interface MainSession {
  session: SessionHost;
  persistence(): SessionPersistence;
  accessToken(rejected?: string): Promise<BorrowedToken>;
  report(error: BridgeError): void;
  signIn(): Promise<SignInResult>;
  cancelSignIn(): void;
}

export function mainSession(opts: {
  config: Config;
  version: string;
  storage: KeyValueStorage;
  persistence: () => SessionPersistence;
  openBrowser: (url: string) => Promise<void>;
  /** Bring Ponzu forward once the browser has come back. */
  focus: () => void;
  /** For the API and WorkOS: the runtime's own unless a test plays them. */
  fetch?: Fetch;
}): MainSession {
  const session = createSession({
    apiUrl: opts.config.apiUrl,
    workosClientId: opts.config.workosClientId,
    storage: opts.storage,
    client: { platform: clientPlatform(), version: opts.version },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  let pending: SignIn | null = null;

  return {
    session,
    persistence: opts.persistence,
    async accessToken(rejected) {
      try {
        return { token: await session.accessToken(rejected) };
      } catch (error) {
        return { error: bridgeError(error) };
      }
    },
    report(error) {
      session.take(
        new ApiError(error.status, error.code as ApiError["code"], error.message, error.details),
      );
    },
    async signIn() {
      pending?.cancel();
      const attempt = await signInWithBrowser({
        workosClientId: opts.config.workosClientId,
        openBrowser: opts.openBrowser,
      }).catch((error: unknown) => error);
      if (attempt instanceof Error) return failed(attempt);
      pending = attempt as SignIn;
      try {
        const redirect = await pending.result;
        opts.focus();
        await session.completeSignIn(redirect);
        return { ok: true };
      } catch (error) {
        if (error instanceof SignInError && error.code === "cancelled") {
          return { ok: false, reason: "cancelled" };
        }
        return failed(error);
      } finally {
        if (pending === attempt) pending = null;
      }
    },
    cancelSignIn() {
      pending?.cancel();
    },
  };
}

/** The name the API knows this computer's app by (`X-Ponzu-Client`). */
export function clientPlatform(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function failed(error: unknown): SignInResult {
  const message =
    error instanceof SignInError && error.code === "access_denied"
      ? "GitHub didn't let Ponzu in. Try again."
      : error instanceof ApiError
        ? error.message
        : "Couldn't sign in. Try again.";
  return { ok: false, reason: "failed", message };
}

function bridgeError(error: unknown): BridgeError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return { status: 0, code: "network", message: "Ponzu could not be reached." };
}
