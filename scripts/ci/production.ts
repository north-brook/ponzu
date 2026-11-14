#!/usr/bin/env bun
/**
 * The production job's way back (.github/workflows/deploy-api.yml).
 *
 *   bun scripts/ci/production.ts serving
 *     Before the promotion: which deployment serves api.ponzu.design now, and which commit it
 *     answers. Writes `url` and `commit` to $GITHUB_OUTPUT. Fails when either can't be read, so
 *     a deploy never promotes without a deployment recorded to go back to.
 *
 *   bun scripts/ci/production.ts restored --commit <sha>
 *     After the job has promoted that deployment back: api.ponzu.design answers with that
 *     commit again, healthy, as production.
 *
 * The deployment is read through Vercel's SDK (`GET /v13/deployments/{idOrUrl}`, which takes a
 * hostname, the production domain included) with the production job's token, VERCEL_TOKEN,
 * VERCEL_ORG_ID (the team) and VERCEL_PROJECT_ID. It must be this project's, a production
 * build and ready: promoting anything else "will result in a new production deployment"
 * (https://vercel.com/docs/cli/promote), and the job's promote passes no `--yes`, so the CLI
 * would refuse it anyway. The commit comes from production's public `/v1/health`.
 *
 * The way back is a promotion of that recorded URL, never a bare `vercel rollback`, which goes
 * to whatever Vercel holds as the previous production deployment (docs/production.md, "The
 * minute", says why that can leave production with no minute). The database is left alone:
 * migrations are expand only, so the code that was serving runs on the new schema.
 *
 * Nothing here prints a token. Deployment URLs and commits are not secrets.
 */
import { appendFileSync } from "node:fs";
import { Vercel } from "@vercel/sdk";
import { HTTPClient } from "@vercel/sdk/lib/http.js";
import { answer } from "../prod/checks/vercel.ts";
import { apiUrlOf } from "./health.ts";

export interface Serving {
  url: string;
  commit: string;
}

/** Why a deployment answer is not one to go back to, or null when it is. */
export function servingProblem(deployment: unknown, projectId: string): string | null {
  const d = (deployment ?? {}) as Record<string, unknown>;
  if (d.projectId !== projectId) return `it belongs to project ${String(d.projectId)}`;
  if (d.target !== "production") return `it is a ${String(d.target ?? "preview")} build`;
  if (d.readyState !== "READY") return `it is ${String(d.readyState)}`;
  if (typeof d.url !== "string" || !/^[a-z0-9-]+\.vercel\.app$/.test(d.url))
    return `its address is ${JSON.stringify(d.url ?? null)}`;
  return null;
}

/** The health of production's public address: what it says, or why it can't be read. */
export async function healthOf(
  url: string,
  fetcher: typeof fetch,
): Promise<{ body: Record<string, unknown> } | { error: string }> {
  try {
    const response = await fetcher(`${url}/v1/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== "object") return { error: `answered ${response.status}` };
    return { body: body as Record<string, unknown> };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface Vendors {
  /** The deployment a hostname serves, as Vercel answers it. */
  deployment(host: string): Promise<unknown>;
  fetch: typeof fetch;
}

/** The deployment serving production now, and its commit. */
export async function serving(
  publicUrl: string,
  projectId: string,
  vendors: Vendors,
): Promise<Serving | { error: string }> {
  const host = new URL(publicUrl).host;
  let deployment: unknown;
  try {
    deployment = await vendors.deployment(host);
  } catch (error) {
    return {
      error: `Vercel did not say which deployment serves ${host}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const problem = servingProblem(deployment, projectId);
  if (problem)
    return { error: `The deployment serving ${host} is not one to go back to: ${problem}.` };
  const read = await healthOf(publicUrl, vendors.fetch);
  if ("error" in read) return { error: `${publicUrl}/v1/health: ${read.error}` };
  const commit = read.body.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit))
    return { error: `${publicUrl}/v1/health names no commit.` };
  return { url: `https://${(deployment as { url: string }).url}`, commit };
}

export interface Poll {
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  intervalMs?: number;
  deadlineMs?: number;
}

/**
 * Polls production's public health until it answers `commit`, ok, with its database, as
 * production. The migration count is not compared: the code that was serving expects fewer
 * migrations than the database now has, which is what expand only allows.
 */
export async function restored(
  publicUrl: string,
  commit: string,
  fetcher: typeof fetch,
  {
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalMs = 10_000,
    deadlineMs = 180_000,
  }: Poll = {},
): Promise<{ ok: boolean; problem: string | null }> {
  const started = now();
  for (;;) {
    const read = await healthOf(publicUrl, fetcher);
    const health = "body" in read ? read.body : {};
    let problem: string | null = null;
    if ("error" in read) problem = read.error;
    else if (health.commit !== commit) problem = `it answers ${String(health.commit)}`;
    else if (health.status !== "ok") problem = `its status is ${String(health.status)}`;
    else if (health.database !== true) problem = "it cannot reach its database";
    else if (health.environment !== "production")
      problem = `it says it is ${String(health.environment)}`;
    if (!problem) return { ok: true, problem: null };
    if (now() - started + intervalMs > deadlineMs) return { ok: false, problem };
    await wait(intervalMs);
  }
}

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

const oneLine = (text: string) => text.replace(/[\r\n%]/g, " ");

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  const publicUrl = apiUrlOf("production").replace(/\/$/, "");
  if (command === "serving") {
    const token = process.env.VERCEL_TOKEN;
    const teamId = process.env.VERCEL_ORG_ID;
    const projectId = process.env.VERCEL_PROJECT_ID;
    if (!token || !teamId || !projectId) {
      console.log(
        "::error title=Cannot read production's deployment::VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID must all be set.",
      );
      process.exit(1);
    }
    const vercel = new Vercel({
      bearerToken: token,
      httpClient: new HTTPClient({ fetcher: (input, init) => fetch(input, init) }),
    });
    const result = await serving(publicUrl, projectId, {
      deployment: (host) =>
        answer(() => vercel.deployments.getDeployment({ idOrUrl: host, teamId })),
      fetch,
    });
    if ("error" in result) {
      console.log(`::error title=No deployment to go back to::${oneLine(result.error)}`);
      process.exit(1);
    }
    console.log(`${publicUrl} is served by ${result.url}, at ${result.commit}.`);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `url=${result.url}\ncommit=${result.commit}\n`);
  } else if (command === "restored") {
    const commit = arg(argv, "--commit");
    if (!commit) {
      console.error("usage: bun scripts/ci/production.ts restored --commit <sha>");
      process.exit(2);
    }
    const result = await restored(publicUrl, commit, fetch);
    if (!result.ok) {
      console.log(
        `::error title=Production is NOT back on ${commit.slice(0, 12)}::${oneLine(result.problem ?? "")}. Look now: docs/production.md, "The production deploy, staged".`,
      );
      process.exit(1);
    }
    console.log(
      `::warning title=Production was put back on ${commit.slice(0, 12)}::The new deployment failed its checks after promotion. ${publicUrl} serves the deployment that was serving before, on the migrated database.`,
    );
  } else {
    console.error("usage: bun scripts/ci/production.ts serving | restored --commit <sha>");
    process.exit(2);
  }
}
