import { endSession } from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { signIn } from "../auth/sign-in.ts";
import { syncGithub } from "../github/sync.ts";
import type { AppEnv } from "../http/context.ts";
import { clientIp } from "../http/request.ts";
import { validate } from "../http/validate.ts";
import { Profile, toProfile } from "./profile.ts";

// These three names are OAuth's, so they keep OAuth's spelling. Everything else the API
// sends and takes is camelCase.
const ExchangeBody = z.object({
  code: z.string().min(1).max(512),
  /** The PKCE verifier the sign-in began with (RFC 7636: 43 to 128 unreserved characters). */
  code_verifier: z.string().regex(/^[\w.~-]{43,128}$/, "Not a PKCE code verifier."),
});

const Session = z.object({
  user: Profile,
  /** A WorkOS access token: the bearer for every other route. Five minutes. */
  access_token: z.string(),
  /** What the app trades with WorkOS, directly, for the next access token. */
  refresh_token: z.string(),
});

export const auth = new Hono<AppEnv>()
  /**
   * The server half of sign-in: trades the code the browser came back with for a session.
   * The person's GitHub token is stored here and is not in the answer.
   */
  .post("/exchange", access.public, validate("json", ExchangeBody), async (c) => {
    const body = c.req.valid("json");
    const signedIn = await signIn(c.var.deps, c.var.log, {
      code: body.code,
      codeVerifier: body.code_verifier,
      ipAddress: clientIp(c.req.raw.headers),
      userAgent: c.req.header("user-agent"),
    });
    const { user } = signedIn;
    // Said of them by id from here on: the exchange is the one public route that learns who.
    const { analytics } = c.var.deps;
    analytics.identify({
      userId: user.id,
      name: user.name,
      email: user.email,
      githubLogin: user.githubLogin,
      signedUpAt: user.createdAt,
    });
    if (user.created) analytics.capture("user signed up", {}, { distinctId: user.id });
    analytics.capture("user signed in", { new_user: user.created }, { distinctId: user.id });
    // What the person can reach on GitHub, brought up to date without making sign-in wait.
    c.var.deps.background("github_sync", syncGithub({ ...c.var.deps, log: c.var.log }, user.id));
    return c.json(
      Session.parse({
        user: toProfile(user),
        access_token: signedIn.accessToken,
        refresh_token: signedIn.refreshToken,
      }),
    );
  })

  /**
   * Ends the session the bearer token belongs to. Forgetting it here is what signs the person
   * out: the API stops honoring the session's tokens at once, these and any refreshed later.
   * So that goes first and is all the answer depends on. Revoking at WorkOS only tidies up (it
   * stops the refresh token, which would now buy tokens the API refuses), and a failure there
   * must not leave someone who pressed "sign out" signed in.
   */
  .post("/sign-out", access.user, async (c) => {
    const { db, workos } = c.var.deps;
    const { sessionId } = c.var.actor;
    await endSession(db, sessionId);
    c.var.deps.analytics.capture("user signed out", {});
    try {
      await workos.revokeSession(sessionId);
    } catch (error) {
      c.var.log.warn("session_revoke_failed", { error });
    }
    return c.body(null, 204);
  });
