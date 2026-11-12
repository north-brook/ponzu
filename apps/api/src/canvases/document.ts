import { applyOp, type Doc } from "@ponzu/core";
import { readDocSource, readOps, type StoredOp, writeCheckpoint } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import type { CachedDoc } from "./doc-cache.ts";

/*
 * A canvas's current document: its latest checkpoint plus the ops after it (docs/cloud.md,
 * "Reading"), kept per function instance in `deps.docs` so most requests read only the ops
 * since the last one they saw.
 */

type DocDeps = Pick<Deps, "db" | "docs" | "background">;

/** A checkpoint is written once this many ops, or this many bytes of them, have been committed since the last. */
export const CHECKPOINT_EVERY_OPS = 64;
export const CHECKPOINT_EVERY_BYTES = 256 * 1024;

/** Catching a cached document up reads at most this many ops; further behind, it is rebuilt. */
const CATCH_UP_LIMIT = 500;

/**
 * The canvas's document as of its latest seq, or null when there is no such canvas. The doc
 * is the cache's: copy it before changing it.
 */
export async function readCurrentDoc(deps: DocDeps, canvasId: string): Promise<CachedDoc | null> {
  const cached = deps.docs.get(canvasId);
  if (cached) {
    const read = await readOps(deps.db, { canvasId, after: cached.seq, limit: CATCH_UP_LIMIT });
    if (!read) {
      deps.docs.delete(canvasId);
      return null;
    }
    // Pruned past where the cache is, or more than one read behind: start from the checkpoint.
    const whole = read.kind === "ok" && read.ops.length === read.seq - cached.seq;
    if (whole && read.ops.length === 0) return cached;
    if (whole) {
      const doc = structuredClone(cached.doc);
      for (const stored of read.ops) applyOp(doc, stored.op);
      return keep(deps, canvasId, cached, { seq: read.seq, doc, ops: read.ops });
    }
  }
  const source = await readDocSource(deps.db, canvasId);
  if (!source) return null;
  const { doc } = source.checkpoint;
  for (const stored of source.ops) applyOp(doc, stored.op);
  return keep(
    deps,
    canvasId,
    { seq: source.checkpoint.seq, doc, sinceCheckpoint: { ops: 0, bytes: 0 } },
    { seq: source.seq, doc, ops: source.ops },
  );
}

/**
 * Keep the document `ops` brought `from` to, as of `seq`, and write a checkpoint after the
 * response when enough has been committed since the last one. `doc` becomes the cache's.
 */
export function keep(
  deps: DocDeps,
  canvasId: string,
  from: CachedDoc,
  { seq, doc, ops }: { seq: number; doc: Doc; ops: StoredOp[] },
): CachedDoc {
  const bytes = ops.reduce((sum, stored) => sum + Buffer.byteLength(JSON.stringify(stored.op)), 0);
  const since = {
    ops: from.sinceCheckpoint.ops + ops.length,
    bytes: from.sinceCheckpoint.bytes + bytes,
  };
  const due = since.ops >= CHECKPOINT_EVERY_OPS || since.bytes >= CHECKPOINT_EVERY_BYTES;
  const entry: CachedDoc = { seq, doc, sinceCheckpoint: due ? { ops: 0, bytes: 0 } : since };
  deps.docs.set(canvasId, entry);
  if (due) {
    // Another instance may have written one meanwhile; then this one is either newer or not
    // written at all, and nothing is lost either way.
    deps.background("checkpoint", writeCheckpoint(deps.db, { canvasId, seq, doc }));
  }
  return entry;
}
