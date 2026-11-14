#!/usr/bin/env bun
/**
 * After dev's deploy (.github/workflows/deploy-api.yml): the API's own checks of its keys and
 * settings, `GET /v1/cron/selfcheck` with the cron secret, must all pass, apart from the ones
 * known to fail on that environment (`KNOWN`, each with its reason; docs/production.md, "The
 * production deploy, staged").
 *
 *   CRON_SECRET=… bun scripts/ci/selfcheck.ts --env dev
 *
 * The secret goes only to the environment's own `apiUrl` (infra/environments.json), and only
 * after its health has said it is that environment, so dev's secret never reaches production.
 * The selfcheck answers in fixed words that never quote a secret (apps/api/src/ops/selfcheck.ts),
 * so its answer is printed.
 */
import { apiUrlOf } from "./health.ts";

/** Checks that fail on an environment for a known reason that a deploy cannot fix. */
export const KNOWN: Record<string, Record<string, string>> = {
  dev: {
    // Values sealed under dev's previous vault key remain until someone runs the reseal
    // (docs/production.md, "Rotating secrets"); every value still opens.
    vault_old_keys: "values remain sealed with an older vault key; the reseal is owed",
  },
};

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

/** What fails, apart from the known; and the known that failed, to say so. */
export function judge(environment: string, body: unknown): { problems: string[]; known: string[] } {
  const checks = (body as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return { problems: ["the answer has no checks"], known: [] };
  const known = KNOWN[environment] ?? {};
  const problems: string[] = [];
  const excused: string[] = [];
  for (const check of checks as Check[]) {
    if (check.ok) continue;
    if (known[check.id]) excused.push(`${check.id} (${check.detail}): ${known[check.id]}`);
    else problems.push(`${check.id} is ${check.detail}`);
  }
  if (!checks.length) problems.push("the answer lists no check");
  return { problems, known: excused };
}

export interface Ask {
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  intervalMs?: number;
  deadlineMs?: number;
}

/**
 * Asks health, then the selfcheck, until it passes or the deadline passes. A fresh deployment's
 * first answers can lag (a cold start, the minute not yet run on it), so it asks again.
 */
export async function selfcheck(
  url: string,
  environment: string,
  secret: string,
  {
    fetch: fetcher = fetch,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalMs = 15_000,
    deadlineMs = 120_000,
  }: Ask = {},
): Promise<{ ok: boolean; problems: string[]; known: string[]; body: unknown }> {
  const started = now();
  for (;;) {
    let body: unknown = null;
    let result: { problems: string[]; known: string[] };
    try {
      const health = await fetcher(`${url}/v1/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const said = ((await health.json().catch(() => null)) as { environment?: unknown } | null)
        ?.environment;
      if (said !== environment) {
        result = {
          problems: [`health says ${JSON.stringify(said ?? null)}, not ${environment}`],
          known: [],
        };
      } else {
        const response = await fetcher(`${url}/v1/cron/selfcheck`, {
          headers: { authorization: `Bearer ${secret}` },
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        });
        body = await response.json().catch(() => null);
        result =
          response.status === 200
            ? judge(environment, body)
            : { problems: [`the selfcheck answered ${response.status}`], known: [] };
      }
    } catch (error) {
      result = {
        problems: [`no answer: ${error instanceof Error ? error.message : String(error)}`],
        known: [],
      };
    }
    if (!result.problems.length) return { ok: true, ...result, body };
    if (now() - started + intervalMs > deadlineMs) return { ok: false, ...result, body };
    await wait(intervalMs);
  }
}

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

if (import.meta.main) {
  const environment = arg(process.argv.slice(2), "--env");
  if (!environment) {
    console.error("usage: CRON_SECRET=… bun scripts/ci/selfcheck.ts --env <dev|production>");
    process.exit(2);
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.log(
      `::error title=No cron secret::The ${environment} environment has no CRON_SECRET, so its selfcheck cannot be asked.`,
    );
    process.exit(1);
  }
  const url = apiUrlOf(environment).replace(/\/$/, "");
  const result = await selfcheck(url, environment, secret);
  console.log(JSON.stringify(result.body));
  for (const known of result.known) console.log(`::notice title=Known on ${environment}::${known}`);
  if (!result.ok) {
    console.log(
      `::error title=${environment}'s selfcheck fails::${result.problems.join("; ").replace(/[\r\n%]/g, " ")}`,
    );
    process.exit(1);
  }
  console.log(
    `${environment}'s selfcheck passes${result.known.length ? " apart from the known" : ""}.`,
  );
}
