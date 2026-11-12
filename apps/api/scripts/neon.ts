// The connection string of a Neon branch, asked of the Neon API by the branch's name.
//
//   bun scripts/neon.ts dev            the pooled URL, which is what DATABASE_URL takes
//   bun scripts/neon.ts dev --direct   the direct URL, which is what `db:migrate` takes
//
// The project's default branch is production after cutover, and a key that reaches dev reaches
// it too, so asking for it by name is always refused. Only the production deploy job
// (.github/workflows/deploy-api.yml) asks for it, with `--default` and the guard variable
// PONZU_ALLOW_DEFAULT_BRANCH=production, which nothing else sets:
//
//   bun scripts/neon.ts --default --direct               the default branch's direct URL
//   bun scripts/neon.ts --default --snapshot pre-<sha>   a snapshot of it, kept 14 days, taken
//                                                        before a production migration; prints
//                                                        the snapshot's id once Neon has made it
//
// Needs NEON_API_KEY and NEON_PROJECT_ID. It prints a credential: pipe it, don't paste it.

import { createApiClient } from "@neondatabase/api-client";

const API = "https://console.neon.tech/api/v2";

/** The only value of PONZU_ALLOW_DEFAULT_BRANCH that lets `--default` through. */
export const DEFAULT_BRANCH_GUARD = "production";
/** How long a pre-migration snapshot is kept (docs/production.md, "Neon"). */
export const SNAPSHOT_DAYS = 14;

interface Branch {
  id: string;
  name: string;
  default: boolean;
}

interface NeonProject {
  apiKey: string;
  projectId: string;
  /** For tests; the real one otherwise. */
  fetch?: typeof fetch;
}

/** Which branch: one by its name (never the default), or the default branch behind its guard. */
export type BranchChoice = { name: string } | { default: true; guard: string | undefined };

function neon({ apiKey, projectId, fetch: fetcher = fetch }: NeonProject) {
  return async (path: string, method: "GET" | "POST" = "GET") => {
    const response = await fetcher(`${API}/projects/${projectId}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Neon answered ${response.status} for ${path.split("?")[0]}`);
    return (await response.json()) as any;
  };
}

/**
 * Refuses the default branch before any request is made unless its guard is exactly
 * `production`, so a missing or mistyped variable never reaches Neon.
 */
export function assertDefaultAllowed(guard: string | undefined): void {
  if (guard !== DEFAULT_BRANCH_GUARD)
    throw new Error(
      `The default branch is production. Only the production deploy job asks for it, with PONZU_ALLOW_DEFAULT_BRANCH=${DEFAULT_BRANCH_GUARD}.`,
    );
}

function label(choice: BranchChoice): string {
  return "name" in choice ? `"${choice.name}"` : "the default branch";
}

/**
 * A branch by its name refuses the project's default branch whatever that is called: until
 * cutover that branch is nobody's to develop against, and after it, it is production. The
 * default branch itself is found only behind its guard.
 */
async function findBranch(get: ReturnType<typeof neon>, choice: BranchChoice): Promise<Branch> {
  if (!("name" in choice)) assertDefaultAllowed(choice.guard);
  const { branches } = (await get("/branches")) as { branches: Branch[] };
  if (!("name" in choice)) {
    const branch = branches.find((candidate) => candidate.default);
    if (!branch) throw new Error("The Neon project has no default branch.");
    return branch;
  }
  const branch = branches.find((candidate) => candidate.name === choice.name);
  if (!branch) throw new Error(`The Neon project has no branch named "${choice.name}".`);
  if (branch.default)
    throw new Error(`"${choice.name}" is the project's default branch. Not that one.`);
  return branch;
}

function chosen(branch: string | BranchChoice): BranchChoice {
  return typeof branch === "string" ? { name: branch } : branch;
}

export async function branchDatabaseUrl(
  branch: string | BranchChoice,
  { direct = false, ...project }: NeonProject & { direct?: boolean },
): Promise<string> {
  const choice = chosen(branch);
  const get = neon(project);
  const found = await findBranch(get, choice);
  const { databases } = await get(`/branches/${found.id}/databases`);
  const database = databases[0];
  if (!database) throw new Error(`The Neon branch ${label(choice)} has no database.`);
  const query = new URLSearchParams({
    branch_id: found.id,
    database_name: database.name,
    role_name: database.owner_name,
    pooled: "true",
  });
  const { uri } = (await get(`/connection_uri?${query}`)) as { uri: string };
  // Neon hands back the pooler's host either way; the direct host is the same without the suffix.
  return direct ? uri.replace("-pooler.", ".") : uri;
}

