/**
 * The shape every part of the apply script shares (docs/production.md, "Applying the desired
 * state"). An area reads what is live (GETs only, mostly through the check's own readers),
 * compares it with `infra/`, and returns a plan: the exact requests that would make it right, and
 * the things only a person can do. Without `--yes` the plan is printed and nothing else happens.
 * With `--yes` each request is sent in order, and then the area is read again: the plan must have
 * nothing left to do, and the check's lines for that area must be `ok`.
 */
import type { CheckContext, CredentialName, Finding } from "../checks/finding.ts";

/** One request, as it goes on the wire. The dry run prints it; tests compare it exactly. */
export interface WireRequest {
  method: "POST" | "PUT" | "PATCH";
  url: string;
  body: unknown;
}

export interface Change {
  /** One sentence: what is wrong now, and what the request does about it. */
  says: string;
  request: WireRequest;
  /** Sends the request. Called only with `--yes`, in plan order. */
  send(): Promise<void>;
}

export interface Plan {
  /** What already matches, and what apply cannot do (a founder step, a dashboard), one line each. */
  notes: string[];
  changes: Change[];
}

export interface ApplyContext extends CheckContext {
  /** Arguments after the area (`generate --names A,B` for secrets). */
  args: readonly string[];
  /**
   * Hands a value to the printer's redactor. Every value an area generates goes through this
   * before anything else happens, so not even an error that quoted it could print it.
   */
  secret(value: string): void;
}

export interface ApplyArea {
  name: string;
  /** Credentials the area needs; one missing stops it before anything is read. */
  needs: readonly CredentialName[];
  /** Credentials of which at least one is needed (GH_TOKEN or GITHUB_TOKEN). */
  needsOneOf?: readonly CredentialName[];
  /** Whether `--env` may be left out: the repository's rulesets are one for both. */
  envless?: boolean;
  /** `apply.ts <area> --help` and the usage line. */
  usage?: string;
  plan(ctx: ApplyContext): Promise<Plan>;
  /** After `--yes`: the check's lines for this area, read again. Each must be `ok`. */
  verify?(ctx: ApplyContext): Promise<Finding[]>;
}

/** `{ … }` as the dry run prints a body: two-space JSON, indented under its request. */
export function formatBody(body: unknown): string[] {
  return JSON.stringify(body, null, 2)
    .split("\n")
    .map((line) => `      ${line}`);
}

/** Only the given finding ids (or ids under a prefix ending in "."), for `verify`. */
export function pick(findings: readonly Finding[], ids: readonly string[]): Finding[] {
  return findings.filter((f) =>
    ids.some((id) => (id.endsWith(".") ? f.id.startsWith(id) : f.id === id)),
  );
}

/** A status-only error, so a vendor's body (which could quote what was sent) never prints. */
export function statusError(vendor: string, status: number | null, what: string): Error {
  return new Error(
    status === null
      ? `${vendor} could not be reached for ${what}`
      : `${vendor} answered ${status} for ${what}`,
  );
}

/** A plain `fetch` that refuses redirects and fails on any status but 2xx, saying only the status. */
export async function send(
  ctx: Pick<CheckContext, "fetch">,
  vendor: string,
  request: WireRequest,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await ctx.fetch(request.url, {
    method: request.method,
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(request.body),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw statusError(
      vendor,
      response.status,
      `${request.method} ${new URL(request.url).pathname}`,
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
