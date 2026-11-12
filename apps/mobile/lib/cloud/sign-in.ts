import {
  ApiError,
  type Randomness,
  readRedirect,
  type Session,
  SignInError,
  startSignIn,
} from "@ponzu/client";

/*
 * Continue with GitHub (docs/mobile.md, "Signing in"): @ponzu/client's PKCE flow, opened in the
 * system's auth session (ASWebAuthenticationSession, through expo-web-browser), which hands
 * back the `<scheme>://auth/callback` redirect itself.
 */

/** What `WebBrowser.openAuthSessionAsync` answers, as far as sign-in reads it. */
export type AuthSessionResult = { type: "success"; url: string } | { type: string };

export interface SignInDeps {
  session: Pick<Session, "completeSignIn">;
  workosClientId: string;
  scheme: string;
  crypto: Randomness;
  /** The fake's local page in place of WorkOS's; null for WorkOS. */
  authorizeUrl: string | null;
  /** `WebBrowser.openAuthSessionAsync`. Not called when `skipBrowser` is set. */
  openAuthSession(url: string, redirectUri: string): Promise<AuthSessionResult>;
  /** The fake with no authorize page: no browser, the fake's code straight away. */
  skipBrowser?: { code: string };
}

export type SignInOutcome =
  | { kind: "signed_in" }
  /** The person closed the sheet: back to the button, with no message. */
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export const SIGN_IN_FAILED = "Couldn't sign in. Try again.";
const NO_CLIENT_ID = "This build of Ponzu can't sign in: it has no WorkOS client id.";

export const redirectUriFor = (scheme: string) => `${scheme}://auth/callback`;

export async function signIn(deps: SignInDeps): Promise<SignInOutcome> {
  // WorkOS needs the client id; the fake's own page (or none) does not.
  if (!deps.workosClientId && !deps.authorizeUrl && !deps.skipBrowser) {
    return { kind: "failed", message: NO_CLIENT_ID };
  }
  const redirectUri = redirectUriFor(deps.scheme);
  try {
    const started = await startSignIn({
      workosClientId: deps.workosClientId || "fake",
      redirectUri,
      crypto: deps.crypto,
      ...(deps.authorizeUrl ? { authorizeUrl: deps.authorizeUrl } : {}),
    });
    let code: string;
    if (deps.skipBrowser) code = deps.skipBrowser.code;
    else {
      const result = await deps.openAuthSession(started.url, redirectUri);
      if (result.type !== "success" || !("url" in result)) return { kind: "cancelled" };
      code = readRedirect(result.url, started.state).code;
    }
    await deps.session.completeSignIn({ code, codeVerifier: started.codeVerifier });
    return { kind: "signed_in" };
  } catch (error) {
    // GitHub's own "access_denied" is the person saying no on GitHub: as good as a cancel.
    if (error instanceof SignInError && error.code === "access_denied") {
      return { kind: "cancelled" };
    }
    if (error instanceof ApiError && error.code === "network") {
      return { kind: "failed", message: "Can't reach Ponzu. Check your connection and try again." };
    }
    return { kind: "failed", message: SIGN_IN_FAILED };
  }
}
