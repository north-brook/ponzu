import type { ApiError } from "./errors.ts";
import type { Fetch } from "./rpc.ts";
import { authorizedFetch, type Session, type SessionState, sendToApi } from "./session.ts";

/*
 * A session held by another process. On the Mac the main process holds the tokens, refreshes
 * them and keeps the refresh token to itself (`SessionHost`); the renderer borrows an access
 * token for each request through this, over IPC, and sends the request itself.
 */

/** What the holder lends: its state, an access token on demand, and an ear for errors. */
export interface SessionLender {
  getState(): Promise<SessionState>;
  /** Hear each change of the holder's state. Returns the unsubscribe. */
  onState(listener: (state: SessionState) => void): () => void;
  /** As `SessionHost.accessToken`. Rejects with an `ApiError` when there is none to lend. */
  accessToken(rejected?: string): Promise<string>;
  /** An error the API answered here, for the holder to take in (signed out, too old, …). */
  report(error: ApiError): void;
  signOut(): Promise<void>;
}

export interface BorrowedSessionOptions {
  apiUrl: string;
  /** Who is asking, as `SessionOptions.client`. */
  client: { platform: string; version: string };
  lender: SessionLender;
  fetch?: Fetch;
}

export function borrowSession(opts: BorrowedSessionOptions): Session {
  const send: Fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const clientHeader = `${opts.client.platform}/${opts.client.version}`;
  const listeners = new Set<() => void>();
  let state: SessionState = { status: "loading" };
  /** A state heard before the first answer to `getState` is newer than that answer. */
  let heard = false;
  const set = (next: SessionState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  opts.lender.onState((next) => {
    heard = true;
    set(next);
  });
  void opts.lender.getState().then((first) => {
    if (!heard) set(first);
  });

  return {
    apiUrl: opts.apiUrl.replace(/\/+$/, ""),
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fetch: (input, init = {}) =>
      authorizedFetch({
        send: (token) => sendToApi(send, clientHeader, input, init, token),
        token: (rejected) => opts.lender.accessToken(rejected),
        taken: (error) => {
          opts.lender.report(error);
          return error;
        },
      }),
    completeSignIn: () =>
      Promise.reject(new Error("This session is borrowed: its holder signs in.")),
    signOut: () => opts.lender.signOut(),
  };
}
