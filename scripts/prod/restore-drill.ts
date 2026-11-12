#!/usr/bin/env bun
/**
 * The restore drill (docs/production.md, "Backups and restore"): proves the database can be had
 * back as it was an hour ago, without touching the live one.
 *
 *   bun scripts/prod/restore-drill.ts --env dev|production [--hours-ago <n>]
 *
 * 1. Lists the project's branches.
 * 2. Creates a branch `restore-drill-<env>-<time>` from the environment's branch as it was
 *    `--hours-ago` hours ago (1 by default), with Neon's point-in-time branching. It expires by
 *    itself after a day, in case this run is killed before step 5.
 * 3. Counts the rows of every table on the live branch and on the drill branch. Only counts are
 *    read: never a row.
 * 4. Judges each table: present on both, and the two counts within what an hour's writes explain
 *    (`allowedDrift`). A table only one side has is explained only by a migration in between,
 *    which the migrations table shows.
 * 5. Deletes the drill branch, which is the only branch it ever deletes (by the id Neon gave it
 *    when it was made), and lists the branches again: the list must equal the one from step 1.
 *
 * It exits 0 only when every table is judged right and the branch list is back as it was.
 * Needs NEON_API_KEY and NEON_PROJECT_ID. Connection strings are asked of Neon for the two
 * branches and used only to count; they and the key are never printed (every line goes through
 * the redactor with them as known secrets).
 *
 * It creates and deletes one branch, so it is not read-only. On production it is the founder's
 * to run, monthly; the orchestrator runs it on dev.
 */
import { createApiClient } from "@neondatabase/api-client";
import { redactText } from "../../packages/core/src/redact.ts";
import { pickBranch, plainError, statusOf } from "./checks/neon.ts";
import { EnvironmentName, loadEnvironments } from "./desired.ts";

export const DRILL_PREFIX = "restore-drill-";
/** How long the drill waits for Neon's operations before giving up. */
export const OPERATION_DEADLINE_MS = 5 * 60_000;
export const POLL_MS = 2_000;
/** Rows any table may differ by, however small, and the share of its live rows it may differ by. */
export const ABSOLUTE_SLACK = 100;
export const RELATIVE_SLACK = 0.25;
/** drizzle's record of applied migrations: a different count explains a table only one side has. */
export const MIGRATIONS_TABLE = "drizzle.__drizzle_migrations";

// --- the parts that talk to Neon and Postgres, as tests fake them -------------------------------

export interface DrillBranch {
  id: string;
  name: string;
  default: boolean;
}

/** The Neon calls the drill makes; `neonDrillApi` is the real one, tests pass a fake. */
export interface DrillNeon {
  listBranches(): Promise<DrillBranch[]>;
  createBranch(input: {
    parentId: string;
    name: string;
    parentTimestamp: string;
    expiresAt: string;
  }): Promise<{ branch: DrillBranch; operationIds: string[] }>;
  operationStatus(id: string): Promise<string>;
  deleteBranch(id: string): Promise<{ operationIds: string[] }>;
  /** The branch's first database and its owner, which is what the API connects as. */
  database(branchId: string): Promise<{ name: string; owner: string }>;
  connectionUri(branchId: string, database: { name: string; owner: string }): Promise<string>;
}

/** Every table's row count, by `schema.table`. */
export type CountRows = (uri: string) => Promise<Record<string, number>>;

