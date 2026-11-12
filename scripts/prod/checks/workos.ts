/**
 * WorkOS for an environment. Its configuration cannot be read without an admin key, so the check
 * proves the part sign-in depends on instead (docs/production.md, "WorkOS production"):
 *
 * - For each redirect URI the apps use (the Mac's loopback and the phone's `ponzu://`), it builds
 *   the authorize URL with `@workos-inc/node`'s `getAuthorizationUrlWithPKCE` (GitHub, PKCE, the
 *   environment's public client id, no API key), fetches it without following redirects, and
 *   requires a redirect to `github.com/login/oauth/authorize` carrying the environment's GitHub
 *   App's client id. A redirect URI WorkOS does not allow is sent to AuthKit's
 *   `/redirect-uri-invalid` page instead, and GitHub OAuth set up with any other client sends
 *   people to GitHub with that client's id; both fail.
 * - The client's JWKS answers with a signing key.
 * - Every sign-in method but GitHub off and default emails off: `manual`.
 *
 * It needs no credential: the client id, the App's client id (GitHub's public `GET
 * /apps/{slug}`) and both WorkOS URLs are public. Nothing is created: an authorize request that
 * is never completed leaves nothing behind.
 */
import { WorkOS } from "@workos-inc/node";
import { z } from "zod";
import type { EnvironmentName } from "../desired.ts";
import { type CheckContext, type Finding, findings, type Section } from "./finding.ts";
import { readApp } from "./github.ts";

/**
 * The redirect URIs WorkOS must allow, as the apps send them: the Mac listens on a random
 * loopback port (WorkOS allows any port for `http://127.0.0.1`), so the check picks one; the
 * phone comes back through its scheme.
 */
export const REDIRECT_URIS = [
  { id: "loopback", uri: "http://127.0.0.1:53682/auth/callback", who: "the Mac's loopback" },
  { id: "scheme", uri: "ponzu://auth/callback", who: "the phone's ponzu://" },
] as const;

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";

// --- desired ------------------------------------------------------------------------------------

export interface WorkosDesired {
  env: EnvironmentName;
  /** infra/environments.json's workosClientId; `null` until founder step D7. */
  clientId: string | null;
  /** The App whose client id GitHub OAuth must use. */
  appSlug: string | null;
}

export function workosDesired(ctx: Pick<CheckContext, "env" | "infra">): WorkosDesired {
  const environment = ctx.infra["environments.json"].environments[ctx.env];
  return { env: ctx.env, clientId: environment.workosClientId, appSlug: environment.githubAppSlug };
}

// --- observed -----------------------------------------------------------------------------------

/**
 * What the check keeps: each authorize request's status and where it pointed (the WorkOS state
 * dropped), the JWKS's keys without their key material, and the App's public client id. The
 * fixture fixtures/workos/dev-answers.json is this shape.
 */
export const WorkosAnswers = z.object({
  /** `undefined`: not read (no client id in infra). `null`: GitHub has no such App. */
  appClientId: z.string().nullish(),
  hops: z.array(
    z.object({ redirectUri: z.string(), status: z.number(), location: z.string().nullable() }),
  ),
  jwks: z
    .object({
      status: z.number(),
      keys: z.array(
        z.object({
          kty: z.string().nullish(),
          use: z.string().nullish(),
          alg: z.string().nullish(),
        }),
      ),
    })
    .nullable(),
});
export type WorkosAnswers = z.infer<typeof WorkosAnswers>;
export type WorkosObserved = WorkosAnswers;

/** A Location without the parts that change on every request (state, PKCE challenge). */
export function trimLocation(location: string | null): string | null {
  if (!location || !URL.canParse(location)) return location;
  const url = new URL(location);
  for (const key of ["state", "code_challenge"]) url.searchParams.delete(key);
  return url.toString();
}

export async function fetchWorkos(
  ctx: CheckContext,
  desired: WorkosDesired,
): Promise<WorkosObserved> {
  const clientId = desired.clientId;
  if (!clientId) return { hops: [], jwks: null };
  const workos = new WorkOS({ clientId });
  const [app, hops, jwks] = await Promise.all([
    desired.appSlug ? readApp(ctx, desired.appSlug) : Promise.resolve(null),
    Promise.all(
      REDIRECT_URIS.map(async ({ uri }) => {
        const { url } = await workos.userManagement.getAuthorizationUrlWithPKCE({
          provider: "GitHubOAuth",
          clientId,
          redirectUri: uri,
        });
        const response = await ctx.fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        await response.body?.cancel();
        return {
          redirectUri: uri,
          status: response.status,
          location: trimLocation(response.headers.get("location")),
        };
      }),
    ),
    (async () => {
      const response = await ctx.fetch(workos.userManagement.getJwksUrl(clientId), {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, keys: [] };
      }
      const body = z
        .object({ keys: z.array(z.record(z.string(), z.unknown())) })
        .parse(await response.json());
      // Only what says it is a signing key; the key material is never kept.
      const keys = body.keys.map((k) => ({
        kty: typeof k.kty === "string" ? k.kty : null,
        use: typeof k.use === "string" ? k.use : null,
        alg: typeof k.alg === "string" ? k.alg : null,
      }));
      return { status: response.status, keys };
    })(),
  ]);
  return { appClientId: app ? (app.client_id ?? null) : null, hops, jwks };
}

