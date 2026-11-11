import {
  completeUpload,
  getSandbox,
  getSavedPoint,
  getUploads,
  listUploadKeys,
  recordCheckpoint,
  type SavedPoint as SavedRow,
  type Upload,
} from "@ponzu/db";
import type {
  CheckpointRequest,
  RestoredReport,
  RestoreResponse,
  SavedArchive,
  SavedPoint,
} from "@ponzu/runner/protocol";
import type { LeasedRunner } from "../auth/actor.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";

/*
 * A runner's checkpoints (docs/cloud.md, "Saving the sandbox"): the session's transcript and a
 * Scratch design's files, uploaded as archives where no client reads them, and a turn marker that
 * only goes up. A runner whose disk is behind the marker reads them back; one that finds its disk
 * went back says so, and the API logs it with the sandbox and counts it.
 */

type CheckpointDeps = Pick<Deps, "db" | "archives" | "clock" | "background" | "log">;

/** How long an address that reads an archive back lasts. */
export const RESTORE_SECONDS = 600;

/** The checkpoint as the runner protocol carries it. */
export function savedView(point: SavedRow): SavedPoint {
  return {
    turn: point.turn,
    at: point.at.toISOString(),
    claudeSessionId: point.claudeSessionId,
    wipCommit: point.wipCommit,
    session: point.sessionUploadId !== null,
    workspace: point.workspaceUploadId !== null,
  };
}

/**
 * Record the runner's checkpoint: its archives must be this runner's uploads of the right
 * purpose and in storage as declared. Recorded only over an older turn; the archives of the one
 * it replaces, or of one that was not recorded, are deleted. Answers the checkpoint the design has
 * now. Safe to repeat.
 */
export async function recordRunnerCheckpoint(
  deps: CheckpointDeps,
  actor: LeasedRunner,
  body: CheckpointRequest,
): Promise<SavedPoint> {
  const { designId, runnerId } = actor;
  const wanted = { session: body.session, workspace: body.workspace } as const;
  const ids = [wanted.session, wanted.workspace].filter((id): id is string => id !== null);
  const rows = await getUploads(deps.db, { designId, ids });
  const notArrived = new ApiError(404, "not_found", "Those bytes never arrived.");
  for (const [purpose, id] of Object.entries(wanted)) {
    if (id === null) continue;
    const row = rows.find((r) => r.id === id);
    if (!row || row.userId !== null || row.purpose !== purpose) throw notArrived;
  }
  const arrived = await Promise.all(
    rows.map(async (row) => {
      if (row.completedAt) return true;
      const head = await deps.archives.head(row.objectKey);
      return head !== null && head.size === row.size && head.sha256 === row.sha256;
    }),
  );
  if (arrived.includes(false)) throw notArrived;
  // Recorded where they are; nothing serves them.
  await Promise.all(
    rows.map((row) => completeUpload(deps.db, { designId, id: row.id, servedKey: row.objectKey })),
  );

  const recorded = await recordCheckpoint(deps.db, {
    designId,
    runnerId,
    now: new Date(deps.clock.now()),
    turn: body.turn,
    claudeSessionId: body.claudeSessionId,
    wipCommit: body.wipCommit,
    sessionUploadId: wanted.session,
    workspaceUploadId: wanted.workspace,
    // Only in place of an archive this checkpoint does not carry.
    keepSession: wanted.session === null && body.keep?.session === true,
    keepWorkspace: wanted.workspace === null && body.keep?.workspace === true,
  });
  if (!recorded?.saved)
    throw new ApiError(409, "superseded", "A newer runner has started for this design.");
  const kept = new Set(
    [recorded.saved.sessionUploadId, recorded.saved.workspaceUploadId].filter(Boolean),
  );
  const stale = [
    ...ids,
    recorded.replaced?.sessionUploadId,
    recorded.replaced?.workspaceUploadId,
  ].filter((id): id is string => !!id && !kept.has(id));
  if (stale.length) deps.background("checkpoint_cleared", clear(deps, designId, stale));
  return savedView(recorded.saved);
}

async function clear(deps: CheckpointDeps, designId: string, ids: string[]): Promise<void> {
  const rows = await getUploads(deps.db, { designId, ids: [...new Set(ids)] });
  await Promise.all(rows.map((row: Upload) => deps.archives.delete(row.objectKey)));
}

/**
 * Before a design is deleted: where its checkpoints' archives are, every one (recorded or not),
 * and a promise that deletes them, to hand to `background` once the design's row is gone. The
 * rows go with the design; the bytes would otherwise stay in the bucket for good.
 */
export async function forgetCheckpoints(
  deps: Pick<Deps, "db" | "archives" | "log">,
  designId: string,
): Promise<() => Promise<void>> {
  const keys = await listUploadKeys(deps.db, {
    designId,
    purposes: ["session", "workspace"],
  });
  return async () => {
    const failed = (await Promise.allSettled(keys.map((key) => deps.archives.delete(key)))).filter(
      (result) => result.status === "rejected",
    ).length;
    if (failed) deps.log.warn("checkpoint_delete_failed", { designId, failed });
  };
}

/** The design's last checkpoint, with addresses that read its archives for ten minutes. */
export async function restoreFor(deps: CheckpointDeps, designId: string): Promise<RestoreResponse> {
  const saved = await getSavedPoint(deps.db, designId);
  if (!saved) return { saved: null, session: null, workspace: null };
  const ids = [saved.sessionUploadId, saved.workspaceUploadId].filter(
    (id): id is string => id !== null,
  );
  const rows = await getUploads(deps.db, { designId, ids });
  const offer = async (id: string | null): Promise<SavedArchive | null> => {
    const row = id ? rows.find((r) => r.id === id) : undefined;
    if (!row) return null;
    return {
      url: await deps.archives.presignGet(row.objectKey, RESTORE_SECONDS),
      size: row.size,
      sha256: row.sha256,
    };
  };
  const [session, workspace] = await Promise.all([
    offer(saved.sessionUploadId),
    offer(saved.workspaceUploadId),
  ]);
  return { saved: savedView(saved), session, workspace };
}

/**
 * The runner found its disk behind the design's last checkpoint and restored from it. Logged
 * with the session it happened in and the image: an empty disk (`rebuilt`) is what a new
 * sandbox, a new image or an expired snapshot gives; a disk that came back old (`rollback`)
 * should not happen with one snapshot kept, and is what to show Vercel.
 */
export async function recordRestored(
  deps: CheckpointDeps,
  designId: string,
  report: RestoredReport,
): Promise<void> {
  const sandbox = await getSandbox(deps.db, designId);
  const fields = {
    designId,
    sessionId: sandbox?.sessionId ?? null,
    image: sandbox?.image ?? null,
    sandboxState: sandbox?.state ?? null,
    diskTurn: report.disk?.turn ?? null,
    diskSavedAt: report.disk?.at ?? null,
    diskBootId: report.disk?.bootId ?? null,
    savedTurn: report.saved.turn,
    savedAt: report.saved.at,
    bootId: report.bootId,
    bootAt: report.bootAt,
    restoredSession: report.restored.session,
    restoredWorkspace: report.restored.workspace,
  };
  if (report.kind === "rollback") deps.log.warn("sandbox_rollback", fields);
  else deps.log.info("sandbox_rebuilt", fields);
}
