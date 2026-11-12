import {
  addRepoSecret,
  BASE_STATUSES,
  deleteRepoSecret,
  getRepoEnvironment,
  listWorkspaceEnvironments,
  type RepoEnvironmentRow,
  replaceRepoSecret,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { UserActor } from "../auth/actor.ts";
import { requireRepo, requireWorkspace } from "../auth/authorize.ts";
import { canWrite, refreshWorkspaceRepoAccess, repoPermission } from "../auth/repo-access.ts";
import type { Deps } from "../deps/index.ts";
import { BASE_REBUILD_JOB, requestBaseRebuild } from "../environments/rebuild.ts";
import {
  MAX_SECRET_NAME,
  reservedReason,
  SECRET_LIMITS,
  SecretValue,
  secretBinding,
  secretNameProblem,
  valueBytes,
} from "../environments/secrets.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import type { Logger } from "../http/log.ts";
import { validate } from "../http/validate.ts";

/*
 * Settings › Environments (docs/cloud.md, "Environments"): per repo, the base its canvases
 * start from and the secrets its sandboxes receive. Anyone who can read the repo sees them, by
 * name; a workspace admin adds, replaces and removes secrets; anyone who can push to the repo
 * may ask for a rebuild. A secret's value goes into the vault and comes out only into a
 * sandbox's environment: no answer, log line or event carries it.
 */

const Environment = z.object({
  repo: z.object({ id: z.string(), owner: z.string(), name: z.string(), fullName: z.string() }),
  base: z.object({
    /** `none` until Claude has set the repo up on a first run and its base is saved. */
    status: z.enum(BASE_STATUSES),
    /** When the base in use was built: kept through a rebuild, and one that failed. */
    builtAt: z.date().nullable(),
    stack: z.array(z.object({ slug: z.string(), label: z.string() })),
    /**
     * A rebuild asked for and still to happen: its job waits, or it is marked for the repo's
     * next start. Building a base is not built yet, so it stays asked for until then.
     */
    rebuild: z.object({ requestedAt: z.date().nullable(), waiting: z.boolean() }),
  }),
  /** By name. Never a value: a value is written, replaced or removed, never read back. */
  secrets: z.array(z.object({ name: z.string(), updatedAt: z.date() })),
});

const toEnvironment = (row: RepoEnvironmentRow): z.input<typeof Environment> => {
  const slash = row.fullName.indexOf("/");
  return {
    repo: {
      id: row.repoId,
      owner: row.fullName.slice(0, slash),
      name: row.fullName.slice(slash + 1),
      fullName: row.fullName,
    },
    base: {
      status: row.base.status,
      builtAt: row.base.builtAt,
      stack: row.base.stack,
      rebuild: { requestedAt: row.base.rebuildRequestedAt, waiting: row.base.rebuildWaiting },
    },
    secrets: row.secrets,
  };
};

/** What the viewer may do: change secrets (an admin), and ask for a rebuild (who can push). */
const Abilities = z.object({ canManageSecrets: z.boolean(), canRebuild: z.boolean() });
const EnvironmentAnswer = z.object({ environment: Environment }).merge(Abilities);
const WorkspaceEnvironments = z.object({
  /** Repos the viewer can read that have an environment: a base, a rebuild, or a secret. */
  repos: z.array(Environment),
  /** May change secrets: an admin of the workspace. */
  canManageSecrets: z.boolean(),
});

const SecretName = z.string().min(1).max(MAX_SECRET_NAME);
const RepoParam = z.object({ id: z.string().min(1).max(64) });
const SecretParam = RepoParam.extend({ name: SecretName });

/** A handler's context, as far as these need it. */
type UserContext = { var: { deps: Deps; log: Logger; actor: UserActor } };

/** The repo's environment as the viewer may have it, with what they may do to it. */
async function answer(c: UserContext, repoId: string) {
  const { deps, actor } = c.var;
  const found = await requireRepo(c, repoId);
  const [environment, workspace, permission] = await Promise.all([
    getRepoEnvironment(deps.db, { repoId: found.repo.id, rebuildJob: BASE_REBUILD_JOB }),
    requireWorkspace(c, found.repo.workspaceId),
    // Fresh now: `requireRepo` has just made sure of it.
    repoPermission(deps, {
      user: actor.user,
      repo: found.repo,
      installation: { installationId: found.installationId, suspendedAt: found.suspendedAt },
    }),
  ]);
  if (!environment) throw new ApiError(404, "not_found", "There is no such repo.");
  return EnvironmentAnswer.parse({
    environment: toEnvironment(environment),
    canManageSecrets: workspace.role === "admin",
    canRebuild: canWrite(permission),
  });
}

/** The repo, for an admin of its workspace about to change its secrets; 403 for anyone else. */
async function requireSecretsAdmin(c: UserContext, repoId: string) {
  const repo = await requireRepo(c, repoId);
  await requireWorkspace(c, repo.repo.workspaceId, "admin");
  return repo.repo;
}

/** A name a secret may have, or the refusal that says why not. */
function checkedName(name: string): string {
  const problem = secretNameProblem(name);
  if (problem === "reserved") {
    throw new ApiError(400, "secret_name_reserved", reservedReason(name));
  }
  if (problem === "invalid") {
    throw new ApiError(
      400,
      "invalid_request",
      "A secret's name is capitals, digits and underscores, starting with a letter.",
    );
  }
  return name;
}

const FULL = () =>
  new ApiError(
    409,
    "secrets_full",
    `A repo holds at most ${SECRET_LIMITS.count} secrets, ${SECRET_LIMITS.totalBytes / 1024} KB in all.`,
  );

/** Seal a value to the row it is going into, with what writing it takes. */
async function sealed(c: UserContext, repoId: string, name: string, value: string) {
  const { deps, actor } = c.var;
  return {
    repoId,
    name,
    encryptedValue: await deps.vault.seal(value, secretBinding(repoId, name)),
    valueBytes: valueBytes(value),
    userId: actor.user.id,
    now: new Date(deps.clock.now()),
    limits: SECRET_LIMITS,
  };
}

export const environments = new Hono<AppEnv>()
  /** The workspace's environments the viewer can read, most recently pushed first. */
  .get("/workspaces/:id/environments", access.user, validate("param", RepoParam), async (c) => {
    const { deps, actor } = c.var;
    const workspace = await requireWorkspace(c, c.req.valid("param").id);
    // Listed from `repo_access`, so brought up to the minute first, as the repo list is.
    await refreshWorkspaceRepoAccess({ ...deps, log: c.var.log }, { user: actor.user, workspace });
    const rows = await listWorkspaceEnvironments(deps.db, {
      workspaceId: workspace.id,
      userId: actor.user.id,
      rebuildJob: BASE_REBUILD_JOB,
    });
    return c.json(
      WorkspaceEnvironments.parse({
        repos: rows.map(toEnvironment),
        canManageSecrets: workspace.role === "admin",
      }),
    );
  })

  /** One repo's environment. */
  .get("/repos/:id/environment", access.user, validate("param", RepoParam), async (c) =>
    c.json(await answer(c, c.req.valid("param").id)),
  )

  /**
   * Ask for the repo's base to be made again from its default branch. Answers at once (202);
   * until building a base is built, the request is kept for the repo's next start.
   */
  .post("/repos/:id/environment/rebuild", access.user, validate("param", RepoParam), async (c) => {
    const { deps } = c.var;
    const repo = await requireRepo(c, c.req.valid("param").id, "write");
    await requestBaseRebuild(deps, repo.repo.id);
    c.var.log.info("base_rebuild_requested", { repoId: repo.repo.id });
    return c.json(await answer(c, repo.repo.id), 202);
  })

  /** Add a secret the repo does not have yet. 409 `secret_exists` when it has. */
  .post(
    "/repos/:id/environment/secrets",
    access.user,
    validate("param", RepoParam),
    validate("json", z.object({ name: SecretName, value: SecretValue })),
    async (c) => {
      const { name, value } = c.req.valid("json");
      const repo = await requireSecretsAdmin(c, c.req.valid("param").id);
      const added = await addRepoSecret(
        c.var.deps.db,
        await sealed(c, repo.id, checkedName(name), value),
      );
      if (added === "exists") {
        throw new ApiError(409, "secret_exists", `${name} is already here. Replace its value.`);
      }
      if (added === "full") throw FULL();
      c.var.log.info("repo_secret_added", { repoId: repo.id });
      c.var.deps.analytics.capture("repo secret changed", { repo_id: repo.id, action: "added" });
      return c.json(await answer(c, repo.id), 201);
    },
  )

  /** Put a new value in one of the repo's secrets. The old one is gone for good. */
  .put(
    "/repos/:id/environment/secrets/:name",
    access.user,
    validate("param", SecretParam),
    validate("json", z.object({ value: SecretValue })),
    async (c) => {
      const { id, name } = c.req.valid("param");
      const repo = await requireSecretsAdmin(c, id);
      const replaced = await replaceRepoSecret(
        c.var.deps.db,
        await sealed(c, repo.id, checkedName(name), c.req.valid("json").value),
      );
      if (replaced === "missing") throw new ApiError(404, "not_found", "There is no such secret.");
      if (replaced === "full") throw FULL();
      c.var.log.info("repo_secret_replaced", { repoId: repo.id });
      c.var.deps.analytics.capture("repo secret changed", { repo_id: repo.id, action: "replaced" });
      return c.json(await answer(c, repo.id));
    },
  )

  /** Remove one of the repo's secrets, value and all. */
  .delete(
    "/repos/:id/environment/secrets/:name",
    access.user,
    validate("param", SecretParam),
    async (c) => {
      const { id, name } = c.req.valid("param");
      const repo = await requireSecretsAdmin(c, id);
      if (!(await deleteRepoSecret(c.var.deps.db, { repoId: repo.id, name }))) {
        throw new ApiError(404, "not_found", "There is no such secret.");
      }
      c.var.log.info("repo_secret_removed", { repoId: repo.id });
      c.var.deps.analytics.capture("repo secret changed", { repo_id: repo.id, action: "removed" });
      return c.json(await answer(c, repo.id));
    },
  );
