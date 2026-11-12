#!/usr/bin/env bun
/**
 * After a deploy (.github/workflows/deploy-api.yml): polls an environment's `/v1/health` until it
 * answers what was just deployed, or fails naming what differs. What was deployed is read from
 * this checkout, so it is the commit the workflow ran on:
 *
 * - `status` ok and `database` true;
 * - `environment` is the one deployed to (so a domain still pointing at the other project fails);
 * - `commit` is this commit;
 * - `image` is apps/runner/image/current.json's;
 * - `migrations.applied` equals `migrations.expected`, which equals this checkout's journal.
 *
 *   bun scripts/ci/health.ts --env <dev|production> --commit <sha> [--url <origin>]
 *
 * The origin defaults to the environment's `apiUrl` in infra/environments.json. Health answers
 * hold no secret, so the last answer is printed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

export interface Expected {
  environment: string;
  commit: string;
  image: string;
  migrations: number;
}

/** What differs between a health answer and what was deployed; empty when nothing does. */
export function differences(body: unknown, expected: Expected): string[] {
  if (!body || typeof body !== "object") return ["the answer is not JSON"];
  const health = body as Record<string, any>;
  const out: string[] = [];
  const same = (what: string, got: unknown, want: unknown) => {
    if (got !== want) out.push(`${what} is ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  };
  same("status", health.status, "ok");
  same("database", health.database, true);
  same("environment", health.environment, expected.environment);
  same("commit", health.commit, expected.commit);
  same("image", health.image, expected.image);
  same("migrations.expected", health.migrations?.expected, expected.migrations);
  same("migrations.applied", health.migrations?.applied, expected.migrations);
  return out;
}

/** This checkout's deploy: its image and its journal's length. */
export function expectedFromCheckout(environment: string, commit: string, root = ROOT): Expected {
  const current = JSON.parse(readFileSync(join(root, "apps/runner/image/current.json"), "utf8"));
  const journal = JSON.parse(
    readFileSync(join(root, "packages/db/migrations/meta/_journal.json"), "utf8"),
  );
  return { environment, commit, image: current.image, migrations: journal.entries.length };
}

export function apiUrlOf(environment: string, root = ROOT): string {
  const infra = JSON.parse(readFileSync(join(root, "infra/environments.json"), "utf8"));
  const url = infra.environments?.[environment]?.apiUrl;
  if (typeof url !== "string")
    throw new Error(`infra/environments.json has no apiUrl for ${environment}.`);
  return url;
}

export interface Poll {
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  intervalMs?: number;
  deadlineMs?: number;
}

/** Polls until health matches, or the deadline passes. Answers the last differences seen. */
export async function waitForHealth(
  url: string,
  expected: Expected,
  {
    fetch: fetcher = fetch,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalMs = 10_000,
    deadlineMs = 120_000,
  }: Poll = {},
): Promise<{ ok: boolean; problems: string[]; body: unknown }> {
  const started = now();
  for (;;) {
    let body: unknown = null;
    let problems: string[];
    try {
      const response = await fetcher(`${url.replace(/\/$/, "")}/v1/health`, {
        signal: AbortSignal.timeout(20_000),
      });
      body = await response.json().catch(() => null);
      problems = differences(body, expected);
    } catch (error) {
      problems = [`no answer: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (!problems.length) return { ok: true, problems, body };
    if (now() - started + intervalMs > deadlineMs) return { ok: false, problems, body };
    await wait(intervalMs);
  }
}

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const environment = arg(argv, "--env");
  const commit = arg(argv, "--commit");
  if (!environment || !commit) {
    console.error(
      "usage: bun scripts/ci/health.ts --env <dev|production> --commit <sha> [--url <origin>]",
    );
    process.exit(2);
  }
  const url = arg(argv, "--url") ?? apiUrlOf(environment);
  const result = await waitForHealth(url, expectedFromCheckout(environment, commit));
  console.log(JSON.stringify(result.body));
  if (!result.ok) {
    console.log(`::error title=${url} is not what was deployed::${result.problems.join("; ")}`);
    process.exit(1);
  }
  console.log(`${url} answers ${environment} at ${commit} with every migration applied.`);
}
