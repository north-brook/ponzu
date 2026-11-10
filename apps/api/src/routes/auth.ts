import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { signIn } from "../auth/sign-in.ts";
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
    return c.json(
      Session.parse({
        user: toProfile(signedIn.user),
        access_token: signedIn.accessToken,
        refresh_token: signedIn.refreshToken,
      }),
    );
  })

  /**
   * Ends the session the bearer token belongs to: its refresh token stops working at WorkOS.
   * The access token itself keeps verifying until it runs out, so the app forgets both.
   */
  .post("/sign-out", access.user, async (c) => {
    await c.var.deps.workos.revokeSession(c.var.actor.sessionId);
    return c.body(null, 204);
  });
