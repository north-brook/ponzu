import { getSessionUser, touchAgentGrant, verifyAgentToken, verifyRunnerToken } from "@ponzu/db";
import { errors, jwtVerify } from "jose";
import type { Deps } from "../deps/index.ts";
import { ApiError, UpstreamError } from "../http/errors.ts";
import type { LeasedRunner, RunnerActor, UserActor } from "./actor.ts";

/** Every way jose says "this token is not good", as opposed to "the keys could not be had". */
const TOKEN_FAULTS = [
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

/**
 * How old a token may be whatever its `exp` says. WorkOS issues them for five minutes; this
 * is the bound the API holds to by itself, so a token minted with a far-off expiry is not
 * good for longer than this.
 */
const MAX_TOKEN_AGE = "15m";
/** How far WorkOS's clock and this instance's may disagree. */
const CLOCK_TOLERANCE = "30s";

/**
 * The person a WorkOS access token is for, or a 401 that says why not. This is the one way a
 * token becomes a person: anything that takes a token from a client (a route, later a socket
 * or a sealed query) calls this, and nothing reads a token's claims without it.
 *
 * Two things must hold. The token is one WorkOS signed for this environment and has not run
 * out. And its session is one the sign-in exchange admitted: WorkOS will sign a token for
 * anyone who signs in with it directly, so a good signature says only that WorkOS knows the
 * caller, not that Ponzu let them in.
 */
export async function authenticateUser(
  deps: Pick<Deps, "db" | "workos" | "clock">,
  token: string,
): Promise<UserActor> {
  const claims = await verifyAccessToken(deps, token);
  const user = await getSessionUser(deps.db, claims.sessionId);
  if (!user || user.workosUserId !== claims.workosUserId) {
    throw new ApiError(401, "session_unknown", "Sign in again.");
  }
  return { kind: "user", user, sessionId: claims.sessionId };
}

const RUNNER_TOKEN_PREFIX = "pzr_";

/**
 * The person a token of their own agent acts for (an MCP access token, `pza_…`), or a 401 that
 * says why not. The grant must not be revoked and the person must still be one: the same
 * person, with the same access, their own routes would see. `client` is what the agent said it
 * is in this request, noted on the grant for settings to show.
 */
export async function authenticateAgent(
  deps: Pick<Deps, "db">,
  token: string,
  client: string | null,
): Promise<UserActor> {
  const found = await verifyAgentToken(deps.db, token);
  if (!found) throw new ApiError(401, "token_invalid", "This agent's token is not valid.");
  await touchAgentGrant(deps.db, { grantId: found.grant.id, client });
  return {
    kind: "user",
    user: found.user,
    sessionId: `agent:${found.grant.id}`,
    agent: {
      grantId: found.grant.id,
      name: found.grant.name,
      client: client ?? found.grant.lastClient,
    },
  };
}

/** Whether a bearer is a runner token by its look, which says which of the two checks it gets. */
export function isRunnerToken(token: string): boolean {
  return token.startsWith(RUNNER_TOKEN_PREFIX);
}

/**
 * The runner a runner token belongs to, with the one canvas it may act on, or a 401. This is
 * also the one place the lease is held to (docs/cloud.md, "The runner protocol"): `runnerId` is
 * the caller's `X-Ponzu-Runner`, and anything but the canvas's current runner is refused with
 * 409 `superseded`, so a process a newer one replaced stops at its next call. Pass
 * `{ taking: true }` for the one call that takes the lease instead. That is its own argument,
 * not a header value, so no `X-Ponzu-Runner` can skip the check.
 */
export async function authenticateRunner(
  deps: Pick<Deps, "db">,
  token: string,
  lease: { taking: true },
): Promise<RunnerActor>;
export async function authenticateRunner(
  deps: Pick<Deps, "db">,
  token: string,
  lease: { runnerId: string | undefined },
): Promise<LeasedRunner>;
export async function authenticateRunner(
  deps: Pick<Deps, "db">,
  token: string,
  lease: { taking: true } | { runnerId: string | undefined },
): Promise<RunnerActor> {
  const found = isRunnerToken(token) ? await verifyRunnerToken(deps.db, token) : null;
  if (!found) throw new ApiError(401, "token_invalid", "This runner token is not valid.");
  const actor = { kind: "runner", tokenId: found.id, canvasId: found.canvasId } as const;
  if ("taking" in lease) return { ...actor, runnerId: null };
  const { runnerId } = lease;
  if (!runnerId || runnerId !== found.leaseRunnerId) {
    throw new ApiError(409, "superseded", "A newer runner has started for this canvas.");
  }
  return { ...actor, runnerId };
}

/**
 * Checks the token here, against WorkOS's published keys, with no call to WorkOS per request.
 * It is good when WorkOS signed it with RS256 for this environment (the issuer ends in our
 * client id), it carries our `client_id`, and it says when it was issued and when it runs out.
 * WorkOS access tokens have no `aud`, so the issuer and `client_id` are what tie one to Ponzu.
 *
 * Not exported: what it returns is what a token claims, which is not yet who is asking.
 */
async function verifyAccessToken(
  { workos, clock }: Pick<Deps, "workos" | "clock">,
  token: string,
): Promise<{ workosUserId: string; sessionId: string }> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, workos.jwks, {
      issuer: workos.issuer,
      algorithms: ["RS256"],
      currentDate: new Date(clock.now()),
      // jose checks `exp` only when it is there, so a token without one would never run out.
      requiredClaims: ["exp", "iat", "sub", "sid"],
      maxTokenAge: MAX_TOKEN_AGE,
      // Checking the age means reading `iat`, and a token minted a second ago by a clock a
      // second ahead of this one would be "from the future". Allow for that.
      clockTolerance: CLOCK_TOLERANCE,
    }));
  } catch (cause) {
    // Too old by `iat` is reported the same way as past `exp`.
    if (cause instanceof errors.JWTExpired) {
      throw new ApiError(401, "token_expired", "Your session token has expired.", { cause });
    }
    if (TOKEN_FAULTS.some((fault) => cause instanceof fault)) {
      throw new ApiError(401, "token_invalid", "Your session token is not valid.", { cause });
    }
    throw new UpstreamError("workos", "the signing keys could not be fetched", { cause });
  }
  const { sub, sid, client_id: clientId } = payload;
  if (clientId !== workos.clientId || typeof sub !== "string" || typeof sid !== "string") {
    throw new ApiError(401, "token_invalid", "Your session token is not valid.");
  }
  return { workosUserId: sub, sessionId: sid };
}
