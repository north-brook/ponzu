#!/usr/bin/env bun
/**
 * After production's promotion (.github/workflows/deploy-api.yml): fails unless the minute's
 * Vercel Schedule is active in that environment. A static schedule syncs when its deployment
 * becomes the environment's current one, promotions included
 * (https://vercel.com/docs/schedules/concepts), so this polls for a short while before giving up.
 *
 *   bun scripts/ci/schedules.ts --environment production --name minute --path /v1/cron/minute
 *
 * It reads `vercel schedules list --json`, with the CLI pinned below and the job's VERCEL_TOKEN,
 * VERCEL_ORG_ID and VERCEL_PROJECT_ID. Its output was read from the CLI 65.14.0 itself: without
 * an agent it prints the API's page, `{ data, cursor, pagination }`; in agent (non-interactive)
 * mode it prints `{ status: "ok", data, cursor, pagination, message }`. Either way `data` holds
 * schedule objects as https://vercel.com/docs/schedules/http-api describes them (fetched as
 * markdown on 12 Nov 2026): `name`, `state` ("active" or "inactive"), `activeUntil` only while
 * a temporary window is open, `source`, and `target` (`{ type: "path", path, requestMethod? }`
 * for ours). A schedule enabled only until some time is not good enough for production, so
 * `activeUntil` fails it.
 *
 * Schedules hold no secret, so what the CLI answered is printed when the check fails.
 */

/** The CLI every deploy step uses; workflows.test.ts holds the two to the same version. */
export const VERCEL_CLI = "vercel@65.14.0";

export interface Want {
  name: string;
  path: string;
}

/** What is wrong with a `schedules list --json` answer; empty when the schedule is right. */
export function scheduleProblems(answer: unknown, want: Want): string[] {
  if (!answer || typeof answer !== "object") return ["the CLI's answer is not JSON"];
  const page = answer as Record<string, unknown>;
  if (typeof page.status === "string" && page.status !== "ok")
    return [`the CLI answered ${page.status}: ${String(page.message ?? page.reason ?? "")}`];
  if (!Array.isArray(page.data)) return ["the CLI's answer has no data list"];
  const found = page.data.find(
    (s): s is Record<string, unknown> =>
      !!s && typeof s === "object" && (s as { name?: unknown }).name === want.name,
  );
  if (!found)
    return [
      page.cursor
        ? `no schedule named ${want.name} on the first page, and more pages follow`
        : `no schedule named ${want.name}`,
    ];
  const out: string[] = [];
  if (found.state !== "active") out.push(`${want.name} is ${JSON.stringify(found.state)}`);
  if (found.activeUntil !== undefined && found.activeUntil !== null)
    out.push(`${want.name} is active only until ${String(found.activeUntil)}`);
  const target = found.target as Record<string, unknown> | undefined;
  if (target?.type !== "path" || target.path !== want.path)
    out.push(`${want.name} targets ${JSON.stringify(target ?? null)}, not the path ${want.path}`);
  else if ((target.requestMethod ?? "POST") !== "GET")
    out.push(`${want.name} sends ${String(target.requestMethod ?? "POST")}, not GET`);
  return out;
}

export type Run = (argv: string[]) => Promise<{ code: number; stdout: string }>;

export interface Poll {
  run?: Run;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  intervalMs?: number;
  deadlineMs?: number;
}

/** The CLI's arguments for one environment's list. Production is the CLI's default. */
export function listArgs(environment: string): string[] {
  return ["bunx", VERCEL_CLI, "schedules", "list", "--json", "--limit", "100"].concat(
    environment === "production" ? [] : ["--environment", environment],
  );
}

const spawn: Run = async (argv) => {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "inherit" });
  const stdout = await new Response(child.stdout).text();
  return { code: await child.exited, stdout };
};

/** Polls the list until the schedule is right, or the deadline passes. */
export async function waitForSchedule(
  environment: string,
  want: Want,
  {
    run = spawn,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalMs = 10_000,
    deadlineMs = 120_000,
  }: Poll = {},
): Promise<{ ok: boolean; problems: string[]; answer: string }> {
  const started = now();
  for (;;) {
    const { code, stdout } = await run(listArgs(environment));
    let problems: string[];
    try {
      problems = scheduleProblems(JSON.parse(stdout), want);
    } catch {
      problems = [`the CLI exited ${code} without JSON`];
    }
    if (!problems.length && code !== 0) problems = [`the CLI exited ${code}`];
    if (!problems.length) return { ok: true, problems, answer: stdout };
    if (now() - started + intervalMs > deadlineMs) return { ok: false, problems, answer: stdout };
    await wait(intervalMs);
  }
}

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const environment = arg(argv, "--environment");
  const name = arg(argv, "--name");
  const path = arg(argv, "--path");
  if (!environment || !name || !path) {
    console.error(
      "usage: bun scripts/ci/schedules.ts --environment <production|slug> --name <schedule> --path <route>",
    );
    process.exit(2);
  }
  const result = await waitForSchedule(environment, { name, path });
  if (!result.ok) {
    console.log(result.answer);
    console.log(
      `::error title=The ${name} schedule is not active in ${environment}::${result.problems.join("; ")}`,
    );
    process.exit(1);
  }
  console.log(`${name} is active in ${environment} and runs GET ${path}.`);
}
