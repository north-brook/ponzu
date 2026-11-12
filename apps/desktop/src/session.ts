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
import { type Finished, type SignInAttempt, signInWithBrowser } from "./sign-in.ts";

/*
 * The one session, in the main process (docs/cloud.md, "Clients"). It alone holds the refresh
 * token and refreshes, one refresh at a time, writing the rotated pair down before using it; the
 * single-instance lock keeps it the only one on this computer. The studio borrows an access
 * token per request and never sees the refresh token.
 *
 * Signing in: each press of Continue with GitHub starts an attempt of its own (its own port,
 * state and verifier) beside any still waiting, since the person may have left an earlier tab
 * half done. The first to come back signs them in; then the rest are closed. An attempt also
 * ends when its window runs out, when it is the oldest of more than MAX_ATTEMPTS, and when
 * Ponzu quits. Nothing else closes one: not the window taking focus, not the screen going.
 */

/** Sign-in attempts listening at once: a press past this closes the oldest. */
export const MAX_ATTEMPTS = 3;
/**
 * How long the API has to answer an exchange before the browser's page says Ponzu couldn't be
 * reached and the next tab back may try its own code.
 */
export const EXCHANGE_MS = 20_000;

export interface MainSession {
  session: SessionHost;
  persistence(): SessionPersistence;
  accessToken(rejected?: string): Promise<BorrowedToken>;
  report(error: BridgeError): void;
  /**
   * Start a sign-in in the browser, beside any still waiting. Resolves once this attempt has
   * ended: it signed the person in, it failed, or it was closed (another signed them in, it
   * ran out, it was the oldest of too many, Ponzu quit).
   */
  signIn(): Promise<SignInResult>;
  /** Close every attempt still waiting: Ponzu is quitting. */
  closeSignIns(): void;
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
  /** How long an attempt waits for its browser: ten minutes unless a test says otherwise. */
  attemptMs?: number;
  /** How long the API is given to answer an exchange: EXCHANGE_MS unless a test says otherwise. */
  exchangeMs?: number;
}): MainSession {
  const session = createSession({
    apiUrl: opts.config.apiUrl,
    workosClientId: opts.config.workosClientId,
    storage: opts.storage,
    client: { platform: clientPlatform(), version: opts.version },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  /** The attempts still listening, oldest first. */
  const attempts: SignInAttempt[] = [];
  const closeAll = () => {
    for (const attempt of attempts.splice(0)) attempt.close();
  };
  // Signed in, by whichever attempt: the rest have nothing left to do.
  session.subscribe(() => {
    if (session.getState().status === "signed_in") closeAll();
  });

  /**
   * The exchange in flight: a second tab back at the same moment waits for the first, and
   * never longer than the first is given (`exchangeMs`), so a stalled one can't hold the rest.
   */
  let exchanging: Promise<unknown> | null = null;
  const exchangeMs = opts.exchangeMs ?? EXCHANGE_MS;
  /** `exchanged`: this redirect's code was the one that signed the person in. */
  const finish = async (redirect: {
    code: string;
    codeVerifier: string;
  }): Promise<Finished & { exchanged?: boolean }> => {
    while (exchanging) await exchanging;
    if (session.getState().status === "signed_in") return { ok: true };
    const giveUp = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooLong = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ApiError(0, "network", "Ponzu could not be reached.");
        giveUp.abort(error);
        reject(error);
      }, exchangeMs);
    });
    const exchange = Promise.race([
      session.completeSignIn({ ...redirect, signal: giveUp.signal }),
      tooLong,
    ]);
    const settled = exchange.then(
      () => {},
      () => {},
    );
    exchanging = settled;
    try {
      await exchange;
      return { ok: true, exchanged: true };
    } catch (error) {
      return { ok: false, error, why: pageReason(error) };
    } finally {
      clearTimeout(timer);
      if (exchanging === settled) exchanging = null;
    }
  };

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
      let attempt: SignInAttempt;
      // Whether this attempt's own code signed the person in, rather than finding them signed
      // in by another tab back at the same moment: only then is Ponzu brought forward.
      let exchanged = false;
      try {
        attempt = await signInWithBrowser({
          workosClientId: opts.config.workosClientId,
          openBrowser: opts.openBrowser,
          finish: async (redirect) => {
            const finished = await finish(redirect);
            exchanged = finished.ok && finished.exchanged === true;
            return finished;
          },
          ...(opts.attemptMs ? { timeoutMs: opts.attemptMs } : {}),
        });
      } catch (error) {
        return failed(error);
      }
      attempts.push(attempt);
      while (attempts.length > MAX_ATTEMPTS) attempts.shift()!.close();
      const end = await attempt.ended;
      const at = attempts.indexOf(attempt);
      if (at >= 0) attempts.splice(at, 1);
      if ((end.kind === "signed_in" && exchanged) || end.kind === "failed") opts.focus();
      if (end.kind === "signed_in") return { ok: true };
      if (end.kind === "failed") return failed(end.error);
      return { ok: false, reason: "closed" };
    },
    closeSignIns: closeAll,
  };
}

/** The name the API knows this computer's app by (`X-Ponzu-Client`). */
export function clientPlatform(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function failed(error: unknown): SignInResult {
  if (error instanceof SignInError && error.code === "access_denied") {
    return {
      ok: false,
      reason: "failed",
      message: "GitHub didn't let Ponzu in. Try again.",
      code: "access_denied",
    };
  }
  if (error instanceof ApiError) {
    const code = error.code === "network" ? "network" : "refused";
    return { ok: false, reason: "failed", message: error.message, code };
  }
  return { ok: false, reason: "failed", message: "Couldn't sign in. Try again.", code: "other" };
}

/** Why the exchange failed, for the page the browser lands on (the app says it its own way). */
function pageReason(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return "Ponzu couldn't be reached.";
  if (error instanceof ApiError) return error.message;
  return "Ponzu couldn't finish signing you in.";
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
