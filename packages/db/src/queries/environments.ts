import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type BaseStatus, repoSecrets, repos, type StackItem } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * A repo's environment (docs/cloud.md, "Environments"): the base its canvases start from and
 * the secrets its sandboxes receive as environment variables. A secret's value is sealed by the
 * API, bound to its row, and only ever leaves this package sealed: the lists here name secrets
 * and never carry a value, but for `listCanvasSecrets`, which the sandbox lifecycle opens.
 */

/** A repo's environment as Settings shows it. Never a secret's value. */
export interface RepoEnvironmentRow {
  repoId: string;
  fullName: string;
  base: {
    status: BaseStatus;
    builtAt: Date | null;
    stack: StackItem[];
    error: string | null;
    /**
     * When a rebuild was last asked for, if one is still to happen: asked for and not yet
     * recorded (its job is waiting), or recorded for the repo's next start.
     */
    rebuildRequestedAt: Date | null;
    rebuildWaiting: boolean;
  };
  secrets: { name: string; updatedAt: Date }[];
}

type EnvironmentJson = {
  repoId: string;
  fullName: string;
  baseStatus: BaseStatus;
  baseBuiltAt: string | null;
  stack: StackItem[];
  baseError: string | null;
  rebuildRequestedAt: string | null;
  rebuildWaiting: boolean;
  secrets: { name: string; updatedAt: string }[];
};

/** The json of one repo `r`'s environment, as `toEnvironment` reads it. */
function environmentJson(rebuildJob: string) {
  return sql`json_build_object(
    'repoId', r.id,
    'fullName', r.full_name,
    'baseStatus', r.base_status,
    'baseBuiltAt', r.base_built_at,
    'stack', r.stack,
    'baseError', r.base_error,
    'rebuildRequestedAt', r.base_rebuild_requested_at,
    'rebuildWaiting', exists (
      select 1 from jobs j
       where j.kind = ${rebuildJob} and j.key = r.id
         and j.completed_at is null and j.failed_at is null
    ),
    'secrets', coalesce((
      select json_agg(json_build_object('name', s.name, 'updatedAt', s.updated_at)
                      order by s.name)
        from repo_secrets s where s.repo_id = r.id
    ), '[]'::json)
  )`;
}

function toEnvironment(json: EnvironmentJson): RepoEnvironmentRow {
  return {
    repoId: json.repoId,
    fullName: json.fullName,
    base: {
      status: json.baseStatus,
      builtAt: json.baseBuiltAt ? new Date(json.baseBuiltAt) : null,
      stack: json.stack,
      error: json.baseError,
      rebuildRequestedAt: json.rebuildRequestedAt ? new Date(json.rebuildRequestedAt) : null,
      rebuildWaiting: json.rebuildWaiting,
    },
    secrets: json.secrets.map((secret) => ({
      name: secret.name,
      updatedAt: new Date(secret.updatedAt),
    })),
  };
}

/**
 * One repo's environment, or null when there is no such repo or the App has lost it. Who may
 * see it is the caller's to decide. `rebuildJob` is the kind of job a rebuild is recorded as.
 */
export async function getRepoEnvironment(
  db: Db,
  { repoId, rebuildJob }: { repoId: string; rebuildJob: string },
): Promise<RepoEnvironmentRow | null> {
  const result = await queryJson<EnvironmentJson>(
    db,
    sql`select ${environmentJson(rebuildJob)} as result
          from repos r where r.id = ${repoId} and r.removed_at is null`,
  );
  return result ? toEnvironment(result) : null;
}

/**
 * The environments of a workspace's repos that `userId` can read, as `repo_access` last said
 * (whether that is recent enough, and that they are a member, is the caller's to make sure
 * of), most recently pushed first. A repo is listed once it has an environment to show: a
 * canvas (whose start builds its base), a base, a rebuild asked for, or a secret.
 */
export async function listWorkspaceEnvironments(
  db: Db,
  { workspaceId, userId, rebuildJob }: { workspaceId: string; userId: string; rebuildJob: string },
): Promise<RepoEnvironmentRow[]> {
  const result = await queryJson<{ repos: EnvironmentJson[] }>(
    db,
    sql`
      select json_build_object('repos', coalesce(json_agg(
        ${environmentJson(rebuildJob)} order by r.pushed_at desc nulls last, r.full_name
      ), '[]'::json)) as result
        from repos r
        join repo_access a on a.repo_id = r.id and a.user_id = ${userId}
                          and a.permission in ('admin', 'write', 'read')
       where r.workspace_id = ${workspaceId} and r.removed_at is null
         and (r.base_status <> 'none' or r.base_rebuild_requested_at is not null
              or exists (select 1 from repo_secrets s where s.repo_id = r.id)
              or exists (select 1 from canvases d where d.repo_id = r.id))
    `,
  );
  return (result?.repos ?? []).map(toEnvironment);
}

/** How much one repo's secrets may hold: they all go into one sandbox's environment. */
export interface SecretLimits {
  count: number;
  /** Every name and value, in UTF-8 bytes. */
  totalBytes: number;
}

