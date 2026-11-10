import type { Clock } from "@ponzu/sandbox";
import { errors, jwtVerify } from "jose";
import type { Workos } from "../deps/workos.ts";
import { ApiError, UpstreamError } from "../http/errors.ts";

/** What a verified WorkOS access token says. */
export interface AccessTokenClaims {
  /** The WorkOS user id (`sub`). */
  workosUserId: string;
  /** The WorkOS session (`sid`). */
  sessionId: string;
}

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
 * Verifies an access token here, against WorkOS's published keys, with no call to WorkOS per
 * request. A token is good when WorkOS signed it with RS256 for this environment (the issuer
 * ends in our client id), it carries our `client_id`, and it has not run out.
 *
 * WorkOS access tokens have no `aud`, so the issuer and the `client_id` claim are what tie a
 * token to Ponzu. A session revoked at WorkOS keeps verifying until its token runs out, five
 * minutes at most.
 */
export async function verifyAccessToken(
  token: string,
  { workos, clock }: { workos: Workos; clock: Clock },
): Promise<AccessTokenClaims> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, workos.jwks, {
      issuer: workos.issuer,
      algorithms: ["RS256"],
      currentDate: new Date(clock.now()),
    }));
  } catch (cause) {
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
