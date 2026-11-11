import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import {
  type AgentState,
  designRunners,
  designs,
  repos,
  users,
  workspaces,
} from "../schema/index.ts";
import type { Design } from "./designs.ts";
import { timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * A design's runner (docs/cloud.md, "The runner protocol"): the lease that makes one process
 * the design's runner, when it was last heard from, and the state it reports.
 */

/** What a design's runner works with: the design, its repository, and the person behind it. */
export interface RunnerContext {
  design: Design;
  assetKey: string;
  /** Null for Scratch. */
  repo: { githubRepoId: number; fullName: string; defaultBranch: string } | null;
  /** The App's installation on the workspace; null while it is not installed. */
  installationId: number | null;
  /** Set while the App is suspended on the workspace. */
  suspendedAt: Date | null;
  /** The design's owner, whom commits are authored by. Null once they are deleted. */
  owner: { id: string; name: string | null; githubLogin: string; githubUserId: number } | null;
}

/** A design with what its runner works with, in one read. Null when there is no such design. */
export async function getRunnerContext(db: Db, designId: string): Promise<RunnerContext | null> {
  const { assetKey, ...design } = getTableColumns(designs);
  const [row] = await run(
    db
      .select({
        design,
        assetKey,
        repoGithubId: repos.githubRepoId,
        repoFullName: repos.fullName,
        repoDefaultBranch: repos.defaultBranch,
        installationId: workspaces.installationId,
        suspendedAt: workspaces.suspendedAt,
        ownerId: users.id,
        ownerName: users.name,
        ownerLogin: users.githubLogin,
        ownerGithubId: users.githubUserId,
      })
      .from(designs)
      .innerJoin(workspaces, eq(workspaces.id, designs.workspaceId))
      .leftJoin(repos, eq(repos.id, designs.repoId))
      .leftJoin(users, eq(users.id, designs.ownerId))
      .where(eq(designs.id, designId)),
  );
  if (!row) return null;
  return {
    design: row.design,
    assetKey: row.assetKey,
    repo:
      row.repoGithubId === null || row.repoFullName === null || row.repoDefaultBranch === null
        ? null
        : {
            githubRepoId: row.repoGithubId,
            fullName: row.repoFullName,
            defaultBranch: row.repoDefaultBranch,
          },
    installationId: row.installationId,
    suspendedAt: row.suspendedAt,
    owner:
      row.ownerId === null || row.ownerLogin === null || row.ownerGithubId === null
        ? null
        : {
            id: row.ownerId,
            name: row.ownerName,
            githubLogin: row.ownerLogin,
            githubUserId: row.ownerGithubId,
          },
  };
}

/**
 * Make a new runner id the design's lease, replacing whichever was there: the runner that
 * started last is the one the API takes calls from. Answers the new id and the Claude session
 * the design's events went into, for the runner to resume.
 */
export async function takeRunnerLease(
  db: Db,
  { designId, now }: { designId: string; now: Date },
): Promise<{ runnerId: string; claudeSessionId: string | null }> {
  const at = sql`${timeParam(now)}::timestamptz`;
  const [lease] = await run(
    db
      .insert(designRunners)
      .values({ designId, runnerId: newId("rnr"), startedAt: at, heardAt: at })
      .onConflictDoUpdate({
        target: designRunners.designId,
        set: {
          runnerId: sql`excluded.runner_id`,
          startedAt: sql`excluded.started_at`,
          heardAt: sql`excluded.heard_at`,
        },
      })
      .returning({
        runnerId: designRunners.runnerId,
        claudeSessionId: designRunners.claudeSessionId,
      }),
  );
  return lease!;
}

export interface RunnerState {
  state: Extract<AgentState, "working" | "needs_you" | "idle">;
  status: string | null;
  artboards: string[];
  /** Stored for the next resume when not null. */
  claudeSessionId: string | null;
}

/**
 * Record what the design's runner says it is doing, as of `now`, and answer the design's head
 * `seq`. The design's row, which clients watch, is written only when what it shows changed, so
 * a heartbeat that says the same again touches only `design_runners`. Null when there is no
 * such design or it has no runner.
 */
export async function reportRunnerState(
  db: Db,
  { designId, now, ...report }: RunnerState & { designId: string; now: Date },
): Promise<number | null> {
  const heard = db.$with("heard").as(
    db
      .update(designRunners)
      .set({
        heardAt: sql`${timeParam(now)}::timestamptz`,
        claudeSessionId: sql`coalesce(${report.claudeSessionId}::text, ${designRunners.claudeSessionId})`,
      })
      .where(eq(designRunners.designId, designId))
      .returning({ designId: designRunners.designId }),
  );
  const artboards = sql`${sql.param(report.artboards, designs.agentArtboards)}::text[]`;
  const shown = db.$with("shown").as(
    db
      .update(designs)
      .set({ agentState: report.state, agentStatus: report.status, agentArtboards: artboards })
      .where(
        and(
          eq(designs.id, designId),
          sql`exists (select 1 from ${heard})`,
          sql`(${designs.agentState}, ${designs.agentStatus}, ${designs.agentArtboards})
                is distinct from (${report.state}::text, ${report.status}::text, ${artboards})`,
        ),
      )
      .returning({ id: designs.id }),
  );
  const [row] = await run(
    db
      .with(heard, shown)
      .select({ seq: designs.seq })
      .from(designs)
      .where(and(eq(designs.id, designId), sql`exists (select 1 from ${heard})`)),
  );
  return row?.seq ?? null;
}
