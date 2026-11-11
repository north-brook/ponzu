import { encodeBase64url } from "./base64url.ts";

/*
 * The browser half of sign-in: an authorization-code flow with PKCE, GitHub through WorkOS
 * (docs/cloud.md, "Identity and access"). Both apps build the same URL here; each opens the
 * browser and catches the redirect its own way, then hands the code and the verifier to
 * `session.completeSignIn`.
 */

const WORKOS_AUTHORIZE = "https://api.workos.com/user_management/authorize";

/**
 * The little of Web Crypto sign-in needs. Browsers, Electron and Bun have it as
 * `globalThis.crypto`; on the phone, pass `expo-crypto`'s `getRandomValues` and `digest`.
 */
export interface Randomness {
  getRandomValues<T extends Uint8Array>(bytes: T): T;
  subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
}

export interface SignInStart {
  /** Kept by the app until the redirect comes back, then given to `completeSignIn`. */
  codeVerifier: string;
  /** The redirect must carry this exact value, or it is not this sign-in's. */
  state: string;
  /** Open this in the system browser. */
  url: string;
}

/**
 * A new sign-in: its verifier, state and the WorkOS URL that goes straight to GitHub.
 * `redirectUri` is `http://127.0.0.1:<port>/auth/callback` on the Mac and
 * `ponzu://auth/callback` on the phone; WorkOS matches it exactly.
 */
export async function startSignIn(opts: {
  workosClientId: string;
  redirectUri: string;
  crypto?: Randomness;
}): Promise<SignInStart> {
  const crypto = opts.crypto ?? (globalThis.crypto as unknown as Randomness);
  const codeVerifier = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = encodeBase64url(crypto.getRandomValues(new Uint8Array(16)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: opts.workosClientId,
    provider: "GitHubOAuth",
    redirect_uri: opts.redirectUri,
    state,
    code_challenge: encodeBase64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
  });
  return { codeVerifier, state, url: `${WORKOS_AUTHORIZE}?${query}` };
}

/** Why a redirect did not finish a sign-in. */
export class SignInError extends Error {
  constructor(
    /** `state_mismatch`, or the `error` WorkOS put on the redirect (`access_denied`, …). */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

/**
 * The code from the redirect the browser came back with. Anything can open a loopback address
 * or a `ponzu://` link, so a redirect without this sign-in's state is refused.
 */
export function readRedirect(redirect: string, expectedState: string): { code: string } {
  const query = new URLSearchParams(redirect.slice(redirect.indexOf("?") + 1).split("#")[0]);
  if (query.get("state") !== expectedState) {
    throw new SignInError("state_mismatch", "This is not the sign-in that was started.");
  }
  const error = query.get("error");
  if (error) {
    throw new SignInError(error, query.get("error_description") ?? "Sign-in did not finish.");
  }
  const code = query.get("code");
  if (!code) throw new SignInError("missing_code", "Sign-in did not finish.");
  return { code };
}
