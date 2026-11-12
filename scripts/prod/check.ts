#!/usr/bin/env bun
/**
 * The production check (docs/production.md, "Checking production"): every resource an
 * environment runs on, read and compared with what the repository says (`infra/`, the API's
 * env.ts and vercel.json, current.json).
 *
 *   bun scripts/prod/check.ts --env dev|production [--json] [--deep]
 *
 * It is read-only, and it never asks a vendor to decrypt a value. `--deep` is the one exception
 * to read-only: it makes one throwaway sandbox and removes it (checks/deep.ts); on production
 * only the founder runs it.
 *
 * Each line is `ok`, `fail`, `pending` (not created yet, naming the founder step), `manual` (a
 * dashboard a person confirms) or `skipped` (a credential is missing). It exits 0 only when every
 * line is `ok` or `manual`: a skipped or pending line is never a pass.
 *
 * Credentials come from the environment of whoever runs it (checks/finding.ts names them):
 * VERCEL_TOKEN and optionally VERCEL_TEAM_ID for Vercel, CRON_SECRET for the API's selfcheck,
 * GH_TOKEN or GITHUB_TOKEN for GitHub. Every line printed goes through `@ponzu/core/redact`
 * with every credential present as a known secret, so even a vendor's error message that quoted
 * one would not print it.
 *
 * Each vendor is one section in checks/: `fetchObserved` reads it, `evaluate` (pure) judges what
 * was read, and tests run `evaluate` on answers recorded from dev (fixtures/<vendor>/). Later
 * slices add Neon, Cloudflare, GitHub, WorkOS and PostHog to SECTIONS.
 */
import { redactText } from "../../packages/core/src/redact.ts";
import { apiSection } from "./checks/api.ts";
import { deepSection } from "./checks/deep.ts";
import { dnsSection } from "./checks/dns.ts";
import {
  type AnySection,
  type CheckContext,
  CREDENTIAL_NAMES,
  type Credentials,
  describeError,
  type Finding,
  PASSING,
  STATUSES,
  type Status,
} from "./checks/finding.ts";
import { spendSection } from "./checks/spend.ts";
import { vercelSection } from "./checks/vercel.ts";
import { EnvironmentName, loadInfra } from "./desired.ts";

/** Every section, in the order its lines print. */
export const SECTIONS: readonly AnySection[] = [
  vercelSection,
  apiSection,
  dnsSection,
  spendSection,
  deepSection,
];

/** One section's lines. A missing credential, or a section that throws, is a line, not a crash. */
export async function runSection(section: AnySection, ctx: CheckContext): Promise<Finding[]> {
  const { area } = section;
  if (section.deepOnly && !ctx.deep) return [];
  const missing = section.needs.filter((name) => !ctx.credentials[name]);
  if (missing.length) {
    return [
      {
        id: `${area}.credentials`,
        area,
        status: "skipped",
        says: `skipped (no ${missing.join(", no ")})`,
        fix: `set ${missing.join(" and ")} in the environment (docs/production.md › Checking production)`,
      },
    ];
  }
  const failed = (what: string, error: unknown): Finding[] => [
    {
      id: `${area}.${what}`,
      area,
      status: "fail",
      says: `could not be ${what === "read" ? "read" : "judged"}: ${describeError(error)}`,
    },
  ];
  let desired: unknown;
  let observed: unknown;
  try {
    desired = section.desired(ctx);
  } catch (error) {
    return failed("desired", error);
  }
  try {
    observed = await section.fetchObserved(ctx, desired);
  } catch (error) {
    return failed("read", error);
  }
  try {
    return section.evaluate(desired, observed);
  } catch (error) {
    return failed("evaluate", error);
  }
}

export interface CheckResult {
  env: EnvironmentName;
  findings: Finding[];
  exitCode: 0 | 1;
}

/** Every section at once; the lines come back in SECTIONS order. */
export async function runCheck(
  ctx: CheckContext,
  sections: readonly AnySection[] = SECTIONS,
): Promise<CheckResult> {
  const findings = (await Promise.all(sections.map((s) => runSection(s, ctx)))).flat();
  return { env: ctx.env, findings, exitCode: exitCode(findings) };
}

/** 0 only when there is at least one line and every line is `ok` or `manual`. */
export function exitCode(findings: readonly Finding[]): 0 | 1 {
  return findings.length && findings.every((f) => PASSING.has(f.status)) ? 0 : 1;
}

/** `fail    vercel.env.forbidden  BOAT_API_KEY is set on preview and production`, then the fix. */
export function formatFinding(finding: Finding): string[] {
  const line = `${finding.status.padEnd(8)}${finding.id}  ${finding.says}`;
  return finding.fix && finding.status !== "ok" ? [line, `        ↳ ${finding.fix}`] : [line];
}

export function summary(findings: readonly Finding[]): string {
  const counts = STATUSES.map(
    (status: Status) => [status, findings.filter((f) => f.status === status).length] as const,
  )
    .filter(([, n]) => n)
    .map(([status, n]) => `${n} ${status}`);
  return counts.join(", ");
}

/** The credentials present in `env`, trimmed; empty ones count as missing. */
export function readCredentials(env: Record<string, string | undefined>): Credentials {
  const out: Credentials = {};
  for (const name of CREDENTIAL_NAMES) {
    const value = env[name]?.trim();
    if (value) out[name] = value;
  }
  return out;
}

const USAGE = "usage: bun scripts/prod/check.ts --env <dev|production> [--json] [--deep]";

export interface Io {
  /** stdout, one line a call. */
  print: (line: string) => void;
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

const realIo: Io = {
  print: (line) => console.log(line),
  env: process.env,
  fetch: globalThis.fetch,
  now: () => new Date(),
};

/** Runs the command line; returns the exit code. Every line goes through the redactor. */
export async function main(
  argv: readonly string[],
  io: Io = realIo,
  sections: readonly AnySection[] = SECTIONS,
): Promise<number> {
  const args = [...argv];
  const envAt = args.indexOf("--env");
  const env = EnvironmentName.safeParse(envAt === -1 ? undefined : args[envAt + 1]);
  const rest = args.filter((_, i) => envAt === -1 || (i !== envAt && i !== envAt + 1));
  const json = rest.includes("--json");
  const deep = rest.includes("--deep");
  const unknown = rest.filter((arg) => arg !== "--json" && arg !== "--deep");
  if (!env.success || unknown.length) {
    io.print(USAGE);
    return 2;
  }
  const credentials = readCredentials(io.env);
  const known = Object.values(credentials).filter((value): value is string => !!value);
  const print = (line: string) => io.print(redactText(line, known));
  const ctx: CheckContext = {
    env: env.data,
    infra: loadInfra(),
    credentials,
    fetch: io.fetch,
    now: io.now,
    deep,
  };
  const result = await runCheck(ctx, sections);
  if (json) {
    print(JSON.stringify(result, null, 2));
    return result.exitCode;
  }
  print(`Ponzu ${env.data}: ${deep ? "deep " : ""}check of every resource against infra/`);
  for (const finding of result.findings) for (const line of formatFinding(finding)) print(line);
  print(summary(result.findings));
  return result.exitCode;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        redactText(describeError(error), Object.values(readCredentials(process.env)) as string[]),
      );
      process.exit(1);
    },
  );
}