export interface SecretWrite {
  repoId: string;
  name: string;
  /** Sealed by the caller, bound to `<repo id>/<name>`. */
  encryptedValue: string;
  /** The plain value's length in UTF-8 bytes. */
  valueBytes: number;
  userId: string;
  now: Date;
  limits: SecretLimits;
}

/**
 * The repo's secrets other than `name` leave room for this one: fewer than the limit's count,
 * and their names and values with this one's within its bytes.
 */
function roomFor({ repoId, name, valueBytes, limits }: SecretWrite) {
  return sql`(
    select count(*) < ${limits.count}
           and coalesce(sum(octet_length(o.name) + o.value_bytes), 0)
               + ${new TextEncoder().encode(name).length + valueBytes} <= ${limits.totalBytes}
      from repo_secrets o where o.repo_id = ${repoId} and o.name <> ${name})`;
}

/**
 * Add a secret the repo does not have. `exists` when it has one of that name (replace it
 * instead), `full` when the repo's secrets have no room for it.
 */
export async function addRepoSecret(
  db: Db,
  write: SecretWrite,
): Promise<"added" | "exists" | "full"> {
  const { repoId, name, encryptedValue, valueBytes, userId, now } = write;
  const at = timeParam(now);
  const result = await queryJson<{ added: boolean; exists: boolean }>(
    db,
    sql`
      with added as (
        insert into repo_secrets (repo_id, name, encrypted_value, value_bytes,
                                  updated_by_user_id, created_at, updated_at)
        select ${repoId}, ${name}, ${encryptedValue}, ${valueBytes}, ${userId},
               ${at}::timestamptz, ${at}::timestamptz
         where ${roomFor(write)}
        on conflict (repo_id, name) do nothing
        returning 1
      )
      select json_build_object(
        'added', exists (select 1 from added),
        'exists', exists (select 1 from repo_secrets where repo_id = ${repoId} and name = ${name})
      ) as result
    `,
  );
  if (result?.added) return "added";
  return result?.exists ? "exists" : "full";
}

/**
 * Put a new value in a secret the repo has. `missing` when it has none of that name, `full`
 * when the new value leaves its secrets no room.
 */
export async function replaceRepoSecret(
  db: Db,
  write: SecretWrite,
): Promise<"replaced" | "missing" | "full"> {
  const { repoId, name, encryptedValue, valueBytes, userId, now } = write;
  const result = await queryJson<{ replaced: boolean; exists: boolean }>(
    db,
    sql`
      with replaced as (
        update repo_secrets set
          encrypted_value = ${encryptedValue},
          value_bytes = ${valueBytes},
          updated_by_user_id = ${userId},
          updated_at = ${timeParam(now)}::timestamptz
         where repo_id = ${repoId} and name = ${name} and ${roomFor(write)}
        returning 1
      )
      select json_build_object(
        'replaced', exists (select 1 from replaced),
        'exists', exists (select 1 from repo_secrets where repo_id = ${repoId} and name = ${name})
      ) as result
    `,
  );
  if (result?.replaced) return "replaced";
  return result?.exists ? "full" : "missing";
}

/** Remove a secret, value and all. False when the repo has none of that name. */
export async function deleteRepoSecret(
  db: Db,
  { repoId, name }: { repoId: string; name: string },
): Promise<boolean> {
  const deleted = await run(
    db
      .delete(repoSecrets)
      .where(and(eq(repoSecrets.repoId, repoId), eq(repoSecrets.name, name)))
      .returning({ name: repoSecrets.name }),
  );
  return deleted.length > 0;
}

/** A secret as a sandbox's environment takes it: still sealed. */
export interface SealedSecret {
  repoId: string;
  name: string;
  encryptedValue: string;
}

/**
 * The secrets of a canvas's repo, sealed, by name: what its sandbox's environment carries.
 * None for Scratch, and none once the App has lost the repo.
 */
export function listCanvasSecrets(db: Db, canvasId: string): Promise<SealedSecret[]> {
  return run(
    db
      .select({
        repoId: repoSecrets.repoId,
        name: repoSecrets.name,
        encryptedValue: repoSecrets.encryptedValue,
      })
      .from(repoSecrets)
      .innerJoin(repos, eq(repos.id, repoSecrets.repoId))
      .where(
        and(
          sql`${repos.id} = (select repo_id from canvases where id = ${canvasId})`,
          sql`${repos.removedAt} is null`,
        ),
      )
      .orderBy(repoSecrets.name),
  );
}

/**
 * Record that the repo's base should be made again at its next start. The sandbox side of
 * building a base is not built yet, so nothing acts on it yet. False when there is no repo.
 */
export async function markBaseForRebuild(
  db: Db,
  { repoId, now }: { repoId: string; now: Date },
): Promise<boolean> {
  const marked = await run(
    db
      .update(repos)
      .set({ baseRebuildRequestedAt: sql`${timeParam(now)}::timestamptz` })
      .where(eq(repos.id, repoId))
      .returning({ id: repos.id }),
  );
  return marked.length > 0;
}
