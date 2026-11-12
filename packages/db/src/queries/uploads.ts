import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { assets, canvases, canvasRunners, uploads } from "../schema/index.ts";
import { run } from "./run.ts";

/*
 * Uploads (docs/cloud.md, "Assets and previews"): the bytes go straight to storage at a signed
 * address, and these rows remember what each address was for until the uploader says the bytes
 * are there.
 */

export type Upload = typeof uploads.$inferSelect;
export type NewUpload = Omit<
  typeof uploads.$inferInsert,
  "servedKey" | "completedAt" | "createdAt"
>;
export type Asset = typeof assets.$inferSelect;

/** Remember the uploads that signed addresses were just made for. */
export function createUploads(db: Db, rows: NewUpload[]): Promise<Upload[]> {
  if (rows.length === 0) return Promise.resolve([]);
  return run(db.insert(uploads).values(rows).returning());
}

/** A canvas's uploads with these ids. Another canvas's are not found. */
export function getUploads(
  db: Db,
  { canvasId, ids }: { canvasId: string; ids: string[] },
): Promise<Upload[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return run(
    db
      .select()
      .from(uploads)
      .where(and(eq(uploads.canvasId, canvasId), inArray(uploads.id, ids))),
  );
}

/**
 * Where every upload of these purposes of the canvas's is stored, recorded by a checkpoint or
 * not: what to delete with the canvas (a checkpoint's archives, `session` and `workspace`).
 */
export async function listUploadKeys(
  db: Db,
  { canvasId, purposes }: { canvasId: string; purposes: Upload["purpose"][] },
): Promise<string[]> {
  if (purposes.length === 0) return [];
  const rows = await run(
    db
      .select({ key: uploads.objectKey })
      .from(uploads)
      .where(and(eq(uploads.canvasId, canvasId), inArray(uploads.purpose, purposes))),
  );
  return rows.map((row) => row.key);
}

/**
 * Which of `keys` hold an archive that a canvas's checkpoint records now: the transcript or the
 * work in progress its runner row names (docs/cloud.md, "Saving the sandbox"). Every other
 * archive is one a later checkpoint replaced, one whose checkpoint call never came, or one of a
 * deleted canvas, and the orphan archive sweep deletes it once it is a day old.
 */
export async function recordedArchiveKeys(db: Db, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await run(
    db
      .select({ key: uploads.objectKey })
      .from(canvasRunners)
      .innerJoin(
        uploads,
        and(
          eq(uploads.canvasId, canvasRunners.canvasId),
          or(
            eq(uploads.id, canvasRunners.sessionUploadId),
            eq(uploads.id, canvasRunners.workspaceUploadId),
          ),
        ),
      )
      .where(inArray(uploads.objectKey, [...keys])),
  );
  return new Set(rows.map((row) => row.key));
}

/**
 * Record that an upload's bytes are where they are served from (`servedKey`), and when it is
 * one of the canvas's files, record the file under `asset` in `assets` in the same statement,
 * replacing one of that path. Null when the upload is not this canvas's or is completed
 * already: the first completion is the one that counts.
 */
export async function completeUpload(
  db: Db,
  {
    canvasId,
    id,
    servedKey,
    asset,
  }: { canvasId: string; id: string; servedKey: string; asset?: { path: string } },
): Promise<Upload | null> {
  const completed = db.$with("completed").as(
    db
      .update(uploads)
      .set({ servedKey, completedAt: sql`now()` })
      .where(and(eq(uploads.canvasId, canvasId), eq(uploads.id, id), isNull(uploads.completedAt)))
      .returning(),
  );
  if (!asset) {
    const [row] = await run(db.with(completed).select().from(completed));
    return row ?? null;
  }
  const kept = db.$with("kept", { path: assets.path }).as(sql`
    insert into ${assets} (canvas_id, path, content_type, size, sha256, created_by_user_id)
    select canvas_id, ${asset.path}, content_type, size, sha256, user_id from ${completed}
    on conflict (canvas_id, path) do update
       set content_type = excluded.content_type,
           size = excluded.size,
           sha256 = excluded.sha256,
           created_by_user_id = excluded.created_by_user_id,
           created_at = now()
    returning path
  `);
  const [row] = await run(db.with(completed, kept).select().from(completed));
  return row ?? null;
}

/**
 * Move the canvas's previews on to the ones that show `seq`, unless it already shows a later
 * one. Answers the seq the previews showed before, so the caller can drop those files, or
 * undefined when nothing moved.
 */
export async function advancePreviewSeq(
  db: Db,
  { canvasId, seq }: { canvasId: string; seq: number },
): Promise<{ previous: number | null } | undefined> {
  // `from` the same row under another name reads it as it was before the update.
  const before = db
    .$with("before")
    .as(
      db
        .select({ id: canvases.id, previewSeq: canvases.previewSeq })
        .from(canvases)
        .where(eq(canvases.id, canvasId))
        .for("update"),
    );
  const [row] = await run(
    db
      .with(before)
      .update(canvases)
      .set({ previewSeq: seq })
      .from(before)
      .where(
        and(
          eq(canvases.id, before.id),
          or(isNull(canvases.previewSeq), sql`${canvases.previewSeq} < ${seq}`),
        ),
      )
      .returning({ previous: before.previewSeq }),
  );
  return row;
}

/** Which of these paths are files of the canvas, as markup references them (`assets/…`). */
export function listAssets(
  db: Db,
  { canvasId, paths }: { canvasId: string; paths: string[] },
): Promise<Asset[]> {
  if (paths.length === 0) return Promise.resolve([]);
  return run(
    db
      .select()
      .from(assets)
      .where(and(eq(assets.canvasId, canvasId), inArray(assets.path, paths))),
  );
}
