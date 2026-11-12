import type { UploadPurpose } from "@ponzu/db";
import {
  ARCHIVE_TYPE,
  MAX_SESSION_BYTES,
  MAX_WORKSPACE_BYTES,
  SESSION_ARCHIVE,
  WORKSPACE_ARCHIVE,
} from "@ponzu/runner/protocol";
import type { StoredObject } from "../deps/storage.ts";
import { ApiError } from "../http/errors.ts";

/*
 * What may be uploaded, where it goes, and how it is served (docs/cloud.md, "Assets and
 * previews"). Everything is served from the assets domain, `ponzu.cloud`, which shares no origin
 * or cookie with `ponzu.design`, at `<assets url>/<asset key>/…`:
 *
 *   assets/<name>               a canvas's file, as markup references it (`assets/<name>`)
 *   previews/<seq>-<theme>.png  the sidebar's picture of the canvas at `seq`
 *   exports/<upload id>-<name>  a file a link reaches
 *   comments/<message id>-<theme>-<random>.webp
 *                               the picture of where a comment was left, as the thread shows it
 *
 * An SVG is the one kind that can run script when a browser opens it by itself, so it is stored
 * `Content-Disposition: attachment`: opened directly, the browser saves it instead of rendering
 * it on the assets origin, and as an `<img>` or a CSS `url()` it draws as ever (an image runs no
 * script). Object storage cannot attach a Content-Security-Policy to an object, and the domain
 * holds nothing else to steal; the disposition is what stops the script.
 */

/** A file name as markup and links carry it: one plain name, with its extension. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const MB = 1024 * 1024;

/** The kinds of file a canvas can hold as an asset, by extension: what `add_asset` takes. */
const ASSET_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** What a person may upload to a canvas: images, for attachments and pasted pictures. */
const IMAGE_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_TYPES).filter(([, type]) => type.startsWith("image/")),
);

/** What `export` writes. */
const EXPORT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};

/**
 * Who is uploading what: a runner for any purpose but a comment's picture, a person images for
 * the canvas and the pictures of their comments.
 */
export type UploadKind = UploadPurpose | "image";

/** A comment's picture is two files, one for each theme. */
export const COMMENT_PICTURE_NAMES = ["light.webp", "dark.webp"];

interface Rule {
  types: Record<string, string>;
  maxBytes: number;
  /** A file's name must be one of these, when given. */
  names?: string[];
}

const RULES: Record<UploadKind, Rule> = {
  asset: { types: ASSET_TYPES, maxBytes: 20 * MB },
  image: { types: IMAGE_TYPES, maxBytes: 20 * MB },
  export: { types: EXPORT_TYPES, maxBytes: 50 * MB },
  preview: { types: { png: "image/png" }, maxBytes: 5 * MB, names: ["light.png", "dark.png"] },
  // A person's picture of where they left a comment, in each theme: a few hundred px a side.
  comment: { types: { webp: "image/webp" }, maxBytes: 2 * MB, names: COMMENT_PICTURE_NAMES },
  // A checkpoint's archives (docs/cloud.md, "Saving the sandbox"): never served to anyone.
  session: {
    types: { gz: ARCHIVE_TYPE },
    maxBytes: MAX_SESSION_BYTES,
    names: [SESSION_ARCHIVE],
  },
  workspace: {
    types: { gz: ARCHIVE_TYPE },
    maxBytes: MAX_WORKSPACE_BYTES,
    names: [WORKSPACE_ARCHIVE],
  },
};

/** Purposes whose bytes no client may ever read: stored apart, and recorded by a checkpoint. */
export const PRIVATE_PURPOSES: readonly UploadKind[] = ["session", "workspace"];

/** Names reused for new bytes (an asset) may be cached briefly; the rest never change. */
const CHANGEABLE = "public, max-age=300";
const IMMUTABLE = "public, max-age=31536000, immutable";

export interface Declared {
  name: string;
  contentType: string;
  size: number;
  sha256: string;
}

/**
 * The file as it will be stored, or the error that says why it may not be: a name that is not
 * one plain file name, a kind this place does not take or whose name and type disagree, or a
 * size past what it allows.
 */
export function checkUpload(kind: UploadKind, file: Declared): StoredObject {
  const rule = RULES[kind];
  const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
  if (!NAME.test(file.name) || (rule.names && !rule.names.includes(file.name))) {
    throw new ApiError(
      400,
      "invalid_request",
      rule.names
        ? `A ${kind} is named ${rule.names.join(" or ")}.`
        : `"${file.name}" can't be a file's name. Use letters, numbers, dots, dashes and underscores, with its extension.`,
    );
  }
  const type = rule.types[extension];
  if (type === undefined) {
    throw new ApiError(
      415,
      "unsupported_file_type",
      `A .${extension} file can't go here. These can: ${Object.keys(rule.types).join(", ")}.`,
    );
  }
  if (file.contentType.toLowerCase() !== type) {
    throw new ApiError(415, "unsupported_file_type", `A .${extension} file is ${type}.`);
  }
  if (file.size > rule.maxBytes) {
    throw new ApiError(
      413,
      "file_too_large",
      `${file.name} is larger than the ${rule.maxBytes / MB} MB this kind of file may be.`,
      { details: { maxBytes: rule.maxBytes } },
    );
  }
  return {
    contentType: type,
    size: file.size,
    sha256: file.sha256,
    cacheControl: PRIVATE_PURPOSES.includes(kind)
      ? "private, no-store"
      : kind === "asset" || kind === "image"
        ? CHANGEABLE
        : IMMUTABLE,
    ...(type === "image/svg+xml" ? { contentDisposition: "attachment" } : {}),
  };
}