export function neonDrillApi(apiKey: string, projectId: string): DrillNeon {
  const api = createApiClient({ apiKey });
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw statusOf(error) !== null || (error as { isAxiosError?: boolean })?.isAxiosError
        ? plainError(error)
        : error;
    }
  };
  return {
    listBranches: () =>
      call(async () => {
        const out: DrillBranch[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
          const { data } = await api.listProjectBranches({ projectId, limit: 100, cursor });
          out.push(...data.branches.map((b) => ({ id: b.id, name: b.name, default: b.default })));
          cursor = data.pagination?.next;
          if (!cursor || !data.branches.length) return out;
        }
        throw new Error("Neon kept answering more pages of branches");
      }),
    createBranch: ({ parentId, name, parentTimestamp, expiresAt }) =>
      call(async () => {
        const { data } = await api.createProjectBranch(projectId, {
          branch: {
            parent_id: parentId,
            name,
            parent_timestamp: parentTimestamp,
            expires_at: expiresAt,
          },
          endpoints: [{ type: "read_write" as never }],
        });
        return {
          branch: { id: data.branch.id, name: data.branch.name, default: data.branch.default },
          operationIds: data.operations.map((o) => o.id),
        };
      }),
    operationStatus: (id) =>
      call(async () => (await api.getProjectOperation(projectId, id)).data.operation.status),
    deleteBranch: (branchId) =>
      call(async () => {
        const { data } = await api.deleteProjectBranch({ projectId, branchId });
        return { operationIds: data.operations.map((o) => o.id) };
      }),
    database: (branchId) =>
      call(async () => {
        const { data } = await api.listProjectBranchDatabases(projectId, branchId);
        const database = data.databases[0];
        if (!database) throw new Error("the branch has no database");
        return { name: database.name, owner: database.owner_name };
      }),
    connectionUri: (branchId, database) =>
      call(
        async () =>
          (
            await api.getConnectionUri({
              projectId,
              branch_id: branchId,
              database_name: database.name,
              role_name: database.owner,
              pooled: false,
            })
          ).data.uri,
      ),
  };
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Counts with Bun's own Postgres client: one `count(*)` a table, nothing else read. */
export const countRows: CountRows = async (uri) => {
  const { SQL } = await import("bun");
  const db = new SQL(uri);
  try {
    const tables: { table_schema: string; table_name: string }[] = await db`
      select table_schema, table_name from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema not in ('pg_catalog', 'information_schema')
        and table_schema not like 'pg\\_%'
      order by 1, 2`;
    const counts: Record<string, number> = {};
    for (const { table_schema, table_name } of tables) {
      const [row] = await db.unsafe(
        `select count(*)::bigint as n from ${quote(table_schema)}.${quote(table_name)}`,
      );
      counts[`${table_schema}.${table_name}`] = Number((row as { n: string | number }).n);
    }
    return counts;
  } finally {
    await db.close();
  }
};

// --- judging -------------------------------------------------------------------------------------

export interface TableLine {
  table: string;
  live: number | null;
  restored: number | null;
  ok: boolean;
  says: string;
}

/** How far a table's restored count may be from its live one and still be an hour's writes. */
export function allowedDrift(live: number): number {
  return Math.max(ABSOLUTE_SLACK, Math.ceil(live * RELATIVE_SLACK));
}

/** Pure: each table's line, live against restored. */
export function compareCounts(
  live: Record<string, number>,
  restored: Record<string, number>,
): TableLine[] {
  const migrated = (live[MIGRATIONS_TABLE] ?? 0) !== (restored[MIGRATIONS_TABLE] ?? 0);
  const tables = [...new Set([...Object.keys(live), ...Object.keys(restored)])].sort();
  return tables.map((table) => {
    const a = live[table] ?? null;
    const b = restored[table] ?? null;
    if (a === null || b === null) {
      const side = a === null ? "only the restore" : "only the live branch";
      return {
        table,
        live: a,
        restored: b,
        ok: migrated,
        says: migrated
          ? `${side} has it, which a migration in between explains`
          : `${side} has it, and no migration in between explains that`,
      };
    }
    const drift = Math.abs(a - b);
    const allowed = allowedDrift(a);
    return {
      table,
      live: a,
      restored: b,
      ok: drift <= allowed,
      says:
        drift <= allowed
          ? `${b} restored, ${a} live`
          : `${b} restored, ${a} live: ${drift} apart, more than the ${allowed} an hour's writes explain`,
    };
  });
}

// --- the run -------------------------------------------------------------------------------------

export interface DrillIo {
  print: (line: string) => void;
  env: Record<string, string | undefined>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  neon?: DrillNeon;
  count?: CountRows;
  environmentsPath?: string;
}

/** `restore-drill-dev-20261112t1504`: lowercase, as Neon shows branch names. */
export function drillName(env: EnvironmentName, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").toLowerCase();
  return `${DRILL_PREFIX}${env}-${stamp}`;
}

async function waitFor(neon: DrillNeon, ids: readonly string[], io: DrillIo, what: string) {
  const deadline = io.now().getTime() + OPERATION_DEADLINE_MS;
  for (const id of ids) {
    for (;;) {
      const status = await neon.operationStatus(id);
      if (status === "finished" || status === "skipped") break;
      if (["failed", "error", "cancelled", "cancelling"].includes(status)) {
        throw new Error(`Neon's operation to ${what} ended ${status}`);
      }
      if (io.now().getTime() >= deadline) {
        throw new Error(
          `Neon's operation to ${what} did not finish in ${OPERATION_DEADLINE_MS / 60_000} minutes`,
        );
      }
      await io.sleep(POLL_MS);
    }
  }
}

const USAGE = "usage: bun scripts/prod/restore-drill.ts --env <dev|production> [--hours-ago <n>]";

