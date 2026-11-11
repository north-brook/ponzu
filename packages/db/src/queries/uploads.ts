import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { assets, designs, uploads } from "../schema/index.ts";
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

/** A design's uploads with these ids. Another design's are not found. */
export function getUploads(
  db: Db,
  { designId, ids }: { designId: string; ids: string[] },
): Promise<Upload[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return run(
    db
      .select()
      .from(uploads)
      .where(and(eq(uploads.designId, designId), inArray(uploads.id, ids))),
  );
}

/**
 * Record that an upload's bytes are where they are served from (`servedKey`), and when it is
 * one of the design's files, record the file under `asset` in `assets` in the same statement,
 * replacing one of that path. Null when the upload is not this design's or is completed
 * already: the first completion is the one that counts.
 */
export async function completeUpload(
  db: Db,
  {
    designId,
    id,
    servedKey,
    asset,
  }: { designId: string; id: string; servedKey: string; asset?: { path: string } },
): Promise<Upload | null> {
  const completed = db.$with("completed").as(
    db
      .update(uploads)
      .set({ servedKey, completedAt: sql`now()` })
      .where(and(eq(uploads.designId, designId), eq(uploads.id, id), isNull(uploads.completedAt)))
      .returning(),
  );
  if (!asset) {
    const [row] = await run(db.with(completed).select().from(completed));
    return row ?? null;
  }
  const kept = db.$with("kept", { path: assets.path }).as(sql`
    insert into ${assets} (design_id, path, content_type, size, sha256, created_by_user_id)
    select design_id, ${asset.path}, content_type, size, sha256, user_id from ${completed}
    on conflict (design_id, path) do update
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
 * Move the design's previews on to the ones that show `seq`, unless it already shows a later
 * one. Answers the seq the previews showed before, so the caller can drop those files, or
 * undefined when nothing moved.
 */
export async function advancePreviewSeq(
  db: Db,
  { designId, seq }: { designId: string; seq: number },
): Promise<{ previous: number | null } | undefined> {
  // `from` the same row under another name reads it as it was before the update.
  const before = db
    .$with("before")
    .as(
      db
        .select({ id: designs.id, previewSeq: designs.previewSeq })
        .from(designs)
        .where(eq(designs.id, designId))
        .for("update"),
    );
  const [row] = await run(
    db
      .with(before)
      .update(designs)
      .set({ previewSeq: seq })
      .from(before)
      .where(
        and(
          eq(designs.id, before.id),
          or(isNull(designs.previewSeq), sql`${designs.previewSeq} < ${seq}`),
        ),
      )
      .returning({ previous: before.previewSeq }),
  );
  return row;
}

/** Which of these paths are files of the design, as markup references them (`assets/…`). */
export function listAssets(
  db: Db,
  { designId, paths }: { designId: string; paths: string[] },
): Promise<Asset[]> {
  if (paths.length === 0) return Promise.resolve([]);
  return run(
    db
      .select()
      .from(assets)
      .where(and(eq(assets.designId, designId), inArray(assets.path, paths))),
  );
}