// --- evaluate -----------------------------------------------------------------------------------

const f = findings("workos");

const STEP_REDIRECTS =
  "WorkOS › the environment › Redirects: add http://127.0.0.1/auth/callback and ponzu://auth/callback (founder step D7)";

export function evaluateWorkos(desired: WorkosDesired, observed: WorkosObserved): Finding[] {
  const { env } = desired;
  const methods = f.manual(
    "methods",
    `confirm every WorkOS sign-in method but GitHub is off, and default emails are off, for ${env}`,
    "WorkOS › Authentication, and WorkOS › Emails",
  );
  if (!desired.clientId) {
    return [
      f.pending(
        "client",
        `infra/environments.json has no WorkOS client id for ${env} yet`,
        "founder steps D5 and D7: activate WorkOS production and send the orchestrator its client id",
      ),
      methods,
    ];
  }
  const out: Finding[] = [];
  const jwks = observed.jwks;
  const signing = jwks?.keys.filter((k) => k.kty && (k.use ?? "sig") === "sig").length ?? 0;
  out.push(
    jwks && jwks.status === 200 && signing
      ? f.ok(
          "jwks",
          `the JWKS for ${desired.clientId} has ${signing} signing key${signing === 1 ? "" : "s"}`,
        )
      : f.fail(
          "jwks",
          jwks && jwks.status !== 200
            ? `the JWKS for ${desired.clientId} answered ${jwks.status}`
            : `the JWKS for ${desired.clientId} has no signing key`,
          "check infra/environments.json's workosClientId against WorkOS › API Keys",
        ),
  );

  const appClientId = observed.appClientId ?? null;
  if (!appClientId) {
    out.push(
      env === "production"
        ? f.pending(
            "authorize",
            `the GitHub App "${desired.appSlug}" does not exist yet, so WorkOS has no client id to send people to GitHub with`,
            "founder steps D6 and D7",
          )
        : f.fail(
            "authorize",
            `GitHub shows no client id for the App "${desired.appSlug}" to compare WorkOS's redirect with`,
            "see github.app",
          ),
      methods,
    );
    return out;
  }
  for (const { id, uri, who } of REDIRECT_URIS) {
    const hop = observed.hops.find((h) => h.redirectUri === uri);
    out.push(evaluateHop(`authorize.${id}`, who, appClientId, hop));
  }
  out.push(methods);
  return out;
}

function evaluateHop(
  id: string,
  who: string,
  appClientId: string,
  hop: WorkosAnswers["hops"][number] | undefined,
): Finding {
  if (!hop) return f.fail(id, `sign-in through ${who} was not tried`);
  const isRedirect = hop.status >= 300 && hop.status < 400 && !!hop.location;
  if (!isRedirect) {
    return f.fail(
      id,
      `sign-in through ${who} answered ${hop.status} rather than a redirect to GitHub (an error page)`,
      STEP_REDIRECTS,
    );
  }
  const location = URL.canParse(hop.location as string) ? new URL(hop.location as string) : null;
  if (!location || `${location.origin}${location.pathname}` !== GITHUB_AUTHORIZE) {
    const refused = location?.pathname.includes("redirect-uri-invalid");
    return f.fail(
      id,
      refused
        ? `WorkOS refuses ${who} redirect URI ${hop.redirectUri}`
        : `sign-in through ${who} goes to ${location ? `${location.origin}${location.pathname}` : "an unreadable address"}, not GitHub`,
      refused ? STEP_REDIRECTS : "WorkOS › Authentication › GitHub: turn it on (founder step D7)",
    );
  }
  const clientId = location.searchParams.get("client_id");
  return clientId === appClientId
    ? f.ok(id, `sign-in through ${who} reaches GitHub with the App's client id ${appClientId}`)
    : f.fail(
        id,
        `sign-in through ${who} reaches GitHub with the client id ${clientId ?? "(none)"}, not the App's ${appClientId}`,
        "WorkOS › Authentication › GitHub: use the App's client id and secret (founder step D7)",
      );
}

export const workosSection: Section<WorkosDesired, WorkosObserved> = {
  area: "workos",
  needs: [],
  desired: workosDesired,
  fetchObserved: fetchWorkos,
  evaluate: evaluateWorkos,
};
