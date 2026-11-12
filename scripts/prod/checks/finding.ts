/**
 * The shape every part of the production check shares (docs/production.md, "Checking
 * production"). A section reads one vendor (`fetchObserved`, the only part that talks to the
 * network) and judges what it read against the repository's desired state (`evaluate`, pure, so
 * tests run it on recorded fixtures). What it judges comes back as findings, one line each.
 */
import { ZodError } from "zod";
import type { EnvironmentName, Infra } from "../desired.ts";

/**
 * - `ok`: as the repository says.
 * - `fail`: not as the repository says, or could not be read.
 * - `pending`: not created yet; the founder step that creates it is named. Never a pass.
 * - `manual`: lives in a dashboard the check cannot read; a person confirms it.
 * - `skipped`: not checked, because a credential is missing. Never a pass.
 */
export const STATUSES = ["ok", "fail", "pending", "manual", "skipped"] as const;
export type Status = (typeof STATUSES)[number];

/** Which statuses let the check exit 0. Everything else is a reason to look. */
export const PASSING: ReadonlySet<Status> = new Set(["ok", "manual"]);

export interface Finding {
  /** `<area>.<what>`, stable across runs, so a person can grep for it. */
  id: string;
  area: string;
  status: Status;
  /** One sentence: what was found. Never a secret; printed through the redactor anyway. */
  says: string;
  /** The runbook step or the exact command that makes it right, when it is not. */
  fix?: string;
}

/**
 * The credentials the check reads from the environment of whoever runs it. Each is read-only
 * where the vendor offers that. None is ever printed, and every one present is handed to the
 * redactor as a known secret.
 */
export const CREDENTIAL_NAMES = [
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "CRON_SECRET",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NEON_API_KEY",
  /** Not a secret, but not published either: kept out of every printed line all the same. */
  "NEON_PROJECT_ID",
  "CLOUDFLARE_API_TOKEN",
  /** The Cloudflare account that owns the buckets and the zone (R2's account id). */
  "CLOUDFLARE_ACCOUNT_ID",
  "POSTHOG_PERSONAL_API_KEY",
  /**
   * The repository secret Release Please runs with, given only so the check can read its expiry
   * from GitHub's answer to it (checks/github.ts). Optional: without it that one line is skipped.
   */
  "RELEASE_TOKEN",
] as const;
export type CredentialName = (typeof CREDENTIAL_NAMES)[number];
export type Credentials = Partial<Record<CredentialName, string>>;

/** What every section is handed. Tests build one with fakes. */
export interface CheckContext {
  env: EnvironmentName;
  infra: Infra;
  credentials: Credentials;
  /** The network. Tests pass a fake that answers from fixtures. */
  fetch: typeof globalThis.fetch;
  now: () => Date;
  deep: boolean;
}

export interface Section<Desired = unknown, Observed = unknown> {
  area: string;
  /** Credentials the whole section needs. One missing skips the section, naming it. */
  needs: readonly CredentialName[];
  /** Runs only with `--deep`. */
  deepOnly?: boolean;
  /** What the repository says, for this environment. Pure; reads only `ctx.infra` and files. */
  desired(ctx: CheckContext): Desired;
  /** Reads the vendor. Read-only: it never creates, changes or decrypts anything. */
  fetchObserved(ctx: CheckContext, desired: Desired): Promise<Observed>;
  /** Pure: the same desired and observed always give the same findings. */
  evaluate(desired: Desired, observed: Observed): Finding[];
}

/** A section with its types erased, for the list the check runs. */
export type AnySection = Section<any, any>;

/** Builds findings for one area: `f.ok("project", "…")` is `{ id: "vercel.project", … }`. */
export function findings(area: string) {
  const make =
    (status: Status) =>
    (what: string, says: string, fix?: string): Finding => ({
      id: `${area}.${what}`,
      area,
      status,
      says,
      ...(fix ? { fix } : {}),
    });
  return {
    ok: make("ok"),
    fail: make("fail"),
    pending: make("pending"),
    manual: make("manual"),
    skipped: make("skipped"),
  };
}

/** "a, b and c". */
export function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What an error says, in one short line, without its stack or a response body. */
export function describeError(error: unknown): string {
  // A schema's error message is its issues as multi-line JSON; the first line would be "[".
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return `answered in a shape the check does not know (${where}${issue?.message ?? "invalid"})`.slice(
      0,
      160,
    );
  }
  if (error instanceof Error) {
    const status = (error as { statusCode?: unknown }).statusCode;
    const first = error.message.split("\n")[0]?.slice(0, 160) ?? "";
    return typeof status === "number" ? `${status}: ${first}` : first || error.name;
  }
  return String(error).slice(0, 160);
}
