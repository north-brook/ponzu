import {
  advancePreviewSeq,
  completeUpload,
  createUploads,
  getUploads,
  newId,
  randomString,
  type Upload,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { checkUpload, type Declared, PRIVATE_PURPOSES, type UploadKind } from "./files.ts";

/*
 * Uploads (docs/cloud.md, "The runner protocol", "Uploads"): bytes go straight to storage at an
 * address signed for exactly them, never through a function, and nothing is recorded until the
 * uploader says they are there and storage agrees. The runner uploads assets, exports and
 * previews; a person uploads images to a design they can write to.
 */

type UploadDeps = Pick<Deps, "db" | "storage" | "archives" | "clock" | "config" | "background">;

/** How long a signed address takes its bytes. */
export const UPLOAD_SECONDS = 600;

export interface UploadTarget {
  designId: string;
  assetKey: string;
}

export interface Presigned {
  id: string;
  put: { url: string; headers: Record<string, string> };
  expiresAt: string;
}

/**
 * Check each file and hand back where to put it: every file is checked before any address is
 * made, so a refusal leaves nothing behind. `userId` is the person uploading; null for the
 * runner. A person's image is kept under its own name with a few random characters added, so
 * it never replaces a file the design already has; a comment's picture under its comment's
 * message id (`comment`) as well, so each try at one is a file of its own.
 */
export async function presignUploads(
  deps: UploadDeps,
  target: UploadTarget,
  files: (Declared & { kind: UploadKind; comment?: string })[],
  userId: string | null,
): Promise<Presigned[]> {
  const checked = files.map((file) => ({ file, stored: checkUpload(file.kind, file) }));
  const expiresAt = new Date(deps.clock.now() + UPLOAD_SECONDS * 1000);
  const rows = checked.map(({ file, stored }) => {
    const id = newId("up");
    const name =
      file.kind === "image"
        ? uniqueName(file.name)
        : file.kind === "comment"
          ? uniqueName(`${file.comment}-${file.name}`)
          : file.name;
    const purpose = file.kind === "image" ? "asset" : file.kind;
    return {
      row: {
        id,
        designId: target.designId,
        purpose,
        name,
        objectKey: uploadKey(target.assetKey, purpose, id, name),
        contentType: stored.contentType,
        size: stored.size,
        sha256: stored.sha256,
        userId,
        expiresAt,
      } as const,
      stored,
    };
  });
  const signed = await Promise.all(
    rows.map(({ row, stored }) =>
      storeFor(deps, row.purpose).presignPut(row.objectKey, stored, UPLOAD_SECONDS),
    ),
  );
  await createUploads(
    deps.db,
    rows.map(({ row }) => row),
  );
  return rows.map(({ row }, index) => ({
    id: row.id,
    put: signed[index]!,
    expiresAt: expiresAt.toISOString(),
  }));
}

export interface Completed {
  id: string;
  /**
   * An asset's reference, `assets/<name>`, or a comment's picture's, `comments/<name>`, under
   * the design's assets address; null for the rest.
   */
  ref: string | null;
  url: string;
}

/**
 * Record the files whose bytes have arrived: an asset in the design's files, an export as a
 * link, previews as the design's pictures of `previewSeq`. Each must be an upload of the
 * design by the same uploader (`userId`, null for the runner) and be in storage as declared,
 * or the whole call is 404 `not_found` and records nothing more. Completing one again answers
 * as the first time did.
 */
export async function completeUploads(
  deps: UploadDeps,
  target: UploadTarget & { seq: number },
  ids: string[],
  { userId, previewSeq }: { userId: string | null; previewSeq?: number },
): Promise<Completed[]> {
  const wanted = [...new Set(ids)];
  const found = await getUploads(deps.db, { designId: target.designId, ids: wanted });
  const rows = found.filter((row) => row.userId === userId);
  const notArrived = new ApiError(404, "not_found", "Those bytes never arrived.");
  if (rows.length !== wanted.length) throw notArrived;
  if (rows.some((row) => PRIVATE_PURPOSES.includes(row.purpose))) {
    // Completing one would answer an address on the public assets domain.
    throw new ApiError(
      400,
      "invalid_request",
      "A checkpoint's archives are recorded by the checkpoint.",
    );
  }
  const previews = rows.filter((row) => row.purpose === "preview");
  if (previews.length > 0 && (previewSeq === undefined || previewSeq > target.seq)) {
    throw new ApiError(
      400,
      "invalid_request",
      "Previews are completed with the design's seq they show, which it has reached.",
    );
  }
  // Each is checked before any is recorded.
  const arrived = await Promise.all(
    rows.map(async (row) => {
      if (row.completedAt) return true;
      const head = await deps.storage.head(row.objectKey);
      // An object storage holds without the declared checksum is not the upload.
      return head !== null && head.size === row.size && head.sha256 === row.sha256;
    }),
  );
  if (arrived.includes(false)) throw notArrived;

  const served = await Promise.all(
    rows.map(async (row) => {
      if (row.servedKey) return row.servedKey;
      const key =
        row.purpose === "preview"
          ? `${target.assetKey}/${previewPath(previewSeq!, row.name)}`
          : row.purpose === "comment"
            ? `${target.assetKey}/${commentRef(row.name)}`
            : row.objectKey;
      if (key !== row.objectKey) await deps.storage.copy(row.objectKey, key);
      const asset = row.purpose === "asset" ? { path: assetRef(row.name) } : undefined;
      await completeUpload(deps.db, {
        designId: target.designId,
        id: row.id,
        servedKey: key,
        asset,
      });
      return key;
    }),
  );
  if (previews.length > 0) await showPreviews(deps, target, previews, previewSeq!);
  const comments = rows.filter((row) => row.purpose === "comment" && !row.servedKey);
  if (comments.length > 0) {
    // Copied to where they are served from; the staged copies are no longer anyone's.
    deps.background(
      "comment_pictures_staged_cleared",
      Promise.all(comments.map((row) => deps.storage.delete(row.objectKey))),
    );
  }

  const byId = new Map(rows.map((row, index) => [row.id, { row, key: served[index]! }]));
  return ids.map((id) => {
    const { row, key } = byId.get(id)!;
    return {
      id,
      ref:
        row.purpose === "asset"
          ? assetRef(row.name)
          : row.purpose === "comment"
            ? commentRef(row.name)
            : null,
      url: `${deps.config.assetsUrl}/${key}`,
    };
  });
}

/**
 * Make `seq`'s previews the design's, unless it shows later ones, and clear away what is no
 * longer served: the uploaded copies, and the previews these replaced.
 */
async function showPreviews(
  deps: UploadDeps,
  target: UploadTarget,
  previews: Upload[],
  seq: number,
) {
  const moved = await advancePreviewSeq(deps.db, { designId: target.designId, seq });
  const stale = previews.map((row) => row.objectKey);
  // Previews only move forward, so the ones replaced are always of an earlier seq.
  const previous = moved?.previous;
  if (typeof previous === "number") {
    for (const name of ["light.png", "dark.png"]) {
      stale.push(`${target.assetKey}/${previewPath(previous, name)}`);
    }
  }
  deps.background("previews_cleared", Promise.all(stale.map((key) => deps.storage.delete(key))));
}

export const assetRef = (name: string) => `assets/${name}`;
export const commentRef = (name: string) => `comments/${name}`;

/**
 * Where an upload's bytes go. An asset and an export go where they are served from. A preview's
 * place depends on the seq it is completed with, and a comment's picture is asked for before its
 * comment is saved (which may never happen: refused, undone, the app closed), so both wait under
 * `staging/`, apart from every design's files (where a bucket lifecycle rule clears what is
 * never completed), and are copied into place when completed.
 */
function uploadKey(assetKey: string, purpose: Upload["purpose"], id: string, name: string): string {
  if (purpose === "asset") return `${assetKey}/${assetRef(name)}`;
  if (purpose === "export") return `${assetKey}/exports/${id}-${name}`;
  if (purpose === "session" || purpose === "workspace")
    return `${PRIVATE}/${randomString(32)}/${id}-${name}`;
  return `${STAGING}/${id}-${name}`;
}

/** The store an upload of `purpose` is kept in: a checkpoint's archives have their own. */
export function storeFor(deps: Pick<Deps, "storage" | "archives">, purpose: Upload["purpose"]) {
  return PRIVATE_PURPOSES.includes(purpose) ? deps.archives : deps.storage;
}

/**
 * Where a checkpoint's archives go (a session's transcript holds the whole conversation and every
 * tool's output): at the bucket's root, never under a design's asset key, which people hold, and
 * each under 32 random characters of its own that no answer to any client carries. The assets
 * domain serves any key it is asked for, so the key is the only thing between it and the world;
 * a bucket with no public domain at all is the better home (docs/cloud.md, "Saving the
 * sandbox").
 */
export const PRIVATE = "private";

/** Where uploads wait that are not yet where they are served from. */
export const STAGING = "staging";

/** `previews/<seq>-light.png`, from the preview's name `light.png`. */
export const previewPath = (seq: number, name: string) => `previews/${seq}-${name}`;

/** `paste.png` as `paste-k3v9qz.png`. */
function uniqueName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${name.slice(0, dot).slice(0, 120)}-${randomString(6)}${name.slice(dot)}`;
}