export async function main(argv: readonly string[], io: DrillIo): Promise<number> {
  const args = [...argv];
  const flag = (name: string) => {
    const at = args.indexOf(name);
    if (at === -1) return undefined;
    const value = args[at + 1];
    args.splice(at, 2);
    return value ?? "";
  };
  const env = EnvironmentName.safeParse(flag("--env"));
  const hoursArg = flag("--hours-ago");
  const hours = hoursArg === undefined ? 1 : Number(hoursArg);
  if (!env.success || args.length || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 6) {
    io.print(USAGE);
    return 2;
  }
  const apiKey = io.env.NEON_API_KEY?.trim();
  const projectId = io.env.NEON_PROJECT_ID?.trim();
  const secrets: string[] = [apiKey, projectId].filter((s): s is string => !!s);
  const print = (line: string) => io.print(redactText(line, secrets));
  if (!apiKey || !projectId) {
    print("skipped: the drill needs NEON_API_KEY and NEON_PROJECT_ID");
    return 1;
  }
  const wanted = loadEnvironments(io.environmentsPath).environments[env.data].neonBranch;
  if (!wanted) {
    print(`pending: infra/environments.json names no Neon branch for ${env.data} yet`);
    return 1;
  }
  const neon = io.neon ?? neonDrillApi(apiKey, projectId);
  const count = io.count ?? countRows;

  const before = await neon.listBranches();
  const source = pickBranch(before, wanted);
  if (!source) {
    print(`fail: the Neon branch ${wanted} does not exist`);
    return 1;
  }
  const start = io.now();
  const at = new Date(start.getTime() - hours * 3_600_000);
  const name = drillName(env.data, start);
  print(`Ponzu ${env.data}: restore drill of ${source.name} as it was at ${at.toISOString()}`);

  let created: DrillBranch | null = null;
  let lines: TableLine[] = [];
  let failure: string | null = null;
  try {
    const made = await neon.createBranch({
      parentId: source.id,
      name,
      parentTimestamp: at.toISOString(),
      expiresAt: new Date(start.getTime() + 24 * 3_600_000).toISOString(),
    });
    // Only a branch that is plainly the drill's is ever deleted: never the default, never a name
    // this run did not ask for.
    if (made.branch.default || made.branch.name !== name) {
      throw new Error(`Neon answered a branch that is not the drill's (${made.branch.name})`);
    }
    created = made.branch;
    await waitFor(neon, made.operationIds, io, "create the drill branch");
    const database = await neon.database(source.id);
    const liveUri = await neon.connectionUri(source.id, database);
    const drillUri = await neon.connectionUri(created.id, database);
    secrets.push(liveUri, drillUri);
    const [live, restored] = await Promise.all([count(liveUri), count(drillUri)]);
    lines = compareCounts(live, restored);
    if (!Object.keys(live).length) failure = "the live branch has no tables to compare";
  } catch (error) {
    failure = error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);
  }

  let cleaned = true;
  if (created) {
    try {
      const removed = await neon.deleteBranch(created.id);
      await waitFor(neon, removed.operationIds, io, "delete the drill branch");
    } catch (error) {
      cleaned = false;
      print(
        `fail: the drill branch ${created.name} could not be deleted (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); it expires by itself within a day`,
      );
    }
  }
  const after = await neon.listBranches();
  const names = (list: DrillBranch[]) => list.map((b) => b.name).sort();
  const same = JSON.stringify(names(before)) === JSON.stringify(names(after));

  for (const line of lines) print(`${line.ok ? "ok  " : "fail"}    ${line.table}: ${line.says}`);
  if (failure) print(`fail    the drill could not finish: ${failure}`);
  print(
    same
      ? `ok      the branch list is as it was (${before.length} branches)`
      : `fail    the branch list differs from before: ${JSON.stringify(names(before))} then ${JSON.stringify(names(after))}`,
  );
  const good = lines.length > 0 && lines.every((l) => l.ok) && !failure && cleaned && same;
  print(
    good
      ? `restored ${lines.length} tables from ${hours} hour${hours === 1 ? "" : "s"} ago, each within an hour's writes`
      : "the drill failed",
  );
  return good ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2), {
    print: (line) => console.log(line),
    env: process.env,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).then(
    (code) => process.exit(code),
    (error) => {
      const known = [process.env.NEON_API_KEY, process.env.NEON_PROJECT_ID].filter(
        (s): s is string => !!s,
      );
      console.error(
        redactText(
          error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
          known,
        ),
      );
      process.exit(1);
    },
  );
}