/** A branch's Realtime: the URL clients subscribe to and the secret the API seals with. */
export async function branchRealtime(
  name: string,
  project: NeonProject,
): Promise<{ url: string; secret: string }> {
  const get = neon(project);
  const branch = await findBranch(get, { name });
  const realtime = await get(`/branches/${branch.id}/realtime`);
  if (!realtime.enabled) throw new Error(`Realtime is not enabled on the Neon branch "${name}".`);
  const { secret } = await get(`/branches/${branch.id}/realtime/secret`);
  return { url: realtime.invocation_url, secret };
}

/** Neon's operation states that are over; anything else is still going. */
const SETTLED = new Set(["finished", "skipped", "failed", "error", "cancelled"]);

/**
 * Snapshots the default branch (behind its guard) as `name`, expiring after SNAPSHOT_DAYS, and
 * waits for Neon's operations to finish, polling every `pollMs` until `timeoutMs`. Answers the
 * snapshot's id. Neon's "Create snapshot" (POST /projects/{id}/branches/{branch}/snapshot) and
 * its operations are asked through Neon's official client, @neondatabase/api-client.
 */
export async function snapshotDefaultBranch(
  name: string,
  {
    guard,
    now = () => new Date(),
    wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    pollMs = 2_000,
    timeoutMs = 300_000,
    ...project
  }: NeonProject & {
    guard: string | undefined;
    now?: () => Date;
    wait?: (ms: number) => Promise<void>;
    pollMs?: number;
    timeoutMs?: number;
  },
): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error(`Not a snapshot name: "${name}".`);
  const get = neon(project);
  const branch = await findBranch(get, { default: true, guard });
  // Neon's official client; its fetch adapter takes the same fetch the tests inject.
  const client = createApiClient({
    apiKey: project.apiKey,
    adapter: "fetch",
    env: { fetch: project.fetch ?? fetch },
  });
  const started = now().getTime();
  const expires = new Date(started + SNAPSHOT_DAYS * 86_400_000).toISOString();
  const { data: created } = await client.createSnapshot({
    projectId: project.projectId,
    branchId: branch.id,
    name,
    expires_at: expires,
  });
  for (const operation of created.operations ?? []) {
    for (;;) {
      const {
        data: { operation: state },
      } = await client.getProjectOperation(project.projectId, operation.id);
      if (state.status === "finished" || state.status === "skipped") break;
      if (SETTLED.has(state.status))
        throw new Error(`Neon's snapshot ${name} ended ${state.status}.`);
      if (now().getTime() - started > timeoutMs)
        throw new Error(`Neon's snapshot ${name} was still ${state.status} after ${timeoutMs} ms.`);
      await wait(pollMs);
    }
  }
  return created.snapshot.id;
}

export interface Cli {
  branch: BranchChoice;
  direct: boolean;
  snapshot?: string;
}

/** Reads the arguments; null when they are not a use this script has. */
export function parseArgs(argv: string[], guard: string | undefined): Cli | null {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const snapshotAt = argv.indexOf("--snapshot");
  const snapshot = snapshotAt >= 0 ? argv[snapshotAt + 1] : undefined;
  const positional = argv.filter(
    (arg, i) => !arg.startsWith("--") && !(snapshotAt >= 0 && i === snapshotAt + 1),
  );
  for (const flag of flags)
    if (!["--default", "--direct", "--snapshot"].includes(flag)) return null;
  if (snapshotAt >= 0 && (!snapshot || snapshot.startsWith("--"))) return null;
  if (flags.has("--default")) {
    if (positional.length) return null;
    return { branch: { default: true, guard }, direct: flags.has("--direct"), snapshot };
  }
  if (snapshot !== undefined || positional.length !== 1) return null;
  return { branch: { name: positional[0] as string }, direct: flags.has("--direct") };
}

if (import.meta.main) {
  const {
    NEON_API_KEY: apiKey,
    NEON_PROJECT_ID: projectId,
    PONZU_ALLOW_DEFAULT_BRANCH: guard,
  } = process.env;
  const cli = parseArgs(process.argv.slice(2), guard);
  if (!cli || !apiKey || !projectId) {
    console.error(
      [
        "usage: NEON_API_KEY=… NEON_PROJECT_ID=… bun scripts/neon.ts <branch> [--direct]",
        "       PONZU_ALLOW_DEFAULT_BRANCH=production … bun scripts/neon.ts --default [--direct]",
        "       PONZU_ALLOW_DEFAULT_BRANCH=production … bun scripts/neon.ts --default --snapshot <name>",
      ].join("\n"),
    );
    process.exit(2);
  }
  try {
    if (cli.snapshot !== undefined) {
      console.log(await snapshotDefaultBranch(cli.snapshot, { apiKey, projectId, guard }));
    } else {
      console.log(await branchDatabaseUrl(cli.branch, { apiKey, projectId, direct: cli.direct }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
