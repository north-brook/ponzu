import type { Clock } from "@ponzu/sandbox";
import { UpstreamError } from "../http/errors.ts";
import type { Fetch } from "./fetch.ts";
import { type Credentials, encodePath, presign, signHeaders } from "./sigv4.ts";

/**
 * Where bytes live: a design's assets, previews and exports, in Cloudflare R2 under the design's
 * asset key (docs/cloud.md, "Assets and previews"). Bytes never pass through the API: an
 * uploader is handed an address that takes exactly the bytes it declared, and the API looks
 * at what arrived before it records anything.
 */
export interface ObjectStorage {
  /**
   * An address that takes one PUT of exactly these bytes to `key` for `expiresIn` seconds. The
   * uploader sends `headers` as they are, and no `Authorization`; storage refuses anything
   * else: another type, size or SHA-256, or a missing header.
   */
  presignPut(key: string, object: StoredObject, expiresIn: number): Promise<PresignedPut>;
  /** What is at `key`, or null when nothing is. */
  head(key: string): Promise<StoredHead | null>;
  /** Puts a copy of `from` at `to`, with the headers `from` was stored with. */
  copy(from: string, to: string): Promise<void>;
  /** Removes `key`. Nothing there is fine. */
  delete(key: string): Promise<void>;
}

/** What an upload must be, and the headers it is served with afterwards. */
export interface StoredObject {
  contentType: string;
  size: number;
  /** Hex. */
  sha256: string;
  cacheControl: string;
  /** `attachment` makes a browser that opens the address save the file rather than show it. */
  contentDisposition?: string;
}

/** What storage says of an object it holds. */
export interface StoredHead {
  size: number;
  contentType: string | null;
  /** Hex, as the upload declared it and storage checked it. Null when it was stored without. */
  sha256: string | null;
}

export interface PresignedPut {
  url: string;
  /** Exactly these, with the bytes. `Content-Length` is signed too, and the client sets it. */
  headers: Record<string, string>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const TIMEOUT_MS = 10_000;

/** `ObjectStorage` on R2's S3 API, signed with SigV4. */
export function createR2Storage({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  fetch,
  clock,
}: R2Config & { fetch: Fetch; clock: Clock }): ObjectStorage {
  const credentials: Credentials = { accessKeyId, secretAccessKey, region: "auto" };
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const objectPath = (key: string) => `/${bucket}/${encodePath(key)}`;
  const urlOf = (key: string) => new URL(objectPath(key), endpoint);

  async function call(method: string, key: string, headers: Record<string, string> = {}) {
    const url = urlOf(key);
    const signed = await signHeaders(credentials, { method, url, headers, now: clock.now() });
    try {
      return await fetch(url.toString(), {
        method,
        headers: signed,
        signal: clock.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new UpstreamError("storage", `${method} an object did not answer`, { cause });
    }
  }

  function refused(method: string, response: Response): UpstreamError {
    return new UpstreamError("storage", `${method} an object answered ${response.status}`, {
      status: response.status,
    });
  }

  return {
    async presignPut(key, object, expiresIn) {
      const headers = uploadHeaders(object);
      const url = await presign(credentials, {
        method: "PUT",
        url: urlOf(key),
        headers: { ...headers, "content-length": String(object.size) },
        now: clock.now(),
        expiresIn,
      });
      return { url: url.toString(), headers };
    },

    async head(key) {
      const response = await call("HEAD", key, {
        // Without this a text type (an SVG) comes back as if compressed, with no length.
        "accept-encoding": "identity",
        // S3 sends the checksum only when asked. (R2 sends it either way, as of November 2026.)
        "x-amz-checksum-mode": "ENABLED",
      });
      if (response.status === 404) return null;
      if (!response.ok) throw refused("HEAD", response);
      const checksum = response.headers.get("x-amz-checksum-sha256");
      return {
        size: Number(response.headers.get("content-length")),
        contentType: response.headers.get("content-type"),
        sha256: checksum ? Buffer.from(checksum, "base64").toString("hex") : null,
      };
    },

    async copy(from, to) {
      const response = await call("PUT", to, { "x-amz-copy-source": objectPath(from) });
      await response.body?.cancel();
      if (!response.ok) throw refused("COPY", response);
    },

    async delete(key) {
      const response = await call("DELETE", key);
      if (!response.ok && response.status !== 404) throw refused("DELETE", response);
    },
  };
}

/**
 * The headers an upload is signed with and must carry. The type, the cache rule and the
 * disposition are kept with the object and sent with it whenever it is served. The SHA-256 is
 * checked by storage against the bytes as they arrive.
 */
export function uploadHeaders(object: StoredObject): Record<string, string> {
  return {
    "content-type": object.contentType,
    "cache-control": object.cacheControl,
    "x-amz-checksum-sha256": Buffer.from(object.sha256, "hex").toString("base64"),
    ...(object.contentDisposition ? { "content-disposition": object.contentDisposition } : {}),
  };
}
